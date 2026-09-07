import { getDb } from "../src/lib/db";
import { executeWorkflowTask } from "../src/lib/workflow";

type WorkflowTask = {
  id: number;
  repository_id: number;
  kind: "manual_pr" | "baseline" | "skill_eval";
  pr_ids_json: string;
  payload_json: string | null;
};

async function main() {
  const taskId = Number(process.argv[2]);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("Provide a positive workflow task ID");
  }
  const db = getDb();
  const task = db
    .prepare(`
      SELECT id, repository_id, kind, pr_ids_json, payload_json
      FROM workflow_tasks
      WHERE id = ?
    `)
    .get(taskId) as WorkflowTask | undefined;
  if (!task) throw new Error(`Workflow task ${taskId} was not found`);
  try {
    await executeWorkflowTask(task);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'failed', status_message = 'Failed', error = ?,
        completed_at = ?
      WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')
    `).run(message, new Date().toISOString(), task.id);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
