import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { RepositoryRecord } from "@/lib/types";

const runSchema = z.object({ repositoryId: z.number().int().positive() });

export async function POST(request: Request) {
  const parsed = runSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid repository" }, { status: 400 });
  }
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(parsed.data.repositoryId) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  if (repository.status !== "ready") {
    return NextResponse.json(
      { error: "Sync the repository dataset before starting an evaluation" },
      { status: 409 },
    );
  }
  const active = db
    .prepare(
      "SELECT id FROM runs WHERE repository_id = ? AND status IN ('queued', 'running') LIMIT 1",
    )
    .get(repository.id);
  if (active) {
    return NextResponse.json(
      { error: "An evaluation is already queued or running" },
      { status: 409 },
    );
  }
  const result = db
    .prepare(
      "INSERT INTO runs (repository_id, trigger, model, model_secondary, skill_path) VALUES (?, 'manual', ?, ?, ?)",
    )
    .run(
      repository.id,
      repository.model,
      repository.model_secondary,
      repository.skill_path,
    );
  return NextResponse.json({ runId: Number(result.lastInsertRowid) }, { status: 201 });
}
