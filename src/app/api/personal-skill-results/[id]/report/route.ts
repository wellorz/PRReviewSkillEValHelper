import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { addFindingExecutionContext } from "@/lib/review-output-format";
import type { ModelFinding } from "@/lib/types";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare(`
      SELECT report_path, findings_json, model, model_secondary, context_tier
      FROM personal_skill_results WHERE id = ?
    `)
    .get(id) as
    | {
        report_path: string | null;
        findings_json: string | null;
        model: string;
        model_secondary: string;
        context_tier: string;
      }
    | undefined;
  if (!row?.report_path) {
    return NextResponse.json(
      { error: "Personal skill report not found" },
      { status: 404 },
    );
  }
  try {
    let content = await fs.readFile(row.report_path, "utf8");
    const findings = addFindingExecutionContext(
      JSON.parse(row.findings_json ?? "[]") as ModelFinding[],
      {
        model: row.model,
        modelSecondary: row.model_secondary,
        contextTier: row.context_tier,
      },
    );
    const findingSection =
      findings
        .map(
          (finding) =>
            `- **${finding.severity.toUpperCase()} — ${finding.title}** (${finding.sourceModels?.join(", ") || "unknown model"} · ${finding.contextTier ?? "unknown context"}): ${finding.description}`,
        )
        .join("\n") || "_No findings._";
    content = content.replace(
      /(## Skill findings\s*\r?\n\r?\n)[\s\S]*?(\r?\n\r?\n## Expected defects)/,
      `$1${findingSection}$2`,
    );
    return new Response(content, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch {
    return NextResponse.json(
      { error: "Personal skill report file is unavailable" },
      { status: 404 },
    );
  }
}
