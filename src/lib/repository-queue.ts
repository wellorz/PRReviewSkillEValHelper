import { getDb } from "@/lib/db";

export function repositorySyncQueueMessage(repositoryId: number) {
  const row = getDb()
    .prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM workflow_tasks
          WHERE repository_id = ?
            AND status IN ('queued', 'running')
        ) + (
          SELECT COUNT(*)
          FROM skill_analysis_jobs
          WHERE repository_id = ?
            AND status IN ('queued', 'running')
        ) AS active_jobs
    `)
    .get(repositoryId, repositoryId) as { active_jobs: number };
  if (row.active_jobs === 0) return "Waiting for worker";
  return `Waiting for ${row.active_jobs} active review job${
    row.active_jobs === 1 ? "" : "s"
  } to finish before dataset collection`;
}
