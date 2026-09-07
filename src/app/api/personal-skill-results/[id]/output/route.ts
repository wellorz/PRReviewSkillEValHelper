import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  addFindingExecutionContext,
  formatReviewResult,
} from "@/lib/review-output-format";
import type { ModelFinding, VariantMetrics } from "@/lib/types";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare(`
      SELECT result.raw_output_json, result.findings_json, result.metrics_json,
        result.model, result.model_secondary, result.context_tier,
        result.repository_context_mode, result.repository_commit,
        skill.name AS skill_name, pr.number, pr.title
      FROM personal_skill_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      JOIN pull_requests pr ON pr.id = result.pull_request_id
      WHERE result.id = ?
    `)
    .get(id) as
    | {
        raw_output_json: string | null;
        findings_json: string | null;
        metrics_json: string | null;
        model: string;
        model_secondary: string;
        context_tier: string;
        repository_context_mode: string;
        repository_commit: string | null;
        skill_name: string;
        number: number;
        title: string;
      }
    | undefined;
  if (!row) {
    return NextResponse.json(
      { error: "Personal skill result not found" },
      { status: 404 },
    );
  }
  const rawOutputs = row.raw_output_json
    ? (JSON.parse(row.raw_output_json) as {
        execution?: {
          loadedSkillDirectory?: string | null;
          skillManifestSha256?: string | null;
        };
        iterations?: Array<{
          nativeArtifacts?: {
            outputFolder?: string;
            reviewResultPath?: string;
            reviewFiles?: string[];
          };
        }>;
      })
    : null;
  const execution = {
    model: row.model,
    modelSecondary: row.model_secondary,
    contextTier: row.context_tier,
  };
  const findings = addFindingExecutionContext(
    row.findings_json
      ? (JSON.parse(row.findings_json) as ModelFinding[])
      : [],
    execution,
  );
  const payload = {
    pullRequest: row.number,
    pullRequestTitle: row.title,
    skill: row.skill_name,
    model: row.model,
    modelSecondary: row.model_secondary,
    contextTier: row.context_tier,
    repositoryContextMode: row.repository_context_mode,
    repositoryCommit: row.repository_commit,
    rawOutputs,
    findings,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
  };
  if (new URL(request.url).searchParams.get("format") === "json") {
    return NextResponse.json(payload);
  }
  return new Response(
    formatReviewResult({
      metadata: {
        type: "personal-skill",
        pullRequest: row.number,
        pullRequestTitle: row.title,
        configuration: row.skill_name,
        model: row.model,
        modelSecondary: row.model_secondary,
        contextTier: row.context_tier,
        repositoryContextMode: row.repository_context_mode,
        repositoryCommit: row.repository_commit,
        loadedSkillDirectory:
          rawOutputs?.execution?.loadedSkillDirectory ?? null,
        skillManifestSha256:
          rawOutputs?.execution?.skillManifestSha256 ?? null,
        skillOutputDirectory:
          rawOutputs?.iterations?.[0]?.nativeArtifacts?.outputFolder ?? null,
        reviewResultPath:
          rawOutputs?.iterations?.[0]?.nativeArtifacts?.reviewResultPath ??
          null,
        roleArtifactCount:
          rawOutputs?.iterations?.[0]?.nativeArtifacts?.reviewFiles?.length ??
          null,
        rawJsonUrl: `/api/personal-skill-results/${id}/output?format=json`,
      },
      findings: payload.findings as ModelFinding[],
      metrics: payload.metrics as VariantMetrics | null,
    }),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename="skill-review-${row.number}.txt"`,
      },
    },
  );
}
