import fs from "node:fs/promises";
import path from "node:path";
import type {
  HumanFinding,
  MultiModelPrMetrics,
  PrMetrics,
  ReviewOutput,
  VariantMetrics,
} from "@/lib/types";

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricRow(
  label: string,
  skilled: number | string,
  baseline: number | string,
) {
  return `| ${label} | ${skilled} | ${baseline} |`;
}

function findingsMarkdown(review: ReviewOutput) {
  return (
    review.findings
      .map((finding) => {
        const reviewers =
          finding.reviewers ??
          (finding.reviewer ? [finding.reviewer] : ["unattributed"]);
        const provenance = [
          `reviewers: ${reviewers.join(", ")}`,
          `models: ${(finding.sourceModels ?? []).join(", ") || "unknown"}`,
          `context: ${finding.contextTier ?? "unknown"}`,
        ].join("; ");
        return `- **${finding.severity.toUpperCase()} — ${finding.title}** (\`${finding.file ?? "general"}:${finding.lineStart ?? "n/a"}\`; ${provenance}): ${finding.description}${finding.suggestion ? ` Fix: ${finding.suggestion}` : ""}`;
      })
      .join("\n") || "_No findings._"
  );
}

function metricsTable(metrics: PrMetrics, skilledCount: number, baselineCount: number) {
  return `| Metric | Skilled | Baseline |
|---|---:|---:|
${metricRow("Score", pct(metrics.skilled.recall), pct(metrics.baseline.recall))}
${metricRow("Credits", `${metrics.skilled.earnedPoints}/${metrics.skilled.availablePoints}`, `${metrics.baseline.earnedPoints}/${metrics.baseline.availablePoints}`)}
${metricRow("Findings", skilledCount, baselineCount)}
${metricRow("Matched human findings", metrics.skilled.truePositives, metrics.baseline.truePositives)}
${metricRow("False positives", metrics.skilled.falsePositives, metrics.baseline.falsePositives)}
${metricRow("Precision", pct(metrics.skilled.precision), pct(metrics.baseline.precision))}
${metricRow("Recall", pct(metrics.skilled.recall), pct(metrics.baseline.recall))}
${metricRow("F1", pct(metrics.skilled.f1), pct(metrics.baseline.f1))}`;
}

