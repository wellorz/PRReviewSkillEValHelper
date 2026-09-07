import fs from "node:fs/promises";
import path from "node:path";
import { refreshAzurePullRequestIterationSnapshots } from "../src/lib/azure-devops";
import { getDb } from "../src/lib/db";
import type {
  HumanFinding,
  RepositoryRecord,
} from "../src/lib/types";

async function main() {
  const repositoryId = Number(process.argv[2] ?? 1);
  const concurrency = Math.max(1, Math.min(10, Number(process.argv[3] ?? 4)));
  const requestedNumbers = new Set(
    (process.argv[4] ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger),
  );
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(repositoryId) as RepositoryRecord | undefined;

  if (!repository) {
    throw new Error(`Repository ${repositoryId} was not found`);
  }
  if (repository.provider !== "azure-devops") {
    throw new Error(
      "Iteration snapshot migration currently supports Azure DevOps",
    );
  }
  const azureRepository = repository;

  const allPullRequests = db
    .prepare(`
    SELECT id, number, dataset_path, defect_description
    FROM pull_requests
    WHERE repository_id = ? AND active = 1
    ORDER BY number
  `)
    .all(repositoryId) as Array<{
    id: number;
    number: number;
    dataset_path: string;
    defect_description: string | null;
  }>;
  const pullRequests =
    requestedNumbers.size === 0
      ? allPullRequests
      : allPullRequests.filter((pr) => requestedNumbers.has(pr.number));
  if (pullRequests.length !== requestedNumbers.size && requestedNumbers.size > 0) {
    throw new Error("One or more requested PR numbers are not active");
  }

  let nextIndex = 0;
  let completed = 0;
  const errors: string[] = [];

  async function hasHumanGroundTruth(datasetPath: string) {
    try {
      const findings = JSON.parse(
        await fs.readFile(
          path.join(datasetPath, "human-findings.json"),
          "utf8",
        ),
      ) as HumanFinding[];
      return findings.some((finding) => (finding.scorePoint ?? 1) === 1);
    } catch {
      return false;
    }
  }

  async function migrateNext() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pullRequests.length) return;
      const pr = pullRequests[index];
      try {
        const requireHumanFindings = await hasHumanGroundTruth(pr.dataset_path);
        let saved:
          | Awaited<
              ReturnType<typeof refreshAzurePullRequestIterationSnapshots>
            >
          | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            saved = await refreshAzurePullRequestIterationSnapshots(
              azureRepository,
              pr.number,
              pr.dataset_path,
              requireHumanFindings,
            );
            break;
          } catch (error) {
            lastError = error;
            if (
              attempt === 4 ||
              !/503|temporarily unavailable|rpc failed|remote end hung up/i.test(
                error instanceof Error ? error.message : String(error),
              )
            ) {
              throw error;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, attempt * 5_000),
            );
          }
        }
        if (saved === undefined && lastError) throw lastError;
        if (!saved) {
          throw new Error("No reviewable final or credited iteration snapshot");
        }
        const creditedHumanFindings = saved.findings.filter(
          (finding) => (finding.scorePoint ?? 1) === 1,
        ).length;
        db.prepare(`
        UPDATE pull_requests SET
          base_ref = ?,
          head_ref = ?,
          changed_files = ?,
          valued_comment_count = ?,
          raw_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
          saved.metadata.base.ref,
          saved.metadata.head.ref,
          saved.metadata.changedFiles,
          creditedHumanFindings + (pr.defect_description?.trim() ? 1 : 0),
          JSON.stringify(saved.metadata),
          saved.metadata.updatedAt,
          pr.id,
        );
      } catch (error) {
        errors.push(
          `PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        completed += 1;
        process.stdout.write(
          `\rMigrated ${completed}/${pullRequests.length} PR snapshots`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, pullRequests.length) },
      () => migrateNext(),
    ),
  );
  process.stdout.write("\n");

  if (errors.length > 0) {
    throw new Error(
      `${errors.length} PR snapshot migrations failed:\n${errors.join("\n")}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
