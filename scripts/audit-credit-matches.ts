import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { loadGroundTruth } from "../src/lib/ground-truth";
import {
  jaccard,
  matchFindings,
  semanticTokenSimilarity,
} from "../src/lib/scoring";
import type { HumanFinding, Match, ModelFinding } from "../src/lib/types";

type PullRequestRow = {
  id: number;
  number: number;
  title: string;
  dataset_path: string;
  defect_description: string | null;
  url: string;
};

type ResultRow = {
  resultType: "baseline" | "personal-skill";
  resultId: number;
  configuration: string;
  pullRequestId: number;
  findingsJson: string | null;
  metricsJson: string | null;
};

type Candidate = Match & {
  modelTitle: string;
  humanSummary: string;
};

function locationScore(human: HumanFinding, model: ModelFinding) {
  if (!human.path || !model.file) return 0;
  const humanPath = human.path.replaceAll("\\", "/").toLowerCase();
  const modelPath = model.file.replaceAll("\\", "/").toLowerCase();
  if (
    humanPath !== modelPath &&
    !humanPath.endsWith(modelPath) &&
    !modelPath.endsWith(humanPath)
  ) {
    return 0;
  }
  const humanLine = human.line ?? human.originalLine;
  if (!humanLine || !model.lineStart) return 0.7;
  const modelEnd = model.lineEnd ?? model.lineStart;
  return humanLine >= model.lineStart - 3 && humanLine <= modelEnd + 3
    ? 1
    : 0.6;
}

function scoredCandidates(
  humanFindings: HumanFinding[],
  modelFindings: ModelFinding[],
) {
  return humanFindings.flatMap((human) =>
    modelFindings.flatMap((model, modelFindingIndex) => {
      if (
        human.iterationId != null &&
        model.iterationId !== human.iterationId
      ) {
        return [];
      }
      const humanText = human.normalizedBody ?? human.body;
      const modelText =
        `${model.title} ${model.description} ${model.evidence}`;
      const lexicalScore = jaccard(humanText, modelText);
      const semantic = semanticTokenSimilarity(humanText, modelText);
      const textScore = Math.max(lexicalScore, semantic.score);
      const location = locationScore(human, model);
      return [
        {
          humanFindingId: human.id,
          modelFindingIndex,
          score:
            location === 0 ? textScore : location * 0.55 + textScore * 0.45,
          locationScore: location,
          textScore,
          lexicalScore,
          semantic,
        },
      ];
    }),
  );
}

