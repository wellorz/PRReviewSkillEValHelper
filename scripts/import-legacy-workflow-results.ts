import fs from "node:fs/promises";
import path from "node:path";
import { validateSkillPath } from "../src/lib/copilot";
import { getDb } from "../src/lib/db";
import { DATA_DIR } from "../src/lib/paths";
import type { RepositoryRecord } from "../src/lib/types";

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonOptional(filePath: string) {
  const value = await readOptional(filePath);
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function main() {
  const taskId = Number(argument("task"));
  const skillName = argument("skill-name")?.trim();
  const configuredSkillPath = argument("skill-path")?.trim();
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Pass --task <workflow task id>");
  }
  if (!skillName || !configuredSkillPath) {
    throw new Error("Pass --skill-name <name> and --skill-path <path>");
  }
  const skillPath = (await validateSkillPath(configuredSkillPath)).resolved;
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
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(task.repository_id) as RepositoryRecord | undefined;
  if (!repository) throw new Error("Task repository was not found");

  db.prepare(`
    INSERT INTO baseline_profiles (
      repository_id, model, context_tier, name
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id, model, context_tier) DO UPDATE SET
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    repository.id,
    repository.model,
    repository.context_tier,
    `Imported legacy ${repository.model}`,
  );
  const profile = db
    .prepare(`
      SELECT id FROM baseline_profiles
      WHERE repository_id = ? AND model = ? AND context_tier = ?
    `)
    .get(repository.id, repository.model, repository.context_tier) as {
    id: number;
  };
  db.prepare(`
    INSERT INTO personal_review_skills (repository_id, name, path)
    VALUES (?, ?, ?)
    ON CONFLICT(repository_id, name) DO UPDATE SET
      path = excluded.path,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(repository.id, skillName, skillPath);
  const skill = db
    .prepare(`
      SELECT id FROM personal_review_skills
      WHERE repository_id = ? AND name = ?
    `)
    .get(repository.id, skillName) as { id: number };

  const ids = JSON.parse(task.pr_ids_json) as number[];
  const placeholders = ids.map(() => "?").join(",");
  const pullRequests = db
    .prepare(`
      SELECT id, number, baseline_status, baseline_duration_ms,
        baseline_findings_json, baseline_usage_json, baseline_metrics_json,
        baseline_error, baseline_completed_at, skill_status, skill_duration_ms,
        skill_findings_json, skill_metrics_json, skill_error,
        skill_completed_at, skill_report_path
      FROM pull_requests
      WHERE repository_id = ? AND id IN (${placeholders})
    `)
    .all(repository.id, ...ids) as Array<Record<string, unknown> & {
    id: number;
    number: number;
  }>;
  const root = path.join(DATA_DIR, "workflow", `task-${taskId}`);
  let baselineCount = 0;
  let skillCount = 0;

  for (const pr of pullRequests) {
    if (pr.baseline_status === "completed") {
      db.prepare(`
        INSERT INTO baseline_profile_results (
          profile_id, pull_request_id, status, duration_ms, findings_json,
          usage_json, metrics_json, error, completed_at
        ) VALUES (?, ?, 'completed', ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(profile_id, pull_request_id) DO UPDATE SET
          status = 'completed',
          duration_ms = excluded.duration_ms,
          findings_json = excluded.findings_json,
          usage_json = excluded.usage_json,
          metrics_json = excluded.metrics_json,
          error = NULL,
          completed_at = excluded.completed_at,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        profile.id,
        pr.id,
        pr.baseline_duration_ms,
        pr.baseline_findings_json,
        pr.baseline_usage_json,
        pr.baseline_metrics_json,
        pr.baseline_completed_at,
      );
      baselineCount += 1;
    }

    const rawOutput = {
      model1: await readOptional(
        path.join(root, `pr-${pr.number}-model1-skill-output.txt`),
      ),
      model2: await readOptional(
        path.join(root, `pr-${pr.number}-model2-skill-output.txt`),
      ),
      orchestration: await readOptional(
        path.join(root, `pr-${pr.number}-orchestration-output.txt`),
      ),
    };
    const usage = {
      model1: await readJsonOptional(
        path.join(root, `pr-${pr.number}-model1-skill-usage.json`),
      ),
      model2: await readJsonOptional(
        path.join(root, `pr-${pr.number}-model2-skill-usage.json`),
      ),
      orchestration: await readJsonOptional(
        path.join(root, `pr-${pr.number}-orchestration-usage.json`),
      ),
    };
    const status =
      pr.skill_status === "completed"
        ? "completed"
        : pr.skill_status === "failed"
          ? "failed"
          : String(pr.skill_status ?? "pending");
    db.prepare(`
      INSERT INTO personal_skill_results (
        skill_id, pull_request_id, baseline_profile_id, model, model_secondary,
        context_tier, status, duration_ms, findings_json, usage_json,
        metrics_json, raw_output_json, error, report_path, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        skill_id, pull_request_id, model, model_secondary, context_tier
      ) DO UPDATE SET
        baseline_profile_id = excluded.baseline_profile_id,
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        findings_json = excluded.findings_json,
        usage_json = excluded.usage_json,
        metrics_json = excluded.metrics_json,
        raw_output_json = excluded.raw_output_json,
        error = excluded.error,
        report_path = excluded.report_path,
        completed_at = excluded.completed_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      skill.id,
      pr.id,
      profile.id,
      repository.model,
      repository.model_secondary,
      repository.context_tier,
      status,
      pr.skill_duration_ms,
      pr.skill_findings_json,
      JSON.stringify(usage),
      pr.skill_metrics_json,
      JSON.stringify(rawOutput),
      pr.skill_error,
      pr.skill_report_path,
      pr.skill_completed_at,
    );
    skillCount += 1;
  }

  console.log(
    `Imported task ${taskId}: ${baselineCount} baseline results and ${skillCount} skill results into "${skillName}".`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
