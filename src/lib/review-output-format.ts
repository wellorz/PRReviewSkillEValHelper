import type { ModelFinding, PrMetrics, VariantMetrics } from "@/lib/types";

type ReviewOutputMetadata = {
  type: "baseline" | "personal-skill";
  pullRequest: number;
  pullRequestTitle: string;
  configuration: string;
  model: string;
  modelSecondary: string;
  contextTier: string;
  repositoryContextMode: string;
  repositoryCommit: string | null;
  rawJsonUrl: string;
  loadedSkillDirectory?: string | null;
  skillManifestSha256?: string | null;
  skillOutputDirectory?: string | null;
  reviewResultPath?: string | null;
  roleArtifactCount?: number | null;
};

type FindingExecutionContext = Pick<
  ReviewOutputMetadata,
  "model" | "modelSecondary" | "contextTier"
>;

export function attributedFindingModels(finding: ModelFinding) {
  const models = new Set(finding.sourceModels ?? []);
  const attribution = [
    ...(finding.reviewers ?? []),
    ...(finding.reviewer ? [finding.reviewer] : []),
    ...(finding.agreedBy ?? []),
  ];
  for (const value of attribution) {
    if (/^(?:sol(?:\/|$)|gpt[- ]?5\.6[- ]?sol)/i.test(value)) {
      models.add("gpt-5.6-sol");
    }
    if (/^(?:grok(?:\/|$)|grok[- ]?4\.6)/i.test(value)) {
      models.add("grok-4.6");
    }
  }
  return [...models];
}

export function addFindingExecutionContext(
  findings: ModelFinding[],
  execution: FindingExecutionContext,
) {
  const configuredModels = [
    execution.model,
    ...(execution.modelSecondary !== "none"
      ? [execution.modelSecondary]
      : []),
  ];
  return findings.map((finding) => {
    const attributedModels = attributedFindingModels(finding);
    return {
      ...finding,
      sourceModels:
        attributedModels.length > 0 ? attributedModels : configuredModels,
      contextTier: finding.contextTier ?? execution.contextTier,
    };
  });
}

function scalar(value: string | number) {
  return JSON.stringify(String(value));
}

function block(value: string, indentation = "      ") {
  const normalized = value.trim() || "(not provided)";
  return normalized
    .split(/\r?\n/)
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatVariantMetrics(
  name: "skilled" | "baseline",
  metrics: VariantMetrics,
) {
  return [
    `  ${name}:`,
    `    credits: ${metrics.earnedPoints}/${metrics.availablePoints}`,
    `    precision: ${percentage(metrics.precision)}`,
    `    recall: ${percentage(metrics.recall)}`,
    `    f1: ${percentage(metrics.f1)}`,
    `    meanMatchScore: ${metrics.meanMatchScore.toFixed(3)}`,
    `    falsePositives: ${metrics.falsePositives}`,
    `    falseNegatives: ${metrics.falseNegatives}`,
  ].join("\n");
}

function formatMetrics(metrics: PrMetrics | VariantMetrics | null) {
  if (!metrics) return "metrics: null";
  if ("skilled" in metrics) {
    return [
      "metrics:",
      formatVariantMetrics("skilled", metrics.skilled),
      formatVariantMetrics("baseline", metrics.baseline),
      `  winner: ${metrics.winner}`,
      `  skilledDurationMs: ${metrics.skilledDurationMs}`,
      `  baselineDurationMs: ${metrics.baselineDurationMs}`,
    ].join("\n");
  }
  return [
    "metrics:",
    `  credits: ${metrics.earnedPoints}/${metrics.availablePoints}`,
    `  precision: ${percentage(metrics.precision)}`,
    `  recall: ${percentage(metrics.recall)}`,
    `  f1: ${percentage(metrics.f1)}`,
    `  meanMatchScore: ${metrics.meanMatchScore.toFixed(3)}`,
    `  falsePositives: ${metrics.falsePositives}`,
    `  falseNegatives: ${metrics.falseNegatives}`,
  ].join("\n");
}

function formatFinding(finding: ModelFinding, index: number) {
  const lines =
    finding.lineStart == null
      ? null
      : finding.lineEnd && finding.lineEnd !== finding.lineStart
        ? `${finding.lineStart}-${finding.lineEnd}`
        : String(finding.lineStart);
  const provenance = [
    `    characters: ${JSON.stringify(
      finding.reviewers ??
        (finding.reviewer ? [finding.reviewer] : ["unattributed"]),
    )}`,
    `    reviewers: ${JSON.stringify(
      finding.reviewers ??
        (finding.reviewer ? [finding.reviewer] : ["unattributed"]),
    )}`,
    `    sourceModels: ${JSON.stringify(finding.sourceModels ?? [])}`,
    `    contextTier: ${finding.contextTier ?? "unknown"}`,
    `    verification: ${finding.verification ?? "null"}`,
    `    agreedBy: ${JSON.stringify(finding.agreedBy ?? [])}`,
  ];
  return [
    `  - id: finding-${index + 1}`,
    `    title: ${scalar(finding.title)}`,
    `    file: ${finding.file ? scalar(finding.file) : "null"}`,
    `    lines: ${lines ?? "null"}`,
    `    severity: ${finding.severity}`,
    `    category: ${scalar(finding.category)}`,
    `    confidence: ${percentage(finding.confidence)}`,
    ...provenance,
    "    finding: |-",
    block(finding.description),
    "    evidence: |-",
    block(finding.evidence),
    "    suggestion: |-",
    block(finding.suggestion ?? "(not provided)"),
  ].join("\n");
}

export function formatReviewResult(options: {
  metadata: ReviewOutputMetadata;
  findings: ModelFinding[];
  metrics: PrMetrics | VariantMetrics | null;
}) {
  const { metadata, findings, metrics } = options;
  const findingsWithContext = addFindingExecutionContext(findings, metadata);
  return [
    "review:",
    `  type: ${metadata.type}`,
    `  pullRequest: ${metadata.pullRequest}`,
    `  pullRequestTitle: ${scalar(metadata.pullRequestTitle)}`,
    `  configuration: ${scalar(metadata.configuration)}`,
    `  model: ${metadata.model}`,
    `  modelSecondary: ${metadata.modelSecondary}`,
    `  contextTier: ${metadata.contextTier}`,
    `  repositoryContextMode: ${metadata.repositoryContextMode}`,
    `  repositoryCommit: ${scalar(metadata.repositoryCommit ?? "diff-only")}`,
    ...(metadata.loadedSkillDirectory
      ? [
          `  loadedSkillDirectory: ${scalar(metadata.loadedSkillDirectory)}`,
          `  skillManifestSha256: ${scalar(
            metadata.skillManifestSha256 ?? "unavailable",
          )}`,
        ]
      : []),
    ...(metadata.skillOutputDirectory
      ? [
          `  skillOutputDirectory: ${scalar(
            metadata.skillOutputDirectory,
          )}`,
          `  reviewResultPath: ${scalar(
            metadata.reviewResultPath ?? "unavailable",
          )}`,
          `  roleArtifactCount: ${metadata.roleArtifactCount ?? 0}`,
        ]
      : []),
    `  rawJsonUrl: ${scalar(metadata.rawJsonUrl)}`,
    "",
    findingsWithContext.length > 0
      ? `findings:\n${findingsWithContext.map(formatFinding).join("\n")}`
      : "findings: []",
    "",
    formatMetrics(metrics),
    "",
  ].join("\n");
}
