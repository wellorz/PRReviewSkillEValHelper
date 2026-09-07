import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; skillId: string }> },
) {
  const { id, skillId } = await context.params;
  const db = getDb();
  const result = db
    .prepare(`
      UPDATE personal_review_skills
      SET active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .run(skillId, id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
