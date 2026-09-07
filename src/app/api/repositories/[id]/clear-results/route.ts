import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DATA_DIR } from "@/lib/paths";

export const runtime = "nodejs";

function outputPath(value: string) {
  const resolved = path.resolve(value);
  const dataPrefix = `${path.resolve(DATA_DIR)}${path.sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(dataPrefix)) {
    throw new Error(`Review output path is outside the data directory: ${value}`);
  }
  return resolved;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db.prepare("SELECT id FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const activeWorkflow = db
    .prepare(`
      SELECT 1 FROM workflow_tasks
      WHERE repository_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `)
    .get(id);
  const activeAnalysis = db
    .prepare(`
      SELECT 1 FROM skill_analysis_jobs
      WHERE repository_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `)
    .get(id);
  if (activeWorkflow || activeAnalysis) {
    return NextResponse.json(
      { error: "Wait for active review and analysis tasks to finish first." },
      { status: 409 },
    );
  }
  const taskIds = db
    .prepare(`
      SELECT id FROM workflow_tasks
      WHERE repository_id = ? AND kind IN ('baseline', 'skill_eval')
    `)
    .all(id) as Array<{ id: number }>;
  const analysisJobIds = db
    .prepare("SELECT id FROM skill_analysis_jobs WHERE repository_id = ?")
    .all(id) as Array<{ id: number }>;
  const profileIds = db
    .prepare("SELECT id FROM baseline_profiles WHERE repository_id = ?")
    .all(id) as Array<{ id: number }>;
  const reportPaths = db
    .prepare(`
      SELECT result.report_path
      FROM personal_skill_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      WHERE skill.repository_id = ? AND result.report_path IS NOT NULL
    `)
    .all(id) as Array<{ report_path: string }>;

  await Promise.all([
    ...taskIds.map((task) =>
      fs.rm(path.join(DATA_DIR, "workflow", `task-${task.id}`), {
        recursive: true,
        force: true,
      }),
    ),
    ...analysisJobIds.map((job) =>
      fs.rm(path.join(DATA_DIR, "skill-analysis", `job-${job.id}`), {
        recursive: true,
        force: true,
      }),
    ),
    ...profileIds.map((profile) =>
      fs.rm(
        path.join(
          DATA_DIR,
          "workflow",
          "comparisons",
          `profile-${profile.id}`,
        ),
        { recursive: true, force: true },
      ),
    ),
    ...reportPaths.map((report) =>
      fs.rm(outputPath(report.report_path), { force: true }),
    ),
  ]);

  const transaction = db.transaction(() => {
    db.prepare(`
      DELETE FROM skill_analysis_results
      WHERE skill_id IN (
        SELECT id FROM personal_review_skills WHERE repository_id = ?
      )
    `).run(id);
    db.prepare("DELETE FROM skill_analysis_jobs WHERE repository_id = ?").run(id);
    db.prepare(`
      DELETE FROM personal_skill_results
      WHERE skill_id IN (
        SELECT id FROM personal_review_skills WHERE repository_id = ?
      )
    `).run(id);
    db.prepare(`
      DELETE FROM baseline_profile_results
      WHERE profile_id IN (
        SELECT id FROM baseline_profiles WHERE repository_id = ?
      )
    `).run(id);
    db.prepare(`
      DELETE FROM workflow_tasks
      WHERE repository_id = ? AND kind IN ('baseline', 'skill_eval')
    `).run(id);
    db.prepare(`
      UPDATE pull_requests SET
        baseline_status = 'pending',
        baseline_duration_ms = NULL,
        baseline_findings_json = NULL,
        baseline_usage_json = NULL,
        baseline_metrics_json = NULL,
        baseline_error = NULL,
        baseline_completed_at = NULL,
        skill_status = 'pending',
        skill_duration_ms = NULL,
        skill_findings_json = NULL,
        skill_metrics_json = NULL,
        skill_error = NULL,
        skill_completed_at = NULL,
        skill_report_path = NULL
      WHERE repository_id = ?
    `).run(id);
  });
  transaction();
  return NextResponse.json({
    ok: true,
    clearedTasks: taskIds.length,
  });
}
