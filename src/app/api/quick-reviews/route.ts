import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const schema = z.object({
  repositoryId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid PR number" }, { status: 400 });
  }
  const db = getDb();
  const repository = db
    .prepare("SELECT id FROM repositories WHERE id = ?")
    .get(parsed.data.repositoryId);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const result = db
    .prepare(
      "INSERT INTO quick_reviews (repository_id, pr_number) VALUES (?, ?)",
    )
    .run(parsed.data.repositoryId, parsed.data.prNumber);
  return NextResponse.json(
    { reviewId: Number(result.lastInsertRowid) },
    { status: 201 },
  );
}
