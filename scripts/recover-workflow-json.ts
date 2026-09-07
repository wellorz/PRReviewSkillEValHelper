import fs from "node:fs/promises";
import path from "node:path";
import { parseReviewOutput } from "../src/lib/copilot";
import { getDb } from "../src/lib/db";
import { loadGroundTruth } from "../src/lib/ground-truth";
import { DATA_DIR } from "../src/lib/paths";
import { jaccard, scoreReviewPair } from "../src/lib/scoring";
import type { ModelFinding } from "../src/lib/types";

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizedFile(value: string | null) {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

function mergeFindings(...groups: ModelFinding[][]) {
  const merged: ModelFinding[] = [];
  for (const finding of groups.flat()) {
    const duplicateIndex = merged.findIndex((candidate) => {
      const sameFile =
        normalizedFile(candidate.file) === normalizedFile(finding.file);
      const candidateLine = candidate.lineStart ?? candidate.lineEnd;
      const findingLine = finding.lineStart ?? finding.lineEnd;
      const nearLine =
        candidateLine == null ||
        findingLine == null ||
        Math.abs(candidateLine - findingLine) <= 3;
      return (
        sameFile &&
        nearLine &&
        jaccard(
          `${candidate.title} ${candidate.description}`,
          `${finding.title} ${finding.description}`,
        ) >= 0.45
      );
    });
    if (duplicateIndex < 0) {
      merged.push(finding);
    } else if (finding.confidence > merged[duplicateIndex].confidence) {
      merged[duplicateIndex] = finding;
    }
  }
  return merged;
}

async function readUsageDuration(filePath: string) {
  try {
    const usage = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      totalApiDurationMs?: unknown;
    };
    return typeof usage.totalApiDurationMs === "number"
      ? usage.totalApiDurationMs
      : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const taskId = Number(argument("task"));
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Pass --task <workflow task id>");
  }
  const db = getDb();
  const task = db
    .prepare(`
      SELECT id, repository_id, kind, pr_ids_json
      FROM workflow_tasks WHERE id = ?
    `)
    .get(taskId) as
    | {
        id: number;
        repository_id: number;
        kind: string;
        pr_ids_json: string;
      }
    | undefined;
  if (!task) throw new Error(`Workflow task ${taskId} was not found`);
  if (task.kind !== "skill_eval") {
    throw new Error(`Workflow task ${taskId} is not a skill_eval task`);
  }
  const ids = JSON.parse(task.pr_ids_json) as number[];
  const placeholders = ids.map(() => "?").join(",");
  const pullRequests = db
    .prepare(`
      SELECT id, number, title, url, dataset_path, defect_description,
        baseline_duration_ms, baseline_findings_json, skill_status
      FROM pull_requests
      WHERE repository_id = ? AND id IN (${placeholders})
    `)
    .all(task.repository_id, ...ids) as Array<{
    id: number;
    number: number;
    title: string;
    url: string;
    dataset_path: string;
    defect_description: string | null;
    baseline_duration_ms: number | null;
    baseline_findings_json: string | null;
    skill_status: string;
  }>;
  const root = path.join(DATA_DIR, "workflow", `task-${taskId}`);
  let recovered = 0;
  const failures: string[] = [];

  for (const pr of pullRequests.filter((item) => item.skill_status === "failed")) {
    try {
      const model1Raw = await fs.readFile(
        path.join(root, `pr-${pr.number}-model1-skill-output.txt`),
        "utf8",
      );
      const model2Raw = await fs.readFile(
        path.join(root, `pr-${pr.number}-model2-skill-output.txt`),
        "utf8",
      );
      const model1 = parseReviewOutput(model1Raw);
      const model2 = parseReviewOutput(model2Raw);
      const findings = mergeFindings(model1.findings, model2.findings);
      const durationMs =
        (await readUsageDuration(
          path.join(root, `pr-${pr.number}-model1-skill-usage.json`),
        )) +
        (await readUsageDuration(
          path.join(root, `pr-${pr.number}-model2-skill-usage.json`),
        ));
      const baselineFindings = pr.baseline_findings_json
        ? (JSON.parse(pr.baseline_findings_json) as ModelFinding[])
        : [];
      const truth = await loadGroundTruth(pr);
      const metrics = scoreReviewPair(
        truth,
        findings,
        baselineFindings,
        durationMs,
        pr.baseline_duration_ms ?? 0,
      );
      const reportPath = path.join(root, `pr-${pr.number}-report.md`);
      const report = `# Recovered Skill Evaluation: PR #${pr.number}

**${pr.title}**

This result was recovered on September 3, 2026 from the preserved Model 1 and
Model 2 output files after JSON parsing failed. No new model call was made.
Because the original failure occurred before orchestration, the two completed
review outputs were deterministically deduplicated.

- Point score: **${metrics.skilled.earnedPoints}/${metrics.skilled.availablePoints}**
- Baseline score: **${metrics.baseline.earnedPoints}/${metrics.baseline.availablePoints}**
- Result: **${metrics.winner}**
- Recovered duration: **${(durationMs / 1000).toFixed(1)}s**

## Recovered findings

${findings.map((finding) => `- **${finding.severity.toUpperCase()} — ${finding.title}** (${finding.file ?? "unknown file"}:${finding.lineStart ?? "?"}) — ${finding.description}`).join("\n") || "_No findings._"}
`;
      await fs.writeFile(reportPath, report);
      db.prepare(`
        UPDATE pull_requests SET
          skill_status = 'completed',
          skill_duration_ms = ?,
          skill_findings_json = ?,
          skill_metrics_json = ?,
          skill_error = NULL,
          skill_completed_at = ?,
          skill_report_path = ?
        WHERE id = ?
      `).run(
        durationMs,
        JSON.stringify(findings),
        JSON.stringify(metrics),
        new Date().toISOString(),
        reportPath,
        pr.id,
      );
      recovered += 1;
    } catch (error) {
      failures.push(
        `PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const remaining = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM pull_requests
      WHERE id IN (${placeholders}) AND skill_status = 'failed'
    `)
    .get(...ids) as { count: number };
  if (remaining.count === 0) {
    db.prepare(`
      UPDATE workflow_tasks SET
        status = 'completed',
        status_message = ?,
        error = NULL,
        completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
    `).run(
      `Complete · recovered ${recovered} preserved JSON outputs`,
      new Date().toISOString(),
      task.id,
    );
  }
  console.log(
    `Recovered ${recovered} result(s) from task ${taskId} without model calls.`,
  );
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
