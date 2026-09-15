import { NextResponse } from "next/server";
import { z } from "zod";
import { validateDevLoopSkillPath } from "@/lib/devloop-review";
import { getDb } from "@/lib/db";
import {
  isNativeWzReviewPath,
  PERSONAL_SKILL_EXECUTION_MODES,
} from "@/lib/personal-skill-execution";
import { validatePersonalSkillTriggerInstruction } from "@/lib/personal-skill-trigger";

const updateSchema = z.object({
  triggerInstruction: z.string().optional(),
  executionMode: z.enum(PERSONAL_SKILL_EXECUTION_MODES).optional(),
}).refine(
  (value) =>
    value.triggerInstruction !== undefined || value.executionMode !== undefined,
  { message: "Provide a trigger instruction or execution mode" },
);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; skillId: string }> },
) {
  const { id, skillId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid skill update" },
      { status: 400 },
    );
  }
  let triggerInstruction: string | undefined;
  try {
    triggerInstruction =
      parsed.data.triggerInstruction === undefined
        ? undefined
        : validatePersonalSkillTriggerInstruction(
            parsed.data.triggerInstruction,
          );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const db = getDb();
  const activeTask = db
    .prepare(`
      SELECT 1
      FROM workflow_tasks
      WHERE repository_id = ?
        AND kind = 'skill_eval'
        AND status IN ('queued', 'running', 'cancelling')
      LIMIT 1
    `)
    .get(id);
  const activeAnalysis = db
    .prepare(`
      SELECT 1
      FROM skill_analysis_jobs
      WHERE repository_id = ? AND skill_id = ?
        AND status IN ('queued', 'running')
      LIMIT 1
    `)
    .get(id, skillId);
  if (activeTask || activeAnalysis) {
    return NextResponse.json(
      { error: "Wait for the active skill review or analysis to finish" },
      { status: 409 },
    );
  }

  const existing = db
    .prepare(`
      SELECT path, trigger_instruction, execution_mode
      FROM personal_review_skills
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .get(skillId, id) as
    | {
        path: string;
        trigger_instruction: string;
        execution_mode: string;
      }
    | undefined;
  if (!existing) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  const nextTriggerInstruction =
    triggerInstruction ?? existing.trigger_instruction;
  const nextExecutionMode = isNativeWzReviewPath(existing.path)
    ? "copilot-skill"
    : parsed.data.executionMode ?? existing.execution_mode;
  try {
    if (nextExecutionMode === "devloop-local") {
      await validateDevLoopSkillPath(existing.path);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const transaction = db.transaction(() => {
    const resultsInvalidated =
      existing.trigger_instruction.trim() !== nextTriggerInstruction ||
      existing.execution_mode !== nextExecutionMode;
    const result = db
      .prepare(`
        UPDATE personal_review_skills
        SET trigger_instruction = ?, execution_mode = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND repository_id = ? AND active = 1
      `)
      .run(nextTriggerInstruction, nextExecutionMode, skillId, id);
    if (result.changes === 0) return null;
    if (resultsInvalidated) {
      db.prepare(
        "DELETE FROM skill_analysis_results WHERE skill_id = ?",
      ).run(skillId);
      db.prepare(
        "DELETE FROM personal_skill_results WHERE skill_id = ?",
      ).run(skillId);
    }
    const skill = db
      .prepare(`
        SELECT * FROM personal_review_skills
        WHERE id = ? AND repository_id = ?
      `)
      .get(skillId, id);
    return { skill, resultsInvalidated };
  });
  const result = transaction();
  if (!result) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}

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
