import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const scheduleSchema = z.object({
  repositoryId: z.number().int().positive(),
  intervalMinutes: z.number().int().min(15).max(525_600),
  enabled: z.boolean().default(true),
});

export async function POST(request: Request) {
  const parsed = scheduleSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid schedule" },
      { status: 400 },
    );
  }
  const { repositoryId, intervalMinutes, enabled } = parsed.data;
  const db = getDb();
  const repository = db
    .prepare("SELECT id FROM repositories WHERE id = ?")
    .get(repositoryId);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const nextRun = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  db.prepare(`
    INSERT INTO schedules (repository_id, interval_minutes, enabled, next_run_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET
      interval_minutes = excluded.interval_minutes,
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at
  `).run(repositoryId, intervalMinutes, enabled ? 1 : 0, nextRun);
  return NextResponse.json({ ok: true, nextRun }, { status: 201 });
}
