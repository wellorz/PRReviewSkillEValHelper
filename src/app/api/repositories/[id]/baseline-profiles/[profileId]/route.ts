import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id, profileId } = await context.params;
  const db = getDb();
  const result = db
    .prepare(`
      UPDATE baseline_profiles
      SET active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .run(profileId, id);
  if (result.changes === 0) {
    return NextResponse.json(
      { error: "Baseline profile not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
