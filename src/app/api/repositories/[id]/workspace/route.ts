import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSkillPath } from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { loadGroundTruth } from "@/lib/ground-truth";
import {
  validateLocalRepositoryBranch,
  validateLocalRepositoryPath,
} from "@/lib/local-repository";
import { normalizeModelId } from "@/lib/models";
import { loadPullRequestChangedPaths } from "@/lib/pr-path-filter";
import { scoreReview, scoreReviewPair } from "@/lib/scoring";
import type {
  BaselineProfileRecord,
  HumanFinding,
  ModelFinding,
  PersonalReviewSkillRecord,
  RepositoryRecord,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const settingsSchema = z.object({
  skillPath: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  modelSecondary: z.string().trim().min(1),
  contextTier: z.enum(["default", "long_context"]),
  baselineConcurrency: z.number().int().min(1).max(20),
  localRepoPath: z.string().trim().optional(),
  localRepoBranch: z.string().trim().min(1),
});

type WorkspacePr = {
  id: number;
  url: string;
  dataset_path: string;
  defect_description: string | null;
  baseline_status: string;
  baseline_duration_ms: number | null;
  baseline_findings_json: string | null;
  skill_status: string;
  skill_duration_ms: number | null;
  skill_findings_json: string | null;
  baseline_metrics_json: string | null;
  skill_metrics_json: string | null;
  valued_comment_count: number;
  [key: string]: unknown;
};

type BaselineResultRow = {
  id: number;
  profile_id: number;
  pull_request_id: number;
  status: string;
  duration_ms: number | null;
  findings_json: string | null;
  metrics_json: string | null;
  repository_context_mode: string;
  repository_commit: string | null;
  error: string | null;
  completed_at: string | null;
};

type SkillResultRow = {
  id: number;
  skill_id: number;
  pull_request_id: number;
  baseline_profile_id: number | null;
  model: string;
  model_secondary: string;
  context_tier: string;
  status: string;
  duration_ms: number | null;
  findings_json: string | null;
  metrics_json: string | null;
  repository_context_mode: string;
  repository_commit: string | null;
  error: string | null;
  report_path: string | null;
  completed_at: string | null;
};

type SkillAnalysisResultRow = {
  id: number;
  skill_id: number;
  pull_request_id: number;
  model: string;
  model_secondary: string;
  context_tier: string;
  status: string;
  duration_ms: number | null;
  analysis_json: string | null;
  proposal_json: string | null;
  error: string | null;
  applied_at: string | null;
  application_error: string | null;
};

function findings(json: string | null): ModelFinding[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as ModelFinding[]) : [];
  } catch {
    return [];
  }
}

function scoreParts(json: string | null, variant: "baseline" | "skill") {
  if (!json) return { earned: 0, available: 0 };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const value =
      variant === "skill"
        ? (parsed.skilled as Record<string, unknown> | undefined)
        : parsed;
    return {
      earned:
        typeof value?.earnedPoints === "number" ? value.earnedPoints : 0,
      available:
        typeof value?.availablePoints === "number" ? value.availablePoints : 0,
    };
  } catch {
    return { earned: 0, available: 0 };
  }
}

