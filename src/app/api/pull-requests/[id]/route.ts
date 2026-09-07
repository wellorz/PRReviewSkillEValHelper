import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const updateSchema = z.object({
  selected: z.boolean().optional(),
  defectDescription: z.string().max(10_000).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid PR update" }, { status: 400 });
  }
  const db = getDb();
  const pr = db
    .prepare("SELECT id, repository_id FROM pull_requests WHERE id = ?")
    .get(id) as { id: number; repository_id: number } | undefined;
  if (!pr) {
    return NextResponse.json({ error: "PR not found" }, { status: 404 });
  }
  if (parsed.data.selected !== undefined) {
    const activeReview = db
      .prepare(`
        SELECT 1
        FROM workflow_tasks
        WHERE repository_id = ?
          AND kind IN ('baseline', 'skill_eval')
          AND status IN ('queued', 'running', 'cancelling')
        LIMIT 1
      `)
      .get(pr.repository_id);
    if (activeReview) {
      return NextResponse.json(
        {
          error:
            "PR selection is locked until the active review is finished.",
        },
        { status: 409 },
      );
    }
    db.prepare("UPDATE pull_requests SET selected = ? WHERE id = ?").run(
      parsed.data.selected ? 1 : 0,
      id,
    );
  }
  if (parsed.data.defectDescription !== undefined) {
    db.prepare(
      "UPDATE pull_requests SET defect_description = ?, baseline_status = CASE WHEN baseline_status = 'completed' THEN 'stale' ELSE baseline_status END, skill_status = CASE WHEN skill_status = 'completed' THEN 'stale' ELSE skill_status END WHERE id = ?",
    ).run(parsed.data.defectDescription.trim() || null, id);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const result = getDb()
    .prepare(
      "UPDATE pull_requests SET active = 0, selected = 0, excluded_by_user = 1 WHERE id = ?",
    )
    .run(id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "PR not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
