import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const schema = z.object({ value: z.string().trim().min(1) });

function prNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:pull|pullrequest)\/(\d+)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a PR link or number" }, { status: 400 });
  }
  const number = prNumber(parsed.data.value);
  if (!number) {
    return NextResponse.json(
      { error: "The value does not contain a valid PR number" },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db.prepare("SELECT id FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const result = db
    .prepare(
      "INSERT INTO workflow_tasks (repository_id, kind, payload_json, total_items) VALUES (?, 'manual_pr', ?, 1)",
    )
    .run(id, JSON.stringify({ prNumber: number }));
  return NextResponse.json(
    { taskId: Number(result.lastInsertRowid) },
    { status: 201 },
  );
}