function summarize(
  results: Array<{ status: string; metrics_json: string | null }>,
  totalPullRequests: number,
  totalAvailablePoints: number,
  variant: "baseline" | "skill",
) {
  const earnedPoints = results.reduce(
    (sum, result) =>
      result.status === "completed"
        ? sum + scoreParts(result.metrics_json, variant).earned
        : sum,
    0,
  );
  return {
    earnedPoints,
    availablePoints: totalAvailablePoints,
    percentage:
      totalAvailablePoints > 0
        ? (earnedPoints / totalAvailablePoints) * 100
        : null,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    running: results.filter((result) => result.status === "running").length,
    pending: results.filter((result) => result.status === "pending").length,
    notQueued: Math.max(
      0,
      totalPullRequests - results.length,
    ),
    totalPullRequests,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const pullRequests = db
    .prepare(`
      SELECT id, number, title, url, author, updated_at, changed_files,
        valued_comment_count, selected, manual, defect_description, dataset_path,
        baseline_status, baseline_duration_ms, baseline_metrics_json,
        baseline_findings_json, baseline_error, baseline_completed_at,
        skill_status, skill_duration_ms, skill_metrics_json, skill_error,
        skill_completed_at, skill_report_path, skill_findings_json
      FROM pull_requests
      WHERE repository_id = ? AND active = 1
      ORDER BY manual DESC, created_at DESC, updated_at DESC
    `)
    .all(id) as WorkspacePr[];
  const profiles = db
    .prepare(`
      SELECT * FROM baseline_profiles
      WHERE repository_id = ? AND active = 1
      ORDER BY model, context_tier
    `)
    .all(id) as BaselineProfileRecord[];
  const skills = db
    .prepare(`
      SELECT * FROM personal_review_skills
      WHERE repository_id = ? AND active = 1
      ORDER BY name
    `)
    .all(id) as PersonalReviewSkillRecord[];
  const baselineRows = db
    .prepare(`
      SELECT result.id, result.profile_id, result.pull_request_id, result.status,
        result.duration_ms, result.findings_json, result.metrics_json,
        result.repository_context_mode, result.repository_commit,
        result.error, result.completed_at
      FROM baseline_profile_results result
      JOIN baseline_profiles profile ON profile.id = result.profile_id
      JOIN pull_requests pr ON pr.id = result.pull_request_id
      WHERE profile.repository_id = ? AND profile.active = 1 AND pr.active = 1
    `)
    .all(id) as BaselineResultRow[];
  const skillRows = db
    .prepare(`
      SELECT result.id, result.skill_id, result.pull_request_id,
        result.baseline_profile_id, result.model, result.model_secondary,
        result.context_tier, result.status, result.duration_ms,
        result.findings_json, result.metrics_json, result.error,
        result.repository_context_mode, result.repository_commit,
        result.report_path, result.completed_at
      FROM personal_skill_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      JOIN pull_requests pr ON pr.id = result.pull_request_id
      WHERE skill.repository_id = ? AND skill.active = 1 AND pr.active = 1
    `)
    .all(id) as SkillResultRow[];
  const skillAnalysisRows = db
    .prepare(`
      SELECT result.id, result.skill_id, result.pull_request_id,
        result.model, result.model_secondary, result.context_tier,
        result.status, result.duration_ms, result.analysis_json,
        result.proposal_json,
        result.error, result.applied_at, result.application_error
      FROM skill_analysis_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      JOIN pull_requests pr ON pr.id = result.pull_request_id
      WHERE skill.repository_id = ? AND skill.active = 1 AND pr.active = 1
    `)
    .all(id) as SkillAnalysisResultRow[];

  const truthEntries = await Promise.all(
    pullRequests.map(async (pr) => [pr.id, await loadGroundTruth(pr)] as const),
  );
  const truthByPr = new Map<number, HumanFinding[]>(truthEntries);
  const totalAvailablePoints = [...truthByPr.values()].reduce(
    (sum, truth) =>
      sum + scoreReviewPair(truth, [], [], 0, 0).baseline.availablePoints,
    0,
  );
  const scoredBaselineRows = baselineRows.map((row) => {
    const metrics =
      row.status === "completed"
        ? scoreReviewPair(
            truthByPr.get(row.pull_request_id) ?? [],
            [],
            findings(row.findings_json),
            0,
            row.duration_ms ?? 0,
          ).baseline
        : null;
    return {
      ...row,
      findings_json: undefined,
      metrics_json: metrics ? JSON.stringify(metrics) : row.metrics_json,
    };
  });
  const scoredSkillRows = skillRows.map((row) => {
    const metrics =
      row.status === "completed"
        ? scoreReview(
            truthByPr.get(row.pull_request_id) ?? [],
            findings(row.findings_json),
          )
        : null;
    return {
      ...row,
      findings_json: undefined,
      metrics_json: metrics ? JSON.stringify(metrics) : row.metrics_json,
    };
  });
  const changedPathEntries = await Promise.all(
    pullRequests.map(
      async (pr) =>
        [pr.id, await loadPullRequestChangedPaths(pr.dataset_path)] as const,
    ),
  );
  const changedPathsByPr = new Map(changedPathEntries);
  const scoredPullRequests = pullRequests.map((pr) => {
    const truth = truthByPr.get(pr.id) ?? [];
    const availablePoints = scoreReviewPair(truth, [], [], 0, 0).baseline
      .availablePoints;
    const baseline = findings(pr.baseline_findings_json);
    const skilled = findings(pr.skill_findings_json);
    const baselineMetrics =
      pr.baseline_status === "completed"
        ? scoreReviewPair(
            truth,
            [],
            baseline,
            0,
            pr.baseline_duration_ms ?? 0,
          ).baseline
        : null;
    const skillMetrics =
      pr.skill_status === "completed"
        ? scoreReviewPair(
            truth,
            skilled,
            baseline,
            pr.skill_duration_ms ?? 0,
            pr.baseline_duration_ms ?? 0,
          )
        : null;
    const publicPr: Record<string, unknown> = { ...pr };
    delete publicPr.dataset_path;
    delete publicPr.baseline_findings_json;
    delete publicPr.skill_findings_json;
    return {
      ...publicPr,
      changed_paths: changedPathsByPr.get(pr.id) ?? [],
      available_points: availablePoints,
      baseline_metrics_json: baselineMetrics
        ? JSON.stringify(baselineMetrics)
        : pr.baseline_metrics_json,
      skill_metrics_json: skillMetrics
        ? JSON.stringify(skillMetrics)
        : pr.skill_metrics_json,
      baselineResults: scoredBaselineRows.filter(
        (result) => result.pull_request_id === pr.id,
      ),
      skillResults: scoredSkillRows.filter(
        (result) => result.pull_request_id === pr.id,
      ),
    };
  });
  const totalPrCount = pullRequests.length;
  const baselineSummaries = profiles.map((profile) => ({
    profileId: profile.id,
    ...summarize(
      scoredBaselineRows.filter((result) => result.profile_id === profile.id),
      totalPrCount,
      totalAvailablePoints,
      "baseline",
    ),
  }));
  const skillSummaries = skills.map((skill) => ({
    skillId: skill.id,
    model: repository.model,
    modelSecondary: repository.model_secondary,
    contextTier: repository.context_tier,
    ...summarize(
      scoredSkillRows.filter(
        (result) =>
          result.skill_id === skill.id &&
          result.model === repository.model &&
          result.model_secondary === repository.model_secondary &&
          result.context_tier === repository.context_tier,
      ),
      totalPrCount,
      totalAvailablePoints,
      "skill",
    ),
  }));
  const tasks = db
    .prepare(`
      SELECT id, kind, status, current_item, total_items, status_message,
        error, created_at, completed_at
      FROM workflow_tasks
      WHERE repository_id = ?
      ORDER BY id DESC
      LIMIT 20
    `)
    .all(id);
  const analysisJobs = db
    .prepare(`
      SELECT id, skill_id, mode, model, model_secondary, context_tier,
        pr_ids_json, status, current_item, total_items, status_message,
        error, created_at, completed_at
      FROM skill_analysis_jobs
      WHERE repository_id = ?
      ORDER BY id DESC
      LIMIT 20
    `)
    .all(id);
  return NextResponse.json({
    repository,
    pullRequests: scoredPullRequests,
    tasks,
    baselineProfiles: profiles,
    personalSkills: skills,
    baselineResults: scoredBaselineRows,
    skillResults: scoredSkillRows,
    skillAnalysisResults: skillAnalysisRows,
    skillAnalysisJobs: analysisJobs,
    baselineSummaries,
    skillSummaries,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid review settings" },
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
  let skillPath: string | null = null;
  let localRepoPath: string | null = null;
  let localRepoBranch: string | null = null;
  let localRepoWarning: string | null = null;
  const updateLocalRepoPath = parsed.data.localRepoPath !== undefined;
  const updateLocalRepoBranch = true;
  try {
    model = normalizeModelId(parsed.data.model);
    modelSecondary = normalizeModelId(parsed.data.modelSecondary);
    if (parsed.data.skillPath) {
      skillPath = (await validateSkillPath(parsed.data.skillPath)).resolved;
    }
    if (updateLocalRepoPath) {
      const validated = await validateLocalRepositoryPath(
        parsed.data.localRepoPath,
        repository,
      );
      localRepoPath = validated.path;
      localRepoWarning = validated.warning;
    }
    const repositoryPath = updateLocalRepoPath
      ? localRepoPath
      : repository.local_repo_path;
    if (!repositoryPath) {
      throw new Error(
        "Set a verified local repository path before selecting a branch",
      );
    }
    localRepoBranch = await validateLocalRepositoryBranch(
      repositoryPath,
      parsed.data.localRepoBranch,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const result = db
    .prepare(`
      UPDATE repositories SET
        skill_path = COALESCE(?, skill_path),
        model = ?,
        model_secondary = ?,
        context_tier = ?,
        baseline_concurrency = ?,
        local_repo_path = CASE WHEN ? = 1 THEN ? ELSE local_repo_path END,
        local_repo_branch = CASE WHEN ? = 1 THEN ? ELSE local_repo_branch END,
        local_repo_warning = CASE WHEN ? = 1 THEN ? ELSE local_repo_warning END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(
      skillPath,
      model,
      modelSecondary,
      parsed.data.contextTier,
      parsed.data.baselineConcurrency,
      updateLocalRepoPath ? 1 : 0,
      localRepoPath,
      updateLocalRepoBranch ? 1 : 0,
      localRepoBranch,
      updateLocalRepoPath ? 1 : 0,
      localRepoWarning,
      id,
    );
  if (result.changes === 0) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  return NextResponse.json({
    repository: db.prepare("SELECT * FROM repositories WHERE id = ?").get(id),
  });
}