function legacyMatches(
  humanFindings: HumanFinding[],
  modelFindings: ModelFinding[],
) {
  const candidates = scoredCandidates(humanFindings, modelFindings).filter(
    ({ humanFindingId, locationScore: location, textScore, lexicalScore, semantic }) => {
      const human = humanFindings.find(
        (finding) => finding.id === humanFindingId,
      );
      if (!human) return false;
      const pathlessSemanticMatch =
        !human.path &&
        semantic.intersection >= 4 &&
        semantic.cosine >= 0.24 &&
        semantic.overlap >= 0.32 &&
        semantic.score >= 0.26;
      const sameFileSystemicMatch =
        location === 0.6 &&
        semantic.intersection >= 6 &&
        semantic.overlap >= 0.22 &&
        semantic.score >= 0.18;
      const legacyScore = location * 0.55 + lexicalScore * 0.45;
      return (
        (location >= 0.7 && textScore >= 0.08) ||
        (!human.path && lexicalScore >= 0.22) ||
        pathlessSemanticMatch ||
        sameFileSystemicMatch ||
        legacyScore >= 0.38
      );
    },
  );
  candidates.sort((left, right) => right.score - left.score);
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

function shortText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function main() {
  const repositoryId = Number(process.argv[2] ?? 1);
  const outputPath =
    process.argv[3] ??
    path.join("data", `credit-match-audit-repository-${repositoryId}.json`);
  if (!Number.isInteger(repositoryId) || repositoryId < 1) {
    throw new Error("Repository ID must be a positive integer");
  }

  const db = new Database("data/benchmark.sqlite", { readonly: true });
  const pullRequests = db
    .prepare(`
      SELECT id, number, title, dataset_path, defect_description, url
      FROM pull_requests
      WHERE repository_id = ?
      ORDER BY number
    `)
    .all(repositoryId) as PullRequestRow[];
  const baselineRows = db
    .prepare(`
      SELECT 'baseline' resultType, result.id resultId,
        profile.name configuration, result.pull_request_id pullRequestId,
        result.findings_json findingsJson, result.metrics_json metricsJson
      FROM baseline_profile_results result
      JOIN baseline_profiles profile ON profile.id = result.profile_id
      WHERE profile.repository_id = ? AND result.status = 'completed'
    `)
    .all(repositoryId) as ResultRow[];
  const skillRows = db
    .prepare(`
      SELECT 'personal-skill' resultType, result.id resultId,
        skill.name configuration, result.pull_request_id pullRequestId,
        result.findings_json findingsJson, result.metrics_json metricsJson
      FROM personal_skill_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      WHERE skill.repository_id = ? AND result.status = 'completed'
    `)
    .all(repositoryId) as ResultRow[];
  const resultsByPr = new Map<number, ResultRow[]>();
  for (const result of [...baselineRows, ...skillRows]) {
    resultsByPr.set(result.pullRequestId, [
      ...(resultsByPr.get(result.pullRequestId) ?? []),
      result,
    ]);
  }

  const details = [];
  let previousCredits = 0;
  let conservativeCredits = 0;
  let removedCredits = 0;
  let uncreditedDefects = 0;
  for (const pr of pullRequests) {
    const truth = (await loadGroundTruth(pr)).filter(
      (finding) => (finding.scorePoint ?? 1) === 1,
    );
    for (const result of resultsByPr.get(pr.id) ?? []) {
      const findings = result.findingsJson
        ? (JSON.parse(result.findingsJson) as ModelFinding[])
        : [];
      const previous = legacyMatches(truth, findings);
      const current = matchFindings(truth, findings);
      const currentHumanIds = new Set(
        current.map((match) => match.humanFindingId),
      );
      previousCredits += previous.length;
      conservativeCredits += current.length;
      removedCredits += previous.filter(
        (match) => !currentHumanIds.has(match.humanFindingId),
      ).length;

      const allCandidates = scoredCandidates(truth, findings);
      const unmatched = truth
        .filter((human) => !currentHumanIds.has(human.id))
        .map((human) => {
          const best = allCandidates
            .filter((candidate) => candidate.humanFindingId === human.id)
            .sort((left, right) => right.score - left.score)[0];
          return {
            humanFindingId: human.id,
            expected: shortText(human.normalizedBody ?? human.body),
            path: human.path,
            line: human.line ?? human.originalLine,
            iterationId: human.iterationId ?? null,
            closestModelFinding: best
              ? {
                  title: findings[best.modelFindingIndex]?.title ?? "Unknown",
                  file: findings[best.modelFindingIndex]?.file ?? null,
                  line: findings[best.modelFindingIndex]?.lineStart ?? null,
                  score: best.score,
                  locationScore: best.locationScore,
                  textScore: best.textScore,
                }
              : null,
          };
        });
      uncreditedDefects += unmatched.length;
      const awarded = current.map((match) => {
        const human = truth.find(
          (finding) => finding.id === match.humanFindingId,
        );
        const model = findings[match.modelFindingIndex];
        return {
          humanFindingId: match.humanFindingId,
          expected: shortText(
            human?.normalizedBody ?? human?.body ?? "Unknown defect",
          ),
          modelFinding: model?.title ?? "Unknown finding",
          modelFile: model?.file ?? null,
          modelLine: model?.lineStart ?? null,
          score: match.score,
          locationScore: match.locationScore,
          textScore: match.textScore,
        };
      });

      if (previous.length !== current.length || unmatched.length > 0) {
        const removed: Candidate[] = previous
          .filter((match) => !currentHumanIds.has(match.humanFindingId))
          .map((match) => {
            const human = truth.find(
              (finding) => finding.id === match.humanFindingId,
            );
            return {
              ...match,
              modelTitle:
                findings[match.modelFindingIndex]?.title ?? "Unknown finding",
              humanSummary: shortText(
                human?.normalizedBody ?? human?.body ?? "Unknown defect",
              ),
            };
          });
        details.push({
          pullRequest: pr.number,
          title: pr.title,
          resultType: result.resultType,
          resultId: result.resultId,
          configuration: result.configuration,
          previousCredits: previous.length,
          conservativeCredits: current.length,
          awarded,
          removed,
          unmatched,
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    repositoryId,
    completedResults: baselineRows.length + skillRows.length,
    previousCredits,
    conservativeCredits,
    removedCredits,
    uncreditedDefects,
    details,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  process.stdout.write(
    `${JSON.stringify({ ...report, details: undefined, outputPath })}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
