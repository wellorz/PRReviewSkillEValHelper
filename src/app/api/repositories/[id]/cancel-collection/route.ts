import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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
  if (!["queued", "syncing", "cancelling"].includes(repository.status)) {
    return NextResponse.json(
      { error: "PR collection is no longer active" },
      { status: 409 },
    );
  }
  const status = repository.status === "queued" ? "cancelled" : "cancelling";
  db.prepare(`
    UPDATE repositories
    SET status = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    status === "cancelled" ? "Collection cancelled" : "Cancelling PR collection",
    repository.id,
  );
  return NextResponse.json({ repositoryId: repository.id, status });
}
