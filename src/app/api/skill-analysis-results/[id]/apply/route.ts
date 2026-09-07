import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { applySkillAnalysisResult } from "@/lib/skill-analysis";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const result = db
    .prepare(`
      SELECT skill.repository_id
      FROM skill_analysis_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      WHERE result.id = ?
    `)
    .get(id) as { repository_id: number } | undefined;
  if (!result) {
    return NextResponse.json(
      { error: "Skill analysis result not found" },
      { status: 404 },
    );
  }
  const activeEvaluation = db
    .prepare(`
      SELECT 1 FROM workflow_tasks
      WHERE repository_id = ? AND kind = 'skill_eval'
        AND status IN ('queued', 'running')
      LIMIT 1
    `)
    .get(result.repository_id);
  if (activeEvaluation) {
    return NextResponse.json(
      {
        error:
          "Wait for the active skill evaluation to finish before modifying the skill.",
      },
      { status: 409 },
    );
  }
  try {
    await applySkillAnalysisResult(Number(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
