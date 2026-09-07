import { NextResponse } from "next/server";
import { z } from "zod";
import { summarizeComparisonResults } from "@/lib/comparison-matrix";
import { parseReviewOutput } from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { loadGroundTruth } from "@/lib/ground-truth";
import {
  listHistorySnapshots,
  saveHistorySnapshot,
  type HistoryReportToSave,
} from "@/lib/history-snapshot-store";
import {
  historyConfigurationDescription,
  historyTimestampIso,
} from "@/lib/history-snapshots";
import { modelLabel, normalizeModelId } from "@/lib/models";
import { filterPullRequestsByChangedPath } from "@/lib/pr-path-filter";
import { scoreReview, scoreReviewPair } from "@/lib/scoring";
import type {
  BaselineProfileRecord,
  ModelFinding,
  PersonalReviewSkillRecord,
  RepositoryRecord,
  VariantMetrics,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const saveSchema = z.object({
  pullRequestIds: z.array(z.number().int().positive()).optional(),
  skillIds: z.array(z.number().int().positive()).optional(),
  applyPathFilter: z.boolean().default(false),
  pathFilter: z.string().trim().max(2000).default(""),
  model: z.string().trim().min(1).optional(),
  modelSecondary: z.string().trim().min(1).optional(),
  contextTier: z.enum(["default", "long_context"]).optional(),
});

type ReportPr = {
  id: number;
  number: number;
  title: string;
  url: string;
  author: string;
  valued_comment_count: number;
  dataset_path: string;
  defect_description: string | null;
};

type BaselineResult = {
  id: number;
  profile_id: number;
  pull_request_id: number;
  status: string;
  duration_ms: number | null;
  findings_json: string | null;
  raw_output: string | null;
  repository_commit: string | null;
  error: string | null;
  completed_at: string | null;
};

type SkillResult = {
  id: number;
  skill_id: number;
  pull_request_id: number;
  baseline_profile_id: number | null;
  status: string;
  duration_ms: number | null;
  findings_json: string | null;
  raw_output_json: string | null;
  repository_commit: string | null;
  error: string | null;
  model: string;
  model_secondary: string;
  context_tier: string;
  completed_at: string | null;
  metrics_json: string | null;
};

function findings(value: string | null) {
  if (!value) return [] as ModelFinding[];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelFinding[]) : [];
  } catch {
    return [];
  }
}

function isVariantMetrics(value: unknown): value is VariantMetrics {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Partial<VariantMetrics>;
  return (
    typeof metrics.earnedPoints === "number" &&
    typeof metrics.availablePoints === "number" &&
    typeof metrics.precision === "number" &&
    typeof metrics.recall === "number" &&
    typeof metrics.f1 === "number"
  );
}

function storedSkillMetrics(value: string | null): VariantMetrics | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isVariantMetrics(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      "skilled" in parsed &&
      isVariantMetrics(parsed.skilled)
    ) {
      return parsed.skilled;
    }
    return null;
  } catch {
    return null;
  }
}

function reviewSummary(value: string | null) {
  if (!value) return "";
  let raw = value;
  try {
    const outputs = JSON.parse(value) as {
      model1?: string | null;
      orchestration?: string | null;
    };
    raw = outputs.orchestration ?? outputs.model1 ?? value;
  } catch {
    // Legacy output may be the review JSON directly.
  }
  try {
    return parseReviewOutput(raw).summary;
  } catch {
    return "";
  }
}

