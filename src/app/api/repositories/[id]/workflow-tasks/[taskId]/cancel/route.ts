import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await context.params;
  const db = getDb();
  const task = db
    .prepare(`
      SELECT id, status
      FROM workflow_tasks
      WHERE id = ? AND repository_id = ?
        AND kind IN ('baseline', 'skill_eval')
    `)
    .get(taskId, id) as { id: number; status: string } | undefined;
  if (!task) {
    return NextResponse.json(
      { error: "Active PR review task not found" },
      { status: 404 },
    );
  }
  if (!["queued", "running", "cancelling"].includes(task.status)) {
    return NextResponse.json(
      { error: "This PR review is no longer active" },
      { status: 409 },
    );
  }
  const status = task.status === "queued" ? "cancelled" : "cancelling";
  db.prepare(`
    UPDATE workflow_tasks
    SET status = ?, status_message = ?,
      completed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(
    status,
    status === "cancelled" ? "Cancelled" : "Cancelling PR review",
    status,
    new Date().toISOString(),
    task.id,
  );
  return NextResponse.json({ taskId: task.id, status });
}
