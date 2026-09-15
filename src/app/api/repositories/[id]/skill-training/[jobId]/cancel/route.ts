import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id, jobId } = await context.params;
  const db = getDb();
  const job = db
    .prepare(`
      SELECT id, status FROM skill_training_jobs
      WHERE id = ? AND repository_id = ?
    `)
    .get(jobId, id) as { id: number; status: string } | undefined;
  if (!job) {
    return NextResponse.json(
      { error: "Training job not found." },
      { status: 404 },
    );
  }
  if (!["queued", "running", "cancelling"].includes(job.status)) {
    return NextResponse.json(
      { error: "This training job is no longer active." },
      { status: 409 },
    );
  }
  const completedAt = new Date().toISOString();
  const status = job.status === "queued" ? "cancelled" : "cancelling";
  db.transaction(() => {
    db.prepare(`
      UPDATE skill_training_jobs
      SET status = ?, status_message = ?, error = NULL,
        completed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      status === "cancelled" ? "Training cancelled" : "Cancelling training",
      status,
      completedAt,
      job.id,
    );
    db.prepare(`
      UPDATE workflow_tasks
      SET status = CASE
          WHEN status = 'queued' THEN 'cancelled'
          ELSE 'cancelling'
        END,
        status_message = CASE
          WHEN status = 'queued' THEN 'Cancelled'
          ELSE 'Cancelling training review'
        END,
        completed_at = CASE
          WHEN status = 'queued' THEN ?
          ELSE completed_at
        END
      WHERE training_job_id = ?
        AND status IN ('queued', 'running')
    `).run(completedAt, job.id);
    db.prepare(`
      UPDATE skill_analysis_jobs
      SET status = CASE
          WHEN status = 'queued' THEN 'cancelled'
          ELSE 'cancelling'
        END,
        status_message = CASE
          WHEN status = 'queued' THEN 'Cancelled'
          ELSE 'Cancelling training analysis'
        END,
        completed_at = CASE
          WHEN status = 'queued' THEN ?
          ELSE completed_at
        END
      WHERE training_job_id = ?
        AND status IN ('queued', 'running')
    `).run(completedAt, job.id);
  })();
  return NextResponse.json({ jobId: job.id, status });
}