export async function writePrReport(options: {
  outputPath: string;
  repository: string;
  pr: { number: number; title: string; url: string };
  humanFindings: HumanFinding[];
  skilled: ReviewOutput;
  baseline: ReviewOutput;
  modelReviews: Partial<Record<
    "model1-skilled" | "model1-baseline" | "model2-skilled" | "model2-baseline",
    ReviewOutput
  >>;
  models: { model1: string; model2: string | null };
  orchestrationSummary: string;
  metrics: MultiModelPrMetrics;
}) {
  const metrics = options.metrics.orchestrated;
  const matchedHuman = new Map(
    options.humanFindings.map((finding) => [finding.id, finding]),
  );
  const matchSection = (variant: "skilled" | "baseline") => {
    const matches =
      variant === "skilled" ? metrics.skillMatches : metrics.baselineMatches;
    const findings =
      variant === "skilled" ? options.skilled.findings : options.baseline.findings;
    if (matches.length === 0) return "_No valued human findings matched._";
    return matches
      .map((match) => {
        const human = matchedHuman.get(match.humanFindingId);
        const model = findings[match.modelFindingIndex];
        return `- **${model?.title ?? "Finding"}** matched ${human?.author ?? "reviewer"} at \`${human?.path ?? "general"}:${human?.line ?? "n/a"}\` (${pct(match.score)} match).`;
      })
      .join("\n");
  };

  const markdown = `# PR Review Quiz: ${options.repository}#${options.pr.number}

**${options.pr.title}**

- Model 1: **${options.models.model1}** (reviewer and orchestrator)
- Model 2: **${options.models.model2 ?? "None"}**${options.models.model2 ? " (reviewer)" : ""}
- Result: **${metrics.winner}**
- Available defect credits: **${metrics.skilled.availablePoints}**
- Skilled review time: **${(metrics.skilledDurationMs / 1000).toFixed(1)}s**
- Baseline review time: **${(metrics.baselineDurationMs / 1000).toFixed(1)}s**
- Model 1 orchestration time: **${(options.metrics.orchestrationDurationMs / 1000).toFixed(1)}s**

## Orchestrated score

${metricsTable(metrics, options.skilled.findings.length, options.baseline.findings.length)}

## Per-model F1

| Model | Skilled | Baseline | Winner |
|---|---:|---:|---|
| Model 1 · ${options.models.model1} | ${pct(options.metrics.model1.skilled.f1)} | ${pct(options.metrics.model1.baseline.f1)} | ${options.metrics.model1.winner} |
${options.metrics.model2 && options.models.model2 ? `| Model 2 · ${options.models.model2} | ${pct(options.metrics.model2.skilled.f1)} | ${pct(options.metrics.model2.baseline.f1)} | ${options.metrics.model2.winner} |` : ""}

## Model 1 orchestration

${options.orchestrationSummary || "_No orchestration summary._"}

### Skilled matches

${matchSection("skilled")}

### Baseline matches

${matchSection("baseline")}

## Final skilled review

${options.skilled.summary || "_No summary._"}

${findingsMarkdown(options.skilled)}

## Final baseline review

${options.baseline.summary || "_No summary._"}

${findingsMarkdown(options.baseline)}

## Individual model reviews

### Model 1 skilled

${findingsMarkdown(options.modelReviews["model1-skilled"]!)}

### Model 1 baseline

${findingsMarkdown(options.modelReviews["model1-baseline"]!)}

${options.modelReviews["model2-skilled"] ? `### Model 2 skilled

${findingsMarkdown(options.modelReviews["model2-skilled"])}

### Model 2 baseline

${findingsMarkdown(options.modelReviews["model2-baseline"]!)}` : ""}

## Ground truth

${options.humanFindings.map((finding) => `- **${finding.author}** (\`${finding.path ?? "general"}:${finding.line ?? finding.originalLine ?? "n/a"}\`): ${finding.normalizedBody ?? finding.body}`).join("\n")}
`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, markdown);
}

function average(
  values: VariantMetrics[],
  key: keyof Pick<VariantMetrics, "precision" | "recall" | "f1" | "meanMatchScore">,
) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value[key], 0) / values.length;
}

export async function writeSummaryReport(options: {
  outputDirectory: string;
  repository: string;
  models: { model1: string; model2: string | null };
  skillPath: string;
  rows: Array<{
    number: number;
    title: string;
    metrics: MultiModelPrMetrics;
    reportPath: string;
  }>;
}) {
  const orchestrated = options.rows.map((row) => row.metrics.orchestrated);
  const skill = orchestrated.map((metrics) => metrics.skilled);
  const baseline = orchestrated.map((metrics) => metrics.baseline);
  const skilledWins = orchestrated.filter(
    (metrics) => metrics.winner === "skilled",
  ).length;
  const baselineWins = orchestrated.filter(
    (metrics) => metrics.winner === "baseline",
  ).length;
  const ties = options.rows.length - skilledWins - baselineWins;
  const skillTime = orchestrated.reduce(
    (sum, metrics) => sum + metrics.skilledDurationMs,
    0,
  );
  const baselineTime = orchestrated.reduce(
    (sum, metrics) => sum + metrics.baselineDurationMs,
    0,
  );
  const orchestrationTime = options.rows.reduce(
    (sum, row) => sum + row.metrics.orchestrationDurationMs,
    0,
  );
  const skilledEarnedPoints = skill.reduce(
    (sum, metrics) => sum + metrics.earnedPoints,
    0,
  );
  const baselineEarnedPoints = baseline.reduce(
    (sum, metrics) => sum + metrics.earnedPoints,
    0,
  );
  const availablePoints = skill.reduce(
    (sum, metrics) => sum + metrics.availablePoints,
    0,
  );
  const summary = {
    repository: options.repository,
    models: options.models,
    skillPath: options.skillPath,
    generatedAt: new Date().toISOString(),
    pullRequests: options.rows.length,
    wins: { skilled: skilledWins, baseline: baselineWins, ties },
    skilled: {
      earnedPoints: skilledEarnedPoints,
      availablePoints,
      score: availablePoints > 0 ? skilledEarnedPoints / availablePoints : 0,
      precision: average(skill, "precision"),
      recall: average(skill, "recall"),
      f1: average(skill, "f1"),
      meanMatchScore: average(skill, "meanMatchScore"),
      durationMs: skillTime,
    },
    baseline: {
      earnedPoints: baselineEarnedPoints,
      availablePoints,
      score: availablePoints > 0 ? baselineEarnedPoints / availablePoints : 0,
      precision: average(baseline, "precision"),
      recall: average(baseline, "recall"),
      f1: average(baseline, "f1"),
      meanMatchScore: average(baseline, "meanMatchScore"),
      durationMs: baselineTime,
    },
    orchestrationDurationMs: orchestrationTime,
  };
  const markdown = `# PR Review Skill Evaluation

