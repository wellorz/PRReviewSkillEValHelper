import { getDb } from "../src/lib/db";

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function main() {
  const repositoryId = Number(process.argv[2]);
  const pullRequestIds = (process.argv[3] ?? "")
    .split(",")
    .map(Number)
    .filter(Number.isInteger);
  const skillIds = (process.argv[4] ?? "")
    .split(",")
    .map(Number)
    .filter(Number.isInteger);
  const pathFilter = process.argv[5] ?? "";
  const pollMs = Math.max(2_000, Number(process.argv[6] ?? 5_000));
  if (!repositoryId || pullRequestIds.length === 0 || skillIds.length === 0) {
    throw new Error(
      "Usage: queue-filtered-skills-after-baseline <repository-id> <pr-ids> <skill-ids> <path-filter> [poll-ms]",
    );
  }

  const db = getDb();
  while (true) {
    const repository = db
      .prepare(`
        SELECT model, model_secondary, context_tier, baseline_concurrency,
          local_repo_path, local_repo_branch
        FROM repositories WHERE id = ?
      `)
      .get(repositoryId) as
      | {
          model: string;
          model_secondary: string;
          context_tier: string;
          baseline_concurrency: number;
          local_repo_path: string | null;
          local_repo_branch: string | null;
        }
      | undefined;
    if (!repository?.local_repo_path || !repository.local_repo_branch) {
      throw new Error("Repository review settings are incomplete");
    }
    const profile = db
      .prepare(`
        SELECT id FROM baseline_profiles
        WHERE repository_id = ? AND active = 1 AND model = ?
          AND model_secondary = ? AND context_tier = ?
      `)
      .get(
        repositoryId,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
      ) as { id: number } | undefined;
    if (!profile) throw new Error("Matching baseline profile is unavailable");

    const placeholders = pullRequestIds.map(() => "?").join(",");
    const states = db
      .prepare(`
        SELECT pull_request_id, status
        FROM baseline_profile_results
        WHERE profile_id = ? AND pull_request_id IN (${placeholders})
      `)
      .all(profile.id, ...pullRequestIds) as Array<{
      pull_request_id: number;
      status: string;
    }>;
    const completed = new Set(
      states
        .filter((result) => result.status === "completed")
        .map((result) => result.pull_request_id),
    );
    if (completed.size === pullRequestIds.length) {
      const result = db
        .prepare(`
          INSERT INTO workflow_tasks (
            repository_id, kind, pr_ids_json, payload_json, total_items
          ) VALUES (?, 'skill_eval', ?, ?, ?)
        `)
        .run(
          repositoryId,
          JSON.stringify(pullRequestIds),
          JSON.stringify({
            concurrency: repository.baseline_concurrency,
            skillIds,
            baselineProfileId: profile.id,
            model: repository.model,
            modelSecondary: repository.model_secondary,
            contextTier: repository.context_tier,
            localRepoPath: repository.local_repo_path,
            localRepoBranch: repository.local_repo_branch,
            pathFilter,
          }),
          pullRequestIds.length * skillIds.length,
        );
      process.stdout.write(
        `Queued task ${Number(result.lastInsertRowid)} for ${pullRequestIds.length} PRs and ${skillIds.length} skills\n`,
      );
      return;
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
