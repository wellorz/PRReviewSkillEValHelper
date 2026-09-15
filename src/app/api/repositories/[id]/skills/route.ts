import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSkillPath } from "@/lib/copilot";
import { validateDevLoopSkillPath } from "@/lib/devloop-review";
import { getDb } from "@/lib/db";
import {
  isNativeWzReviewPath,
  PERSONAL_SKILL_EXECUTION_MODES,
} from "@/lib/personal-skill-execution";
import {
  DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION,
  validatePersonalSkillTriggerInstruction,
} from "@/lib/personal-skill-trigger";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().trim().min(1),
  triggerInstruction: z.string().optional(),
  executionMode: z.enum(PERSONAL_SKILL_EXECUTION_MODES).optional(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const skills = db
    .prepare(
      "SELECT * FROM personal_review_skills WHERE repository_id = ? AND active = 1 ORDER BY name",
    )
    .all(id);
  return NextResponse.json({ skills });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid skill" },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db.prepare("SELECT 1 FROM repositories WHERE id = ?").get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  let resolvedPath: string;
  let triggerInstruction: string;
  let executionMode = parsed.data.executionMode ?? "copilot-skill";
  try {
    resolvedPath = (await validateSkillPath(parsed.data.path)).resolved;
    if (isNativeWzReviewPath(resolvedPath)) {
      executionMode = "copilot-skill";
    }
    if (executionMode === "devloop-local") {
      await validateDevLoopSkillPath(resolvedPath);
    }
    triggerInstruction = validatePersonalSkillTriggerInstruction(
      parsed.data.triggerInstruction ??
        DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  db.prepare(`
    INSERT INTO personal_review_skills (
      repository_id, name, path, trigger_instruction, execution_mode
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, name) DO UPDATE SET
      path = excluded.path,
      execution_mode = excluded.execution_mode,
      trigger_instruction = CASE
        WHEN personal_review_skills.trigger_instruction = ''
          THEN excluded.trigger_instruction
        ELSE personal_review_skills.trigger_instruction
      END,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    id,
    parsed.data.name,
    resolvedPath,
    triggerInstruction,
    executionMode,
  );
  const skill = db
    .prepare(
      "SELECT * FROM personal_review_skills WHERE repository_id = ? AND name = ?",
    )
    .get(id, parsed.data.name);
  return NextResponse.json({ skill }, { status: 201 });
}
