import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { repositorySyncQueueMessage } from "@/lib/repository-queue";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db
    .prepare("SELECT id, status FROM repositories WHERE id = ?")
    .get(id) as { id: number; status: string } | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  if (repository.status === "syncing") {
    return NextResponse.json(
      { error: "Repository sync is already running" },
      { status: 409 },
    );
  }
  const statusMessage = repositorySyncQueueMessage(repository.id);
  db.prepare(
    "UPDATE repositories SET status = 'queued', status_message = ?, scan_current = 0, scan_total = 0, collected_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(statusMessage, repository.id);
  return NextResponse.json({ ok: true });
}
