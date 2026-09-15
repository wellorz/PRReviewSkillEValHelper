import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { rescoreCompletedResults } from "../src/lib/workflow";
import type { ModelFinding } from "../src/lib/types";

type Decision = {
  resultType: "baseline_profile_results" | "personal_skill_results";
  resultId: number;
  humanFindingId: string;
  modelFindingIndex: number | null;
  classification: "same_defect" | "different_defect" | "ambiguous";
};

type Report = {
  decisions: Decision[];
};

async function main() {
  const reportPath = process.argv[2];
  const repositoryId = Number(process.argv[3] ?? 1);
  if (!reportPath) {
    throw new Error("An adjudication report path is required");
  }
  if (!Number.isInteger(repositoryId) || repositoryId < 1) {
    throw new Error("Repository ID must be a positive integer");
  }

  const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Report;
  const actionable = report.decisions.filter(
    (decision) => decision.classification !== "ambiguous",
  );
  const db = new Database("data/benchmark.sqlite");

  const update = db.transaction(() => {
    let applied = 0;
    for (const decision of actionable) {
      if (decision.modelFindingIndex == null) {
        throw new Error(
          `Approved decision for result ${decision.resultId} has no model finding`,
        );
      }
      const table = decision.resultType;
      const row = db
        .prepare(`SELECT status, findings_json FROM ${table} WHERE id = ?`)
        .get(decision.resultId) as
        | { status: string; findings_json: string | null }
        | undefined;
      if (row?.status !== "completed") {
        throw new Error(
          `Result ${table}#${decision.resultId} is ${row?.status ?? "missing"}; only completed results can be adjudicated`,
        );
      }
      if (!row?.findings_json) {
        throw new Error(
          `Result ${table}#${decision.resultId} has no persisted findings`,
        );
      }
      const findings = JSON.parse(row.findings_json) as ModelFinding[];
      const finding = findings[decision.modelFindingIndex];
      if (!finding) {
        throw new Error(
          `Result ${table}#${decision.resultId} has no finding at index ${decision.modelFindingIndex}`,
        );
      }
      if (decision.classification === "same_defect") {
        finding.adjudicatedHumanFindingIds = [
          ...new Set([
            ...(finding.adjudicatedHumanFindingIds ?? []),
            decision.humanFindingId,
          ]),
        ];
        finding.rejectedHumanFindingIds =
          finding.rejectedHumanFindingIds?.filter(
            (id) => id !== decision.humanFindingId,
          );
      } else {
        finding.rejectedHumanFindingIds = [
          ...new Set([
            ...(finding.rejectedHumanFindingIds ?? []),
            decision.humanFindingId,
          ]),
        ];
        finding.adjudicatedHumanFindingIds =
          finding.adjudicatedHumanFindingIds?.filter(
            (id) => id !== decision.humanFindingId,
          );
      }
      db.prepare(`
        UPDATE ${table}
        SET findings_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(findings), decision.resultId);
      applied += 1;
    }
    return applied;
  });

  const applied = update();
  db.close();
  const rescored = await rescoreCompletedResults(repositoryId);
  process.stdout.write(`${JSON.stringify({ applied, rescored })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
