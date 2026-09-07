import { NextResponse } from "next/server";
import { parseReviewOutput } from "@/lib/copilot";
import { getDb } from "@/lib/db";
import {
  addFindingExecutionContext,
  formatReviewResult,
} from "@/lib/review-output-format";
import type { ModelFinding, VariantMetrics } from "@/lib/types";

function formattedReview(
  raw: string | null | undefined,
  execution: {
    model: string;
    modelSecondary: string;
    contextTier: string;
  },
) {
  if (!raw) return "_No review output._";
  try {
    const review = parseReviewOutput(raw);
    const findingsWithContext = addFindingExecutionContext(
      review.findings,
      execution,
    );
    const severityOrder = ["critical", "high", "medium", "low"];
    const severity =
      severityOrder.find((level) =>
        findingsWithContext.some((finding) => finding.severity === level),
      ) ?? "none";
    const findings =
      findingsWithContext
        .map(
          (finding) =>
            `### ${finding.title}\n\n` +
            `- Severity: **${finding.severity.toUpperCase()}**\n` +
            `- Location: **${finding.file ?? "No file"}${finding.lineStart ? `:${finding.lineStart}` : ""}**\n` +
            `- Confidence: **${Math.round(finding.confidence * 100)}%**\n` +
            `- Model: **${finding.sourceModels?.join(", ") || "unknown"}**\n` +
            `- Context: **${finding.contextTier ?? "unknown"}**\n\n` +
            `${finding.description}\n\n` +
            `Evidence: ${finding.evidence}`,
        )
        .join("\n\n") || "_No findings._";
    return `**Summary:** ${review.summary || "No summary provided."}

**Severity:** ${severity.toUpperCase()}

${findings}`;
  } catch {
    return `\`\`\`text\n${raw}\n\`\`\``;
  }
}

function prettyJson(raw: string | null | undefined) {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    try {
      return JSON.stringify(parseReviewOutput(raw), null, 2);
    } catch {
      return raw;
    }
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare(`
      SELECT result.raw_output, result.findings_json, result.metrics_json,
        result.repository_context_mode, result.repository_commit,
        profile.name, profile.model, profile.model_secondary,
        profile.context_tier, pr.number, pr.title
      FROM baseline_profile_results result
      JOIN baseline_profiles profile ON profile.id = result.profile_id
      JOIN pull_requests pr ON pr.id = result.pull_request_id
      WHERE result.id = ?
    `)
    .get(id) as
    | {
        raw_output: string | null;
        findings_json: string | null;
        metrics_json: string | null;
        repository_context_mode: string;
        repository_commit: string | null;
        model: string;
        model_secondary: string;
        name: string | null;
        context_tier: string;
        number: number;
        title: string;
      }
    | undefined;
  if (!row) {
    return NextResponse.json(
      { error: "Baseline result not found" },
      { status: 404 },
    );
  }
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
    profile: row.name,
    model: row.model,
    modelSecondary: row.model_secondary,
    contextTier: row.context_tier,
    repositoryContextMode: row.repository_context_mode,
    repositoryCommit: row.repository_commit,
    findings,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    rawOutputs: row.raw_output,
  };
  if (new URL(request.url).searchParams.get("format") === "json") {
    return NextResponse.json(payload);
  }
  if (row.raw_output) {
    let outputs: {
      model1?: string | null;
      model2?: string | null;
      orchestration?: string | null;
      iterations?: Array<{
        key: string;
        iterationId: number | null;
        sourceCommit: string;
        model1: string;
        model2: string | null;
        orchestration: string | null;
      }>;
    } = { model1: row.raw_output };
    try {
      outputs = JSON.parse(row.raw_output) as typeof outputs;
    } catch {
      // Legacy single-model results stored raw text directly.
    }
    const iterationRawReviews = outputs.iterations
      ?.map(
        (iteration) => `## ${iteration.key} raw reviews

- Source commit: **${iteration.sourceCommit}**

### Model 1

\`\`\`json
${prettyJson(iteration.model1)}
\`\`\`

### Model 2

${iteration.model2 ? `\`\`\`json\n${prettyJson(iteration.model2)}\n\`\`\`` : "_Model 2 was disabled._"}

### Orchestration

${iteration.orchestration ? `\`\`\`json\n${prettyJson(iteration.orchestration)}\n\`\`\`` : "_Orchestration was not required._"}`,
      )
      .join("\n\n");
    const finalReview = outputs.iterations
      ? JSON.stringify({
          summary: `Combined review across ${outputs.iterations.length} credited PR iteration${outputs.iterations.length === 1 ? "" : "s"}.`,
          findings: payload.findings,
        })
      : outputs.orchestration ?? outputs.model1;
    const content = `# Baseline Review: #${row.number} ${row.title}

- Profile: **${row.name ?? "Unnamed baseline"}**
- Model 1: **${row.model}**
- Model 2: **${row.model_secondary}**
- Context: **${row.context_tier}**
- Repository context: **${row.repository_context_mode}**
- Commit: **${row.repository_commit ?? "diff-only"}**
- Complete JSON: **/api/baseline-profile-results/${id}/output?format=json**

## Final review

${formattedReview(finalReview, execution)}

${iterationRawReviews ?? `## Model 1 raw review

\`\`\`json
${prettyJson(outputs.model1)}
\`\`\`

## Model 2 raw review

${outputs.model2 ? `\`\`\`json\n${prettyJson(outputs.model2)}\n\`\`\`` : "_Model 2 was disabled._"}`}
`;
    return new Response(content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="baseline-review-${row.number}.md"`,
      },
    });
  }
  return new Response(
    formatReviewResult({
      metadata: {
        type: "baseline",
        pullRequest: row.number,
        pullRequestTitle: row.title,
        configuration: row.name ?? "Unnamed baseline",
        model: row.model,
        modelSecondary: row.model_secondary,
        contextTier: row.context_tier,
        repositoryContextMode: row.repository_context_mode,
        repositoryCommit: row.repository_commit,
        rawJsonUrl: `/api/baseline-profile-results/${id}/output?format=json`,
      },
      findings: payload.findings as ModelFinding[],
      metrics: payload.metrics as VariantMetrics | null,
    }),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename="baseline-review-${row.number}.txt"`,
      },
    },
  );
}