- Repository: **${options.repository}**
- Model 1: **${options.models.model1}** (reviewer and orchestrator)
- Model 2: **${options.models.model2 ?? "None"}**${options.models.model2 ? " (reviewer)" : ""}
- Skill: \`${options.skillPath}\`
- Pull requests evaluated: **${options.rows.length}**
- Skilled wins / baseline wins / ties: **${skilledWins} / ${baselineWins} / ${ties}**

| Metric | Skilled | Baseline | Delta |
|---|---:|---:|---:|
| Score | ${pct(summary.skilled.score)} | ${pct(summary.baseline.score)} | ${pct(summary.skilled.score - summary.baseline.score)} |
| Credits | ${summary.skilled.earnedPoints}/${summary.skilled.availablePoints} | ${summary.baseline.earnedPoints}/${summary.baseline.availablePoints} | ${summary.skilled.earnedPoints - summary.baseline.earnedPoints} |
| Precision | ${pct(summary.skilled.precision)} | ${pct(summary.baseline.precision)} | ${pct(summary.skilled.precision - summary.baseline.precision)} |
| Recall | ${pct(summary.skilled.recall)} | ${pct(summary.baseline.recall)} | ${pct(summary.skilled.recall - summary.baseline.recall)} |
| F1 | ${pct(summary.skilled.f1)} | ${pct(summary.baseline.f1)} | ${pct(summary.skilled.f1 - summary.baseline.f1)} |
| Mean match score | ${pct(summary.skilled.meanMatchScore)} | ${pct(summary.baseline.meanMatchScore)} | ${pct(summary.skilled.meanMatchScore - summary.baseline.meanMatchScore)} |
| Total review time | ${(skillTime / 1000).toFixed(1)}s | ${(baselineTime / 1000).toFixed(1)}s | ${((skillTime - baselineTime) / 1000).toFixed(1)}s |

Model 1 orchestration time: **${(orchestrationTime / 1000).toFixed(1)}s**

## PR quiz results

| PR | Winner | Skilled score | Baseline score | Model 1 skill F1 | Model 2 skill F1 |
|---|---|---:|---:|---:|---:|
${options.rows.map((row) => `| #${row.number} ${row.title.replaceAll("|", "\\|")} | ${row.metrics.orchestrated.winner} | ${pct(row.metrics.orchestrated.skilled.recall)} | ${pct(row.metrics.orchestrated.baseline.recall)} | ${pct(row.metrics.model1.skilled.f1)} | ${row.metrics.model2 ? pct(row.metrics.model2.skilled.f1) : "N/A"} |`).join("\n")}
`;
  await fs.mkdir(options.outputDirectory, { recursive: true });
  const jsonPath = path.join(options.outputDirectory, "summary.json");
  const markdownPath = path.join(options.outputDirectory, "summary.md");
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(summary, null, 2)),
    fs.writeFile(markdownPath, markdown),
  ]);
  return { jsonPath, markdownPath, summary };
}

export async function writeQuickReviewReport(options: {
  outputPath: string;
  repository: string;
  pr: { number: number; title: string; url: string };
  models: { model1: string; model2: string | null };
  review: ReviewOutput;
  durationMs: number;
}) {
  const markdown = `# Quick PR Review: ${options.repository}#${options.pr.number}

**${options.pr.title}**

- Model 1: **${options.models.model1}** (${options.models.model2 ? "reviewer and orchestrator" : "reviewer"})
- Model 2: **${options.models.model2 ?? "None"}**${options.models.model2 ? " (reviewer)" : ""}
- Total elapsed model time: **${(options.durationMs / 1000).toFixed(1)}s**

## What is wrong with this PR?

${options.review.summary || "_No summary._"}

${findingsMarkdown(options.review)}

This is an unscored review. No human ground truth is required or exposed to the
models.
`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, markdown);
}