function profileName(profile: BaselineProfileRecord) {
  return (
    profile.name?.trim() ||
    `${modelLabel(profile.model)} + ${modelLabel(profile.model_secondary)} · ${profile.context_tier === "long_context" ? "1M" : "400K"}`
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db
    .prepare("SELECT id FROM repositories WHERE id = ?")
    .get(id);
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  return NextResponse.json({
    snapshots: listHistorySnapshots(db, id),
    reports: db
      .prepare(`
        SELECT id, name, kind, configuration_name, earned_points,
          available_points, completed_count, failed_count, created_at
        FROM history_reports
        WHERE repository_id = ?
        ORDER BY id DESC
      `)
      .all(id),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const text = await request.text();
  let input: unknown = {};
  if (text.trim()) {
    try {
      input = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return NextResponse.json({ error: "Invalid snapshot request JSON" }, { status: 400 });
    }
  }
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid snapshot scope" },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  let model: string;
  let modelSecondary: string;
  try {
    model = normalizeModelId(parsed.data.model ?? repository.model);
    modelSecondary = normalizeModelId(
      parsed.data.modelSecondary ?? repository.model_secondary,
    );
    if (model === "none") throw new Error("A snapshot requires Model 1");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const contextTier = parsed.data.contextTier ?? repository.context_tier;
  const allPullRequests = db
    .prepare(`
      SELECT id, number, title, url, author, valued_comment_count,
        dataset_path, defect_description
      FROM pull_requests
      WHERE repository_id = ? AND active = 1
      ORDER BY manual DESC, created_at DESC, updated_at DESC
    `)
    .all(id) as ReportPr[];
  const requestedIds = parsed.data.pullRequestIds
    ? new Set(parsed.data.pullRequestIds)
    : null;
  const requested = requestedIds
    ? allPullRequests.filter((pr) => requestedIds.has(pr.id))
    : allPullRequests;
  if (requestedIds && requested.length !== requestedIds.size) {
    return NextResponse.json(
      { error: "One or more snapshot PRs are unavailable in this repository" },
      { status: 400 },
    );
  }
  const pullRequests = parsed.data.applyPathFilter
    ? await filterPullRequestsByChangedPath(requested, parsed.data.pathFilter)
    : requested;
  const profiles = db
    .prepare(`
      SELECT * FROM baseline_profiles
      WHERE repository_id = ? AND active = 1
      ORDER BY model, context_tier
    `)
    .all(id) as BaselineProfileRecord[];
  const allSkills = db
    .prepare(`
      SELECT * FROM personal_review_skills
      WHERE repository_id = ? AND active = 1
      ORDER BY name
    `)
    .all(id) as PersonalReviewSkillRecord[];
  const requestedSkillIds = parsed.data.skillIds
    ? new Set(parsed.data.skillIds)
    : null;
  const skills = requestedSkillIds
    ? allSkills.filter((skill) => requestedSkillIds.has(skill.id))
    : allSkills;
  if (requestedSkillIds && skills.length !== requestedSkillIds.size) {
    return NextResponse.json(
      { error: "One or more snapshot skills are unavailable in this repository" },
      { status: 400 },
    );
  }
  const baselineResults = db
    .prepare(`
      SELECT id, profile_id, pull_request_id, status, duration_ms,
        findings_json, raw_output, repository_commit, error, completed_at
      FROM baseline_profile_results
      WHERE profile_id IN (
        SELECT id FROM baseline_profiles WHERE repository_id = ?
      )
    `)
    .all(id) as BaselineResult[];
  const skillResults = db
    .prepare(`
      SELECT id, skill_id, pull_request_id, baseline_profile_id, status,
        duration_ms, findings_json, raw_output_json, repository_commit,
        error, model, model_secondary, context_tier, completed_at, metrics_json
      FROM personal_skill_results
      WHERE skill_id IN (
        SELECT id FROM personal_review_skills WHERE repository_id = ?
      )
    `)
    .all(id) as SkillResult[];
  const truthEntries = await Promise.all(
    pullRequests.map(async (pr) => [pr.id, await loadGroundTruth(pr)] as const),
  );
  const truthByPr = new Map(truthEntries);
  const totalAvailablePoints = truthEntries.reduce(
    (sum, [, truth]) =>
      sum +
      scoreReviewPair(truth, [], [], 0, 0).baseline.availablePoints,
    0,
  );
  const baselineByProfileAndPr = new Map(
    baselineResults.map((result) => [
      `${result.profile_id}:${result.pull_request_id}`,
      result,
    ]),
  );
  const savedAt = new Date();
  const createdAt = savedAt.toISOString();
  const snapshots: HistoryReportToSave[] = [];

  for (const profile of profiles) {
    const configurationName = profileName(profile);
    const rows = pullRequests.map((pr) => {
      const result = baselineByProfileAndPr.get(`${profile.id}:${pr.id}`);
      const modelFindings = findings(result?.findings_json ?? null);
      const metrics =
        result?.status === "completed"
          ? scoreReviewPair(
              truthByPr.get(pr.id) ?? [],
              [],
              modelFindings,
              0,
              result.duration_ms ?? 0,
            ).baseline
          : null;
      return {
        pullRequest: {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          valuedCommentCount: pr.valued_comment_count,
        },
        status: result?.status ?? "not-queued",
        durationMs: result?.duration_ms ?? null,
        completedAt: result?.completed_at
          ? historyTimestampIso(result.completed_at)
          : null,
        repositoryCommit: result?.repository_commit ?? null,
        metrics,
        summary: reviewSummary(result?.raw_output ?? null),
        findings: modelFindings,
        rawOutput: result?.raw_output ?? null,
        error: result?.error ?? null,
      };
    });
    const summary = summarizeComparisonResults(
      rows.map((row) => ({
        status: row.status,
        earnedPoints: row.metrics?.earnedPoints ?? 0,
      })),
      rows.length,
      totalAvailablePoints,
    );
    const configuration = {
      kind: "baseline" as const,
      name: configurationName,
      model: profile.model,
      modelSecondary: profile.model_secondary,
      contextTier: profile.context_tier,
    };
    snapshots.push({
      kind: "baseline",
      configurationName,
      snapshot: {
        version: 2,
        createdAt,
        repository: {
          id: repository.id,
          name: repository.display_name,
          slug: repository.slug,
        },
        configuration: {
          ...configuration,
          description: historyConfigurationDescription(configuration),
        },
        aggregate: {
          earnedPoints: summary.earnedPoints,
          availablePoints: totalAvailablePoints,
        },
        summary,
        results: rows,
      },
    });
  }

  for (const skill of skills) {
    const rows = pullRequests.map((pr) => {
      const result = skillResults.find(
        (candidate) =>
          candidate.skill_id === skill.id &&
          candidate.pull_request_id === pr.id &&
          candidate.model === model &&
          candidate.model_secondary === modelSecondary &&
          candidate.context_tier === contextTier,
      );
      const modelFindings = findings(result?.findings_json ?? null);
      const metrics =
        result?.status === "completed"
          ? scoreReview(
              truthByPr.get(pr.id) ?? [],
              modelFindings,
            )
          : storedSkillMetrics(result?.metrics_json ?? null);
      return {
        pullRequest: {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          valuedCommentCount: pr.valued_comment_count,
        },
        status: result?.status ?? "not-queued",
        durationMs: result?.duration_ms ?? null,
        completedAt: result?.completed_at
          ? historyTimestampIso(result.completed_at)
          : null,
        repositoryCommit: result?.repository_commit ?? null,
        metrics,
        summary: reviewSummary(result?.raw_output_json ?? null),
        findings: modelFindings,
        rawOutput: result?.raw_output_json ?? null,
        error: result?.error ?? null,
      };
    });
    const summary = summarizeComparisonResults(
      rows.map((row) => ({
        status: row.status,
        earnedPoints: row.metrics?.earnedPoints ?? 0,
      })),
      rows.length,
      totalAvailablePoints,
    );
    const configuration = {
      kind: "personal-skill" as const,
      name: skill.name,
      model,
      modelSecondary,
      contextTier,
    };
    snapshots.push({
      kind: "personal-skill",
      configurationName: skill.name,
      snapshot: {
        version: 2,
        createdAt,
        repository: {
          id: repository.id,
          name: repository.display_name,
          slug: repository.slug,
        },
        configuration: {
          ...configuration,
          description: historyConfigurationDescription(configuration),
        },
        aggregate: {
          earnedPoints: summary.earnedPoints,
          availablePoints: totalAvailablePoints,
        },
        summary,
        results: rows,
      },
    });
  }

  if (snapshots.length === 0) {
    return NextResponse.json(
      { error: "Add a baseline profile or personal skill before saving reports" },
      { status: 409 },
    );
  }
  return NextResponse.json(
    saveHistorySnapshot(db, {
      repositoryId: repository.id,
      scope: {
        pullRequestNumbers: pullRequests.map((pr) => pr.number),
        pathFilter: parsed.data.pathFilter,
        pathFilterEnabled: parsed.data.applyPathFilter,
      },
      reports: snapshots,
      savedAt,
    }),
    { status: 201 },
  );
}
