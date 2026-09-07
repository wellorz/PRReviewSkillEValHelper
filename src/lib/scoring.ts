import type {
  HumanFinding,
  Match,
  ModelFinding,
  PrMetrics,
  VariantMetrics,
} from "@/lib/types";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "being",
  "could",
  "does",
  "from",
  "have",
  "into",
  "just",
  "more",
  "must",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

function tokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}

function normalizedTokens(value: string) {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => {
        if (token.length > 6 && token.endsWith("ies")) {
          return `${token.slice(0, -3)}y`;
        }
        if (token.length > 6 && token.endsWith("ing")) {
          return token.slice(0, -3);
        }
        if (token.length > 5 && token.endsWith("ed")) {
          return token.slice(0, -2);
        }
        if (token.length > 5 && token.endsWith("s")) {
          return token.slice(0, -1);
        }
        return token;
      })
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

export function jaccard(left: string, right: string) {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function semanticTokenSimilarity(left: string, right: string) {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (a.size === 0 || b.size === 0) {
    return { score: 0, intersection: 0, cosine: 0, overlap: 0 };
  }
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const jaccardScore = intersection / (a.size + b.size - intersection);
  const cosine = intersection / Math.sqrt(a.size * b.size);
  const overlap = intersection / Math.min(a.size, b.size);
  return {
    score: cosine * 0.5 + overlap * 0.3 + jaccardScore * 0.2,
    intersection,
    cosine,
    overlap,
  };
}

function locationScore(human: HumanFinding, model: ModelFinding) {
  if (!human.path || !model.file) return 0;
  const normalizedHuman = human.path.replaceAll("\\", "/").toLowerCase();
  const normalizedModel = model.file.replaceAll("\\", "/").toLowerCase();
  if (
    normalizedHuman !== normalizedModel &&
    !normalizedHuman.endsWith(normalizedModel) &&
    !normalizedModel.endsWith(normalizedHuman)
  ) {
    return 0;
  }
  const humanLine = human.line ?? human.originalLine;
  if (!humanLine || !model.lineStart) return 0.7;
  const modelEnd = model.lineEnd ?? model.lineStart;
  if (humanLine >= model.lineStart - 3 && humanLine <= modelEnd + 3) return 1;
  return 0.6;
}

export function matchFindings(
  humanFindings: HumanFinding[],
  modelFindings: ModelFinding[],
): Match[] {
  const candidates: Match[] = [];
  humanFindings.forEach((human) => {
    modelFindings.forEach((model, modelFindingIndex) => {
      if (
        human.iterationId != null &&
        model.iterationId !== human.iterationId
      ) {
        return;
      }
      const humanText = human.normalizedBody ?? human.body;
      const modelText =
        `${model.title} ${model.description} ${model.evidence}`;
      const lexicalScore = jaccard(humanText, modelText);
      const semanticTokens = semanticTokenSimilarity(humanText, modelText);
      const textScore = Math.max(lexicalScore, semanticTokens.score);
      const location = locationScore(human, model);
      const score =
        location === 0 ? textScore : location * 0.55 + textScore * 0.45;
      const legacyScore = location * 0.55 + lexicalScore * 0.45;
      const pathlessSemanticMatch =
        !human.path &&
        semanticTokens.intersection >= 4 &&
        semanticTokens.cosine >= 0.24 &&
        semanticTokens.overlap >= 0.32 &&
        semanticTokens.score >= 0.26;
      if (
        (location >= 0.7 && textScore >= 0.08) ||
        (!human.path && lexicalScore >= 0.22) ||
        pathlessSemanticMatch ||
        legacyScore >= 0.38
      ) {
        candidates.push({
          humanFindingId: human.id,
          modelFindingIndex,
          score,
          locationScore: location,
          textScore,
        });
      }
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  const humanUsed = new Set<string>();
  const modelUsed = new Set<number>();
  return candidates.filter((candidate) => {
    if (
      humanUsed.has(candidate.humanFindingId) ||
      modelUsed.has(candidate.modelFindingIndex)
    ) {
      return false;
    }
    humanUsed.add(candidate.humanFindingId);
    modelUsed.add(candidate.modelFindingIndex);
    return true;
  });
}

function calculateVariantMetrics(
  humanCount: number,
  ignoredHumanFindings: number,
  modelCount: number,
  matches: Match[],
): VariantMetrics {
  const truePositives = matches.length;
  const falsePositives = Math.max(0, modelCount - truePositives);
  const falseNegatives = Math.max(0, humanCount - truePositives);
  const precision = modelCount === 0 ? 0 : truePositives / modelCount;
  const recall = humanCount === 0 ? 1 : truePositives / humanCount;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    earnedPoints: truePositives,
    availablePoints: humanCount,
    ignoredHumanFindings,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    meanMatchScore:
      matches.length === 0
        ? 0
        : matches.reduce((sum, match) => sum + match.score, 0) / matches.length,
  };
}

export function scoreReview(
  humanFindings: HumanFinding[],
  modelFindings: ModelFinding[],
): VariantMetrics {
  const scoredHumanFindings = humanFindings.filter(
    (finding) => (finding.scorePoint ?? 1) === 1,
  );
  return calculateVariantMetrics(
    scoredHumanFindings.length,
    humanFindings.length - scoredHumanFindings.length,
    modelFindings.length,
    matchFindings(scoredHumanFindings, modelFindings),
  );
}

export function scoreReviewPair(
  humanFindings: HumanFinding[],
  skilledFindings: ModelFinding[],
  baselineFindings: ModelFinding[],
  skilledDurationMs: number,
  baselineDurationMs: number,
): PrMetrics {
  const scoredHumanFindings = humanFindings.filter(
    (finding) => (finding.scorePoint ?? 1) === 1,
  );
  const skillMatches = matchFindings(scoredHumanFindings, skilledFindings);
  const baselineMatches = matchFindings(scoredHumanFindings, baselineFindings);
  const skilled = scoreReview(humanFindings, skilledFindings);
  const baseline = scoreReview(humanFindings, baselineFindings);
  const delta = skilled.earnedPoints - baseline.earnedPoints;
  return {
    skilled,
    baseline,
    skillMatches,
    baselineMatches,
    winner: delta === 0 ? "tie" : delta > 0 ? "skilled" : "baseline",
    skilledDurationMs,
    baselineDurationMs,
  };
}
