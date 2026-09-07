"use client";

import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageNavigation } from "@/app/page-navigation";
import { ComparisonMatrix } from "@/app/comparison-matrix";
import { PrTableControls } from "@/app/pr-table-controls";
import {
  summarizeComparisonResults,
  type AggregateSummary,
} from "@/lib/comparison-matrix";
import {
  COPILOT_MODELS,
  OPTIONAL_COPILOT_MODELS,
  modelLabel,
} from "@/lib/models";
import {
  parsePathFilters,
  pathMatchesFilters,
} from "@/lib/repository-source";

type Repository = {
  id: number;
  display_name: string;
  provider: string;
  path_filter: string | null;
  skill_path: string;
  model: string;
  model_secondary: string;
  context_tier: string;
  baseline_concurrency: number;
  local_repo_path: string | null;
  local_repo_branch: string | null;
  local_repo_warning: string | null;
};

type BaselineProfile = {
  id: number;
  model: string;
  model_secondary: string;
  context_tier: "default" | "long_context";
  name: string | null;
};

type PersonalSkill = {
  id: number;
  name: string;
  path: string;
};

type NormalizedResult = {
  id: number;
  profile_id?: number;
  skill_id?: number;
  pull_request_id: number;
  model?: string;
  model_secondary?: string;
  context_tier?: string;
  status: string;
  duration_ms: number | null;
  metrics_json: string | null;
  repository_context_mode?: string;
  repository_commit?: string | null;
  error: string | null;
  report_path?: string | null;
};

type SkillAnalysis = {
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

type SkillAnalysisJob = {
  id: number;
  skill_id: number;
  mode: "analyze" | "analyze_apply";
  model: string;
  model_secondary: string;
  context_tier: string;
  pr_ids_json: string;
  status: string;
  current_item: number;
  total_items: number;
  status_message: string;
  error: string | null;
  created_at: string;
};

type AnalysisDetails = {
  summary: string;
  whyMissed: string;
  mitigation: string;
  edits: Array<{
    file: string;
    search: string;
    replacement: string;
    rationale: string;
    targetKind?: string;
    implementationPath?: string[];
  }>;
};

type PullRequest = {
  id: number;
  number: number;
  title: string;
  url: string;
  author: string;
  changed_files: number;
  changed_paths: string[];
  available_points: number;
  valued_comment_count: number;
  selected: number;
  manual: number;
  defect_description: string | null;
  baseline_status: string;
  baseline_duration_ms: number | null;
  baseline_metrics_json: string | null;
  baseline_error: string | null;
  skill_status: string;
  skill_duration_ms: number | null;
  skill_metrics_json: string | null;
  skill_error: string | null;
  skill_report_path: string | null;
  baselineResults: NormalizedResult[];
  skillResults: NormalizedResult[];
};

type Task = {
  id: number;
  kind: "manual_pr" | "baseline" | "skill_eval";
  status: string;
  current_item: number;
  total_items: number;
  status_message: string;
  error: string | null;
  created_at: string;
};

type BaselineSummary = AggregateSummary & { profileId: number };
type SkillSummary = AggregateSummary & {
  skillId: number;
  model: string;
  modelSecondary: string;
  contextTier: string;
};

type Workspace = {
  repository: Repository;
  pullRequests: PullRequest[];
  tasks: Task[];
  baselineProfiles: BaselineProfile[];
  personalSkills: PersonalSkill[];
  baselineResults: NormalizedResult[];
  skillResults: NormalizedResult[];
  skillAnalysisResults: SkillAnalysis[];
  skillAnalysisJobs: SkillAnalysisJob[];
  baselineSummaries: BaselineSummary[];
  skillSummaries: SkillSummary[];
};

type ReviewSettings = {
  model: string;
  modelSecondary: string;
  contextTier: "default" | "long_context";
  baselineConcurrency: number;
  localRepoPath: string;
  localRepoBranch: string;
};

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

function parsedMetric(
  json: string | null,
  variant: "baseline" | "skill",
) {
  if (!json) return null;
  try {
    const root = JSON.parse(json) as Record<string, unknown>;
    return variant === "skill"
      ? (root.skilled as Record<string, unknown> | undefined) ?? root
      : root;
  } catch {
    return null;
  }
}

function creditLabel(
  json: string | null,
  variant: "baseline" | "skill",
) {
  const value = parsedMetric(json, variant);
  if (!value) return "—";
  const earned =
    typeof value.earnedPoints === "number"
      ? value.earnedPoints
      : Number(value.truePositives ?? 0);
  const available =
    typeof value.availablePoints === "number"
      ? value.availablePoints
      : earned + Number(value.falseNegatives ?? 0);
  return available > 0 ? `${earned}/${available}` : "N/A";
}

function sortableCredits(
  result: NormalizedResult | undefined,
  variant: "baseline" | "skill",
) {
  if (!result || result.status !== "completed") return null;
  const value = parsedMetric(result.metrics_json, variant);
  if (!value) return null;
  const earned = Number(value.earnedPoints ?? value.truePositives ?? 0);
  const available = Number(
    value.availablePoints ?? earned + Number(value.falseNegatives ?? 0),
  );
  return available > 0 ? earned : null;
}

function reviewResultRank(result: NormalizedResult | undefined) {
  if (!result) return 4;
  return (
    {
      completed: 0,
      running: 1,
      pending: 2,
      failed: 3,
    }[result.status] ?? 4
  );
}

function skillAnalysisRank(
  result: NormalizedResult | undefined,
  analysis: SkillAnalysis | undefined,
) {
  if (!result || result.status !== "completed") return 8;
  if (!result.metrics_json) return 7;
  if (!skillHasMissedScore(result)) return 0;
  if (analysis?.applied_at) return 1;
  return (
    {
      completed: 2,
      running: 3,
      pending: 4,
      failed: 6,
    }[analysis?.status ?? ""] ?? 5
  );
}

function skillHasMissedScore(result: NormalizedResult | undefined) {
  const metric = parsedMetric(result?.metrics_json ?? null, "skill");
  if (!result || result.status !== "completed" || !metric) return false;
  const earned = Number(metric.earnedPoints ?? metric.truePositives ?? 0);
  const available = Number(
    metric.availablePoints ?? earned + Number(metric.falseNegatives ?? 0),
  );
  return available > earned;
}

function skillHasEarnedCredit(result: NormalizedResult | undefined) {
  const metric = parsedMetric(result?.metrics_json ?? null, "skill");
  if (!result || result.status !== "completed" || !metric) return false;
  return Number(metric.earnedPoints ?? metric.truePositives ?? 0) > 0;
}

function baselineHasEarnedCredit(result: NormalizedResult | undefined) {
  const metric = parsedMetric(result?.metrics_json ?? null, "baseline");
  if (!result || result.status !== "completed" || !metric) return false;
  return Number(metric.earnedPoints ?? metric.truePositives ?? 0) > 0;
}

function parsedAnalysis(
  analysisJson: string | null,
  proposalJson: string | null,
) {
  if (!analysisJson) return null;
  try {
    const analysis = JSON.parse(analysisJson) as AnalysisDetails;
    const proposal = proposalJson
      ? (JSON.parse(proposalJson) as AnalysisDetails["edits"])
      : analysis.edits;
    return { ...analysis, edits: proposal };
  } catch {
    return null;
  }
}

function displayedAnalysisError(analysis: SkillAnalysis) {
  const error = analysis.application_error ?? analysis.error;
  if (
    analysis.application_error &&
    error?.includes("is stale or not unique")
  ) {
    return "Apply stopped because the skill file changed after this analysis, or the proposed target text is not unique. This is not caused by another Analyze job. Run Analyze again to create a proposal for the current file.";
  }
  return error;
}

function seconds(value: number | null) {
  return value == null ? "—" : `${(value / 1000).toFixed(1)}s`;
}

function contextLabel(value: string) {
  return value === "long_context" ? "1M" : "400K";
}

function profileLabel(profile: BaselineProfile) {
  return (
    profile.name?.trim() ||
    `${modelLabel(profile.model)} + ${modelLabel(profile.model_secondary)} · ${contextLabel(profile.context_tier)}`
  );
}

function isNativeWzReviewSkill(skill: PersonalSkill) {
  return skill.path.replaceAll("\\", "/").toLowerCase().endsWith("/wz-review");
}

function skillExecutionLabel(
  skill: PersonalSkill,
  settings: Pick<ReviewSettings, "model" | "modelSecondary" | "contextTier">,
) {
  if (isNativeWzReviewSkill(skill)) {
    return "Native workflow · models selected internally";
  }
  return `${modelLabel(settings.model)}${
    settings.modelSecondary !== "none"
      ? ` + ${modelLabel(settings.modelSecondary)}`
      : ""
  } · ${contextLabel(settings.contextTier)}`;
}

function analysisJobPullRequestIds(job: SkillAnalysisJob) {
  try {
    const value = JSON.parse(job.pr_ids_json) as unknown;
    return Array.isArray(value)
      ? value.filter((id): id is number => Number.isInteger(id))
      : [];
  } catch {
    return [];
  }
}

function skillResultFor(
  pullRequest: PullRequest,
  skill: PersonalSkill | undefined,
  settings: {
    model: string;
    modelSecondary: string;
    contextTier: string;
  },
) {
  if (!skill) return undefined;
  const candidates = pullRequest.skillResults.filter(
    (result) => result.skill_id === skill.id,
  );
  const exact = candidates.find(
    (result) =>
      result.model === settings.model &&
      result.model_secondary === settings.modelSecondary &&
      result.context_tier === settings.contextTier,
  );
  if (exact || !isNativeWzReviewSkill(skill)) return exact;
  return candidates.reduce<NormalizedResult | undefined>(
    (latest, result) => (!latest || result.id > latest.id ? result : latest),
    undefined,
  );
}

function summarizeFilteredResults(
  pullRequests: PullRequest[],
  resultFor: (pullRequest: PullRequest) => NormalizedResult | undefined,
  variant: "baseline" | "skill",
): AggregateSummary {
  const results = pullRequests
    .map(resultFor)
    .filter((result): result is NormalizedResult => Boolean(result));
  const availablePoints = pullRequests.reduce(
    (sum, pullRequest) => sum + pullRequest.available_points,
    0,
  );
  return summarizeComparisonResults(
    results.map((result) => {
      const metrics = parsedMetric(result.metrics_json, variant);
      return {
        status: result.status,
        earnedPoints: Number(metrics?.earnedPoints ?? metrics?.truePositives ?? 0),
      };
    }),
    pullRequests.length,
    availablePoints,
  );
}

function confirmRemoval(item: string) {
  if (!window.confirm(`Remove ${item}?`)) return false;
  return window.confirm(
    `Confirm removal of ${item}. This is the final confirmation.`,
  );
}

export default function RepositoryWorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<Workspace | null>(null);
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings | null>(
    null,
  );
  const [selectedProfileIds, setSelectedProfileIds] = useState<number[] | null>(
    null,
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState<number[] | null>(
    null,
  );
  const [skillName, setSkillName] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [skillFormMessage, setSkillFormMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [profileSecondModelEnabled, setProfileSecondModelEnabled] =
    useState(false);
  const [profileFormMessage, setProfileFormMessage] = useState<string | null>(
    null,
  );
  const [profileModel, setProfileModel] = useState<string>(
    COPILOT_MODELS[0].id,
  );
  const [profileModelSecondary, setProfileModelSecondary] =
    useState<string>("none");
  const [profileContext, setProfileContext] = useState<
    "default" | "long_context"
  >("default");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prSearch, setPrSearch] = useState("");
  const [prPathFilter, setPrPathFilter] = useState<string | null>(null);
  const [prPathFilterEnabled, setPrPathFilterEnabled] = useState(true);
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [showReviewedOnly, setShowReviewedOnly] = useState(false);
  const [pageSizeInput, setPageSizeInput] = useState("20");
  const [currentPage, setCurrentPage] = useState(1);
  const [sortKey, setSortKey] = useState("pr-number");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [analysisModal, setAnalysisModal] = useState<{
    prNumber: number;
    prTitle: string;
    skillName: string;
    applied: boolean;
    details: AnalysisDetails;
  } | null>(null);
  const skillSelectionStorageKey = `repository-${id}-selected-skill-ids`;
  const profileSelectionStorageKey =
    `repository-${id}-selected-profile-ids`;
  const pathFilterStorageKey = `repository-${id}-pr-path-filter`;
  const pathFilterEnabledStorageKey =
    `repository-${id}-pr-path-filter-enabled`;
  const showSelectedStorageKey = `repository-${id}-show-selected-prs`;
  const showReviewedStorageKey = `repository-${id}-show-reviewed-prs`;

  const persistSkillSelection = useCallback(
    (skillIds: number[]) => {
      window.localStorage.setItem(
        skillSelectionStorageKey,
        JSON.stringify(skillIds),
      );
    },
    [skillSelectionStorageKey],
  );
  const persistProfileSelection = useCallback(
    (profileIds: number[]) => {
      window.localStorage.setItem(
        profileSelectionStorageKey,
        JSON.stringify(profileIds),
      );
    },
    [profileSelectionStorageKey],
  );

  useEffect(() => {
    const initialize = window.setTimeout(() => {
      setPrPathFilter(window.localStorage.getItem(pathFilterStorageKey));
      setPrPathFilterEnabled(
        window.localStorage.getItem(pathFilterEnabledStorageKey) !== "false",
      );
      setShowSelectedOnly(
        window.localStorage.getItem(showSelectedStorageKey) === "true",
      );
      setShowReviewedOnly(
        window.localStorage.getItem(showReviewedStorageKey) === "true",
      );
    }, 0);
    return () => window.clearTimeout(initialize);
  }, [
    pathFilterEnabledStorageKey,
    pathFilterStorageKey,
    showReviewedStorageKey,
    showSelectedStorageKey,
  ]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/repositories/${id}/workspace`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Unable to load PR workspace");
      const workspace = (await response.json()) as Workspace;
      setData(workspace);
      setReviewSettings((current) =>
        current ?? {
          model: workspace.repository.model,
          modelSecondary: workspace.repository.model_secondary,
          contextTier: workspace.repository.context_tier as
            | "default"
            | "long_context",
          baselineConcurrency: workspace.repository.baseline_concurrency,
          localRepoPath: workspace.repository.local_repo_path ?? "",
          localRepoBranch: workspace.repository.local_repo_branch ?? "",
        },
      );
      setSelectedProfileIds((current) =>
        (() => {
          const available = new Set(
            workspace.baselineProfiles.map((profile) => profile.id),
          );
          if (current !== null) {
            return current.filter((profileId) => available.has(profileId));
          }
          try {
            const stored = JSON.parse(
              window.localStorage.getItem(profileSelectionStorageKey) ??
                "null",
            ) as unknown;
            if (Array.isArray(stored)) {
              return stored
                .filter((profileId): profileId is number =>
                  Number.isInteger(profileId),
                )
                .filter((profileId) => available.has(profileId));
            }
          } catch {
            // Fall back to selecting all profiles on the first visit.
          }
          return workspace.baselineProfiles.map((profile) => profile.id);
        })(),
      );
      setSelectedSkillIds((current) =>
        (() => {
          const available = new Set(
            workspace.personalSkills.map((skill) => skill.id),
          );
          if (current !== null) {
            return current.filter((skillId) => available.has(skillId));
          }
          try {
            const stored = JSON.parse(
              window.localStorage.getItem(skillSelectionStorageKey) ?? "null",
            ) as unknown;
            if (Array.isArray(stored)) {
              return stored
                .filter((skillId): skillId is number =>
                  Number.isInteger(skillId),
                )
                .filter((skillId) => available.has(skillId));
            }
          } catch {
            // Fall back to selecting all skills on the first visit.
          }
          return workspace.personalSkills.map((skill) => skill.id);
        })(),
      );
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [id, profileSelectionStorageKey, skillSelectionStorageKey]);

  async function refreshScore() {
    setBusy("refresh-score");
    try {
      if (await refresh()) {
        setMessage("Aggregate score refreshed from the selected PR results.");
      }
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!analysisModal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnalysisModal(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [analysisModal]);

  const selectedPrIds = useMemo(
    () =>
      data?.pullRequests.filter((pr) => pr.selected).map((pr) => pr.id) ?? [],
    [data],
  );
  const effectivePathFilter = prPathFilter ?? "";
  const pathFilteredPullRequests = useMemo(() => {
    const pullRequests = data?.pullRequests ?? [];
    if (!prPathFilterEnabled) return pullRequests;
    const filters = parsePathFilters(effectivePathFilter);
    if (filters.length === 0) return pullRequests;
    return pullRequests.filter((pr) =>
      pr.changed_paths.some((filePath) =>
        pathMatchesFilters(filePath, filters),
      ),
    );
  }, [data, effectivePathFilter, prPathFilterEnabled]);
  const selectedPathFilteredPullRequests = useMemo(
    () => pathFilteredPullRequests.filter((pr) => pr.selected),
    [pathFilteredPullRequests],
  );
  const selectedPathFilteredPrIds = useMemo(
    () => selectedPathFilteredPullRequests.map((pr) => pr.id),
    [selectedPathFilteredPullRequests],
  );
  const allPathFilteredSelected =
    pathFilteredPullRequests.length > 0 &&
    selectedPathFilteredPrIds.length === pathFilteredPullRequests.length;
  const controlFilteredPullRequests = useMemo(() => {
    const query = prSearch.trim().replace(/^#/, "");
    return pathFilteredPullRequests.filter(
      (pr) =>
        (!showSelectedOnly || Boolean(pr.selected)) &&
        (!showReviewedOnly ||
          pr.baseline_status === "completed" ||
          pr.skill_status === "completed" ||
          pr.baselineResults.some((result) => result.status === "completed") ||
          pr.skillResults.some((result) => result.status === "completed")) &&
        (!query || String(pr.number).includes(query)),
    );
  }, [
    pathFilteredPullRequests,
    prSearch,
    showReviewedOnly,
    showSelectedOnly,
  ]);
  const aggregatePullRequests = useMemo(
    () => controlFilteredPullRequests.filter((pr) => pr.selected),
    [controlFilteredPullRequests],
  );
  const filteredBaselineSummaries = useMemo(
    () =>
      (data?.baselineProfiles ?? []).map((profile) => ({
        profileId: profile.id,
        ...summarizeFilteredResults(
          aggregatePullRequests,
          (pullRequest) =>
            pullRequest.baselineResults.find(
              (result) => result.profile_id === profile.id,
            ),
          "baseline",
        ),
      })),
    [aggregatePullRequests, data],
  );
  const filteredSkillSummaries = useMemo(() => {
    const model = reviewSettings?.model ?? data?.repository.model;
    const modelSecondary =
      reviewSettings?.modelSecondary ?? data?.repository.model_secondary;
    const contextTier =
      reviewSettings?.contextTier ?? data?.repository.context_tier;
    return (data?.personalSkills ?? []).map((skill) => ({
      skillId: skill.id,
      model: model ?? "",
      modelSecondary: modelSecondary ?? "",
      contextTier: contextTier ?? "",
      ...summarizeFilteredResults(
        aggregatePullRequests,
        (pullRequest) =>
          skillResultFor(pullRequest, skill, {
            model: model ?? "",
            modelSecondary: modelSecondary ?? "",
            contextTier: contextTier ?? "",
          }),
        "skill",
      ),
    }));
  }, [aggregatePullRequests, data, reviewSettings]);
  const pageSize = Math.min(
    500,
    Math.max(1, Number.parseInt(pageSizeInput, 10) || 20),
  );
  const filteredPullRequests = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    const reviewModel = reviewSettings?.model ?? data?.repository.model;
    const reviewModelSecondary =
      reviewSettings?.modelSecondary ?? data?.repository.model_secondary;
    const reviewContext =
      reviewSettings?.contextTier ?? data?.repository.context_tier;
    return [...controlFilteredPullRequests].sort((left, right) => {
      if (sortKey === "pr-number") {
        return (left.number - right.number) * direction;
      }
      const [kind, column, rawId] = sortKey.split(":");
      const configurationId = Number(rawId);
      const leftResult =
        kind === "baseline"
          ? left.baselineResults.find(
              (result) => result.profile_id === configurationId,
            )
          : skillResultFor(
              left,
              data?.personalSkills.find(
                (skill) => skill.id === configurationId,
              ),
              {
                model: reviewModel ?? "",
                modelSecondary: reviewModelSecondary ?? "",
                contextTier: reviewContext ?? "",
              },
            );
      const rightResult =
        kind === "baseline"
          ? right.baselineResults.find(
              (result) => result.profile_id === configurationId,
            )
          : skillResultFor(
              right,
              data?.personalSkills.find(
                (skill) => skill.id === configurationId,
              ),
              {
                model: reviewModel ?? "",
                modelSecondary: reviewModelSecondary ?? "",
                contextTier: reviewContext ?? "",
              },
            );
      if (column === "result") {
        const difference =
          reviewResultRank(leftResult) - reviewResultRank(rightResult);
        return difference === 0
          ? left.number - right.number
          : difference * direction;
      }
      if (kind === "skill" && column === "analysis") {
        const findAnalysis = (pullRequestId: number) =>
          data?.skillAnalysisResults.find(
            (analysis) =>
              analysis.skill_id === configurationId &&
              analysis.pull_request_id === pullRequestId &&
              analysis.model === reviewModel &&
              analysis.model_secondary === reviewModelSecondary &&
              analysis.context_tier === reviewContext,
          );
        const difference =
          skillAnalysisRank(leftResult, findAnalysis(left.id)) -
          skillAnalysisRank(rightResult, findAnalysis(right.id));
        return difference === 0
          ? left.number - right.number
          : difference * direction;
      }
      const variant = kind === "baseline" ? "baseline" : "skill";
      const leftCredits = sortableCredits(leftResult, variant);
      const rightCredits = sortableCredits(rightResult, variant);
      if (leftCredits === null && rightCredits === null) {
        return left.number - right.number;
      }
      if (leftCredits === null) return 1;
      if (rightCredits === null) return -1;
      if (leftCredits === rightCredits) return left.number - right.number;
      return (leftCredits - rightCredits) * direction;
    });
  }, [
    controlFilteredPullRequests,
    data,
    reviewSettings,
    sortDirection,
    sortKey,
  ]);
  const pageCount = Math.max(
    1,
    Math.ceil(filteredPullRequests.length / pageSize),
  );
  const displayedPage = Math.min(currentPage, pageCount);
  const paginatedPullRequests = useMemo(() => {
    const start = (displayedPage - 1) * pageSize;
    return filteredPullRequests.slice(start, start + pageSize);
  }, [displayedPage, filteredPullRequests, pageSize]);

  const activeTasks =
    data?.tasks.filter((task) =>
      ["queued", "running", "cancelling"].includes(task.status),
    ) ?? [];
  const activeSkillTask = activeTasks.find((task) => task.kind === "skill_eval");
  const activeManualTask = activeTasks.find((task) => task.kind === "manual_pr");
  const activeReviewTasks = activeTasks.filter(
    (task) => task.kind === "baseline" || task.kind === "skill_eval",
  );
  const selectionLocked =
    activeReviewTasks.length > 0 || busy === "evaluate";
  const configurationLocked = selectionLocked;
  const activeAnalysisJobs =
    data?.skillAnalysisJobs.filter((job) =>
      ["queued", "running"].includes(job.status),
    ) ?? [];
  const prioritizedActiveTasks = [...activeTasks, ...activeAnalysisJobs].sort(
    (left, right) =>
      new Date(right.created_at).getTime() -
      new Date(left.created_at).getTime(),
  );

  function toggleSort(key: string, initialDirection: "asc" | "desc") {
    if (sortKey === key) {
      setSortDirection((direction) =>
        direction === "asc" ? "desc" : "asc",
      );
    } else {
      setSortKey(key);
      setSortDirection(initialDirection);
    }
    setCurrentPage(1);
  }

  function sortIndicator(key: string) {
    if (sortKey !== key) return "\u2195";
    return sortDirection === "asc" ? "\u2191" : "\u2193";
  }

  async function updatePr(
    prId: number,
    body: { selected?: boolean; defectDescription?: string },
  ) {
    await api(`/api/pull-requests/${prId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refresh();
  }

  async function selectAll(selected: boolean) {
    if (!data || selectionLocked) return;
    setBusy("select");
    try {
      await Promise.all(
        pathFilteredPullRequests.map((pr) =>
          api(`/api/pull-requests/${pr.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ selected }),
          }),
        ),
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function addSkill(event: FormEvent) {
    event.preventDefault();
    setBusy("add-skill");
    setMessage(null);
    setSkillFormMessage(null);
    try {
      const result = await api(`/api/repositories/${id}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skillName, path: skillPath }),
      });
      const skill = result.skill as PersonalSkill;
      setSelectedSkillIds((current) => {
        const next = [...new Set([...(current ?? []), skill.id])];
        persistSkillSelection(next);
        return next;
      });
      setSkillName("");
      setSkillPath("");
      setSkillFormMessage({
        kind: "success",
        text: `Personal skill "${skill.name}" saved.`,
      });
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setSkillFormMessage({ kind: "error", text });
      setMessage(text);
    } finally {
      setBusy(null);
    }
  }

  async function removeSkill(skill: PersonalSkill) {
    if (!confirmRemoval(`personal skill "${skill.name}"`)) return;
    setBusy(`remove-skill-${skill.id}`);
    try {
      await api(`/api/repositories/${id}/skills/${skill.id}`, {
        method: "DELETE",
      });
      setSelectedSkillIds((current) => {
        const next = (current ?? []).filter(
          (skillId) => skillId !== skill.id,
        );
        persistSkillSelection(next);
        return next;
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function addProfile(event: FormEvent) {
    event.preventDefault();
    const name = profileName.trim();
    const modelSecondary = profileSecondModelEnabled
      ? profileModelSecondary
      : "none";
    if (!name) {
      setProfileFormMessage("Profile name is required.");
      return;
    }
    const duplicateName = data?.baselineProfiles.find(
      (profile) => profile.name?.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicateName) {
      setProfileFormMessage(
        `A baseline profile named "${name}" already exists.`,
      );
      return;
    }
    const duplicateSettings = data?.baselineProfiles.find(
      (profile) =>
        profile.model === profileModel &&
        profile.model_secondary === modelSecondary &&
        profile.context_tier === profileContext,
    );
    if (duplicateSettings) {
      setProfileFormMessage(
        `The same model and context settings are already used by "${profileLabel(duplicateSettings)}".`,
      );
      return;
    }
    setBusy("add-profile");
    setMessage(null);
    setProfileFormMessage(null);
    try {
      const result = await api(
        `/api/repositories/${id}/baseline-profiles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            model: profileModel,
            modelSecondary,
            contextTier: profileContext,
          }),
        },
      );
      const profile = result.profile as BaselineProfile;
      setSelectedProfileIds((current) => {
        const next = [...new Set([...(current ?? []), profile.id])];
        persistProfileSelection(next);
        return next;
      });
      closeProfileForm();
      setMessage(`Baseline profile "${profileLabel(profile)}" saved.`);
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setProfileFormMessage(text);
      setMessage(text);
    } finally {
      setBusy(null);
    }
  }

  function closeProfileForm() {
    setProfileFormOpen(false);
    setProfileSecondModelEnabled(false);
    setProfileName("");
    setProfileModel(COPILOT_MODELS[0].id);
    setProfileModelSecondary("none");
    setProfileContext("default");
    setProfileFormMessage(null);
  }

  async function removeProfile(profile: BaselineProfile) {
    if (
      !confirmRemoval(`baseline profile "${profileLabel(profile)}"`)
    ) {
      return;
    }
    setBusy(`remove-profile-${profile.id}`);
    try {
      await api(
        `/api/repositories/${id}/baseline-profiles/${profile.id}`,
        { method: "DELETE" },
      );
      setSelectedProfileIds((current) => {
        const next = (current ?? []).filter(
          (profileId) => profileId !== profile.id,
        );
        persistProfileSelection(next);
        return next;
      });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveReviewSettings(showMessage = true) {
    if (!reviewSettings) return;
    const response = await api(`/api/repositories/${id}/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewSettings),
    });
    setData((current) =>
      current
        ? { ...current, repository: response.repository as Repository }
        : current,
    );
    if (showMessage) setMessage("Review settings saved.");
  }

  async function saveHistoryReports() {
    setBusy("save-report");
    setMessage(null);
    try {
      if (!data) throw new Error("The PR workspace is not loaded.");
      const result = await api(`/api/repositories/${id}/history-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pullRequestIds: pathFilteredPullRequests.map((pr) => pr.id),
          skillIds: selectedSkillIds ?? [],
          applyPathFilter: prPathFilterEnabled,
          pathFilter: effectivePathFilter,
          model: reviewSettings?.model ?? data.repository.model,
          modelSecondary:
            reviewSettings?.modelSecondary ?? data.repository.model_secondary,
          contextTier: reviewSettings?.contextTier ?? data.repository.context_tier,
        }),
      });
      setMessage(
        `Snapshot ${result.snapshot.name} saved to HistoryReports.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function startReview() {
    if (selectedPathFilteredPrIds.length === 0) {
      setMessage(
        prPathFilterEnabled
          ? "Select at least one PR matching the path filter."
          : "Select at least one PR.",
      );
      return;
    }
    const profileIds = selectedProfileIds ?? [];
    const skillIds = selectedSkillIds ?? [];
    if (profileIds.length === 0 && skillIds.length === 0) {
      setMessage("Select at least one baseline profile or personal skill.");
      return;
    }
    if (
      !window.confirm(
        `Are you going to review the selected ${selectedPathFilteredPrIds.length} PRs for the ${skillIds.length} skills? This will also run ${profileIds.length} selected baseline profiles.`,
      )
    ) {
      return;
    }
    setBusy("evaluate");
    setMessage(null);
    try {
      await saveReviewSettings(false);
      persistProfileSelection(profileIds);
      persistSkillSelection(skillIds);
      const requestBody = {
        pullRequestIds: selectedPathFilteredPrIds,
        applyPathFilter: prPathFilterEnabled,
        pathFilter: effectivePathFilter,
        concurrency:
          reviewSettings?.baselineConcurrency ??
          data?.repository.baseline_concurrency ??
          5,
      };
      const [baselineResult, skillResult] = await Promise.all([
        profileIds.length > 0
          ? api(`/api/repositories/${id}/baseline`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...requestBody, profileIds }),
            })
          : Promise.resolve(null),
        skillIds.length > 0
          ? api(`/api/repositories/${id}/evaluate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...requestBody, skillIds }),
            })
          : Promise.resolve(null),
      ]);
      setMessage(
        `${profileIds.length} baseline profile(s) and ${skillIds.length} personal skill(s) queued for ${baselineResult?.queuedPullRequests ?? skillResult?.queuedPullRequests ?? 0} path-matching PR(s).`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancelActiveReviews() {
    if (activeReviewTasks.length === 0) return;
    if (!window.confirm("Cancel the active PR review?")) return;
    setBusy("cancel-review");
    setMessage(null);
    try {
      await Promise.all(
        activeReviewTasks.map((task) =>
          api(
            `/api/repositories/${id}/workflow-tasks/${task.id}/cancel`,
            { method: "POST" },
          ),
        ),
      );
      setMessage("PR review cancellation requested.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function retryResult(
    kind: "baseline" | "evaluate",
    pullRequestId: number,
    configurationId: number,
  ) {
    const key = `retry-${kind}-${pullRequestId}-${configurationId}`;
    setBusy(key);
    setMessage(null);
    try {
      await saveReviewSettings(false);
      await api(`/api/repositories/${id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pullRequestIds: [pullRequestId],
          applyPathFilter: prPathFilterEnabled,
          pathFilter: effectivePathFilter,
          ...(kind === "baseline"
            ? { profileIds: [configurationId] }
            : { skillIds: [configurationId] }),
          concurrency: 1,
        }),
      });
      setMessage(
        `${kind === "baseline" ? "Baseline" : "Skill"} retry queued.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeSkill(
    skill: PersonalSkill,
    pullRequestIds: number[],
    applyAll = false,
    resultIds?: number[],
  ) {
    if (pullRequestIds.length === 0) {
      setMessage("This skill already has full scores for all completed PRs.");
      return;
    }
    if (
      applyAll &&
      !window.confirm(
        `Analyze ${pullRequestIds.length} missed-score PRs and apply safe mitigations to "${skill.name}"? The original files will be backed up.`,
      )
    ) {
      return;
    }
    const key = applyAll
      ? `analyze-apply-${skill.id}`
      : `analyze-${skill.id}-${pullRequestIds[0]}`;
    setBusy(key);
    setMessage(null);
    try {
      await api(`/api/repositories/${id}/skill-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: applyAll ? "analyze_apply_all" : "analyze",
          skillId: skill.id,
          pullRequestIds,
          resultIds,
        }),
      });
      setMessage(
        applyAll
          ? `Analyze and Apply All queued for "${skill.name}".`
          : `Analysis queued for "${skill.name}".`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function applyAnalysis(analysis: SkillAnalysis, skillName: string) {
    if (
      !window.confirm(
        `Apply the proposed mitigation to "${skillName}"? The current files will be backed up first.`,
      )
    ) {
      return;
    }
    setBusy(`apply-analysis-${analysis.id}`);
    setMessage(null);
    try {
      await api(`/api/skill-analysis-results/${analysis.id}/apply`, {
        method: "POST",
      });
      setMessage(`Mitigation applied to "${skillName}".`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <main className="prWorkspace">
        <div className="panel loadingPanel">Loading PR workspace…</div>
      </main>
    );
  }

  const currentSettings = reviewSettings ?? {
    model: data.repository.model,
    modelSecondary: data.repository.model_secondary,
    contextTier: data.repository.context_tier as "default" | "long_context",
    baselineConcurrency: data.repository.baseline_concurrency,
    localRepoPath: data.repository.local_repo_path ?? "",
    localRepoBranch: data.repository.local_repo_branch ?? "",
  };
  const selectedSkills = data.personalSkills.filter((skill) =>
    (selectedSkillIds ?? []).includes(skill.id),
  );
  const invocationPath =
    selectedSkills.length === 1 ? selectedSkills[0].path : "<each selected skill>";
  const invocation = `copilot -p "Review the downloaded PR snapshot and return structured findings" --model ${currentSettings.model} --context ${currentSettings.contextTier} --add-dir "${invocationPath}"${
    data.repository.local_repo_path
      ? ' --add-dir "<detached PR head worktree>"'
      : ""
  }`;

  return (
    <main className="prWorkspace">
      <PageNavigation
        previous={{
          href: `/repositories/${id}/pr-set-view`,
          label: "PR Set View",
        }}
        next={{
          href: `/repositories/${id}/history-reports`,
          label: "History Reports",
        }}
      />
      <header className="workspaceHeader">
        <div>
          <span className="eyebrow">Multi-skill PR review matrix</span>
          <h1>{data.repository.display_name}</h1>
          <p>
            {data.repository.provider} · {modelLabel(currentSettings.model)}
            {currentSettings.modelSecondary !== "none"
              ? ` + ${modelLabel(currentSettings.modelSecondary)}`
              : ""}{" "}
            · {contextLabel(currentSettings.contextTier)}
          </p>
        </div>
        <div className="selectionCount">
          <strong>
            {prPathFilterEnabled
              ? selectedPathFilteredPrIds.length
              : selectedPrIds.length}
          </strong>
          <span>
            selected of{" "}
            {prPathFilterEnabled
              ? pathFilteredPullRequests.length
              : data.pullRequests.length}
          </span>
        </div>
      </header>

      {message && <div className="notice">{message}</div>}

      <section className="panel reviewSettingsPanel">
        <div className="panelHeading">
          <div>
            <span className="step">Review execution</span>
            <h2>Two-model orchestration</h2>
          </div>
          <span className="badge">Repository scoped</span>
        </div>
        <div className="reviewSettingsGrid">
          <label className="localRepoSetting">
            Local repository path · required
            <input
              placeholder="Q:\path\to\configured\repository"
              value={currentSettings.localRepoPath}
              onChange={(event) =>
                setReviewSettings({
                  ...currentSettings,
                  localRepoPath: event.target.value,
                })
              }
            />
            <small>
              Baseline and skill reviews use only a detached worktree at the
              recorded PR commit. Remote and later-code access is disabled.
            </small>
            {!data.repository.local_repo_path && (
              <small className="localRepoWarning">
                Save a verified local repository path before starting reviews.
              </small>
            )}
            {data.repository.local_repo_warning && (
              <small className="localRepoWarning">
                {data.repository.local_repo_warning}
              </small>
            )}
          </label>
          <label className="localRepoSetting">
            Evaluation branch name · required
            <input
              placeholder="For example: origin/master or users/name/branch"
              value={currentSettings.localRepoBranch}
              onChange={(event) =>
                setReviewSettings({
                  ...currentSettings,
                  localRepoBranch: event.target.value,
                })
              }
            />
            <small>
              Used only to locate each PR&apos;s verified merge commit. The
              branch and your working tree are never checked out or modified.
            </small>
            {data.repository.local_repo_path &&
              !data.repository.local_repo_branch && (
                <small className="localRepoWarning">
                  Select and save the branch used for this evaluation.
                </small>
              )}
          </label>
          <label>
            Model 1 · reviewer + orchestrator
            <select
              value={currentSettings.model}
              onChange={(event) =>
                setReviewSettings({
                  ...currentSettings,
                  model: event.target.value,
                })
              }
            >
              {COPILOT_MODELS.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label} · {model.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model 2 · reviewer
            <select
              value={currentSettings.modelSecondary}
              onChange={(event) =>
                setReviewSettings({
                  ...currentSettings,
                  modelSecondary: event.target.value,
                })
              }
            >
              {OPTIONAL_COPILOT_MODELS.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label} · {model.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Orchestration context
            <select
              value={currentSettings.contextTier}
              onChange={(event) =>
                setReviewSettings({
                  ...currentSettings,
                  contextTier: event.target.value as
                    | "default"
                    | "long_context",
                })
              }
            >
              <option value="default">400K · default tier</option>
              <option value="long_context">1M · long context tier</option>
            </select>
          </label>
        </div>
        <div className="settingsFooter">
          <small>
            These settings control personal-skill review execution. Baseline
            profiles use their own model and context settings.
          </small>
          <button
            className="secondaryButton"
            disabled={busy === "settings"}
            onClick={() => {
              setBusy("settings");
              void saveReviewSettings()
                .catch((error) =>
                  setMessage(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setBusy(null));
            }}
          >
            Save review settings
          </button>
        </div>
      </section>

      <section className="panel invocationPanel">
        <div>
          <span className="step">Skill invocation</span>
          <p>
            Model 1 receives each selected named skill independently.
            {" "}Every baseline and skill receives the same detached PR-commit
            worktree. Remote repositories and code after that commit are not
            available to the review tools.
          </p>
        </div>
        <code>{invocation}</code>
      </section>

      <section className="configurationGrid">
        <article className="panel configurationPanel">
          <div className="panelHeading">
            <div>
              <span className="step">Baselines</span>
              <h2>Orchestrated baseline profiles</h2>
            </div>
            <div>
              <span className="badge">{data.baselineProfiles.length}</span>
              {!profileFormOpen && (
                <button
                  type="button"
                  className="secondaryButton compact"
                  disabled={configurationLocked}
                  onClick={() => {
                    setProfileFormOpen(true);
                    setProfileFormMessage(null);
                  }}
                >
                  Add profile
                </button>
              )}
            </div>
          </div>
          {profileFormOpen && (
            <form className="profileEditor" onSubmit={addProfile}>
              <label>
                Profile name *
                <input
                  required
                  maxLength={100}
                  placeholder="Profile display name"
                  value={profileName}
                  onChange={(event) => {
                    setProfileName(event.target.value);
                    setProfileFormMessage(null);
                  }}
                />
              </label>
              <div className="profileModelFields">
                <label>
                  Model 1 *
                  <select
                    required
                    value={profileModel}
                    onChange={(event) => {
                      setProfileModel(event.target.value);
                      setProfileFormMessage(null);
                    }}
                  >
                    {COPILOT_MODELS.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                {profileSecondModelEnabled && (
                  <label>
                    Model 2 *
                    <select
                      required
                      value={profileModelSecondary}
                      onChange={(event) => {
                        setProfileModelSecondary(event.target.value);
                        setProfileFormMessage(null);
                      }}
                    >
                      {OPTIONAL_COPILOT_MODELS.filter(
                        (model) => model.id !== "none",
                      ).map((model) => (
                        <option value={model.id} key={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Context *
                  <select
                    required
                    value={profileContext}
                    onChange={(event) => {
                      setProfileContext(
                        event.target.value as "default" | "long_context",
                      );
                      setProfileFormMessage(null);
                    }}
                  >
                    <option value="default">400K</option>
                    <option value="long_context">1M</option>
                  </select>
                </label>
              </div>
              {!profileSecondModelEnabled && (
                <button
                  type="button"
                  className="secondaryButton profileAddModelButton"
                  onClick={() => {
                    setProfileSecondModelEnabled(true);
                    setProfileModelSecondary(
                      COPILOT_MODELS.find(
                        (model) => model.id !== profileModel,
                      )?.id ?? COPILOT_MODELS[0].id,
                    );
                    setProfileFormMessage(null);
                  }}
                >
                  Add Model
                </button>
              )}
              {profileFormMessage && (
                <p className="configurationInlineMessage error" role="alert">
                  {profileFormMessage}
                </p>
              )}
              <div className="profileEditorActions">
                <button
                  className="primaryButton compact"
                  disabled={busy === "add-profile"}
                >
                  {busy === "add-profile" ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="secondaryButton compact"
                  disabled={busy === "add-profile"}
                  onClick={closeProfileForm}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          <div className="configurationList">
            {data.baselineProfiles.length === 0 && (
              <p className="configurationEmpty">Add a baseline profile.</p>
            )}
            {data.baselineProfiles.map((profile) => (
              <label className="configurationItem" key={profile.id}>
                <input
                  type="checkbox"
                  checked={(selectedProfileIds ?? []).includes(profile.id)}
                  disabled={configurationLocked}
                  onChange={(event) =>
                    setSelectedProfileIds((current) => {
                      const next = event.target.checked
                        ? [...new Set([...(current ?? []), profile.id])]
                        : (current ?? []).filter(
                            (profileId) => profileId !== profile.id,
                          );
                      persistProfileSelection(next);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{profileLabel(profile)}</strong>
                  <small>
                    {modelLabel(profile.model)} +{" "}
                    {modelLabel(profile.model_secondary)} ·{" "}
                    {contextLabel(profile.context_tier)}
                  </small>
                </span>
                <button
                  type="button"
                  className="dangerButton"
                  disabled={busy === `remove-profile-${profile.id}`}
                  onClick={() => void removeProfile(profile)}
                >
                  Remove
                </button>
              </label>
            ))}
          </div>
        </article>

        <article className="panel configurationPanel">
          <div className="panelHeading">
            <div>
              <span className="step">Skills</span>
              <h2>Personal PR review skills</h2>
            </div>
            <span className="badge">{data.personalSkills.length}</span>
          </div>
          <form className="skillConfigurationForm" onSubmit={addSkill}>
            <input
              required
              placeholder="Display name"
              value={skillName}
              onChange={(event) => {
                setSkillName(event.target.value);
                setSkillFormMessage(null);
              }}
            />
            <input
              required
              placeholder="C:\path\to\SKILL.md, skill folder, or repository root"
              value={skillPath}
              onChange={(event) => {
                setSkillPath(event.target.value);
                setSkillFormMessage(null);
              }}
            />
            <button
              className="secondaryButton"
              disabled={busy === "add-skill"}
            >
              {busy === "add-skill" ? "Adding..." : "Add skill"}
            </button>
          </form>
          {skillFormMessage && (
            <p
              className={`configurationInlineMessage ${skillFormMessage.kind}`}
              role="status"
            >
              {skillFormMessage.text}
            </p>
          )}
          <p className="configurationHint">
            Enter a SKILL.md file, its containing folder, or a repository root
            containing .github\skills.
          </p>
          <div className="configurationList">
            {data.personalSkills.length === 0 && (
              <p className="configurationEmpty">Add a personal skill.</p>
            )}
            {data.personalSkills.map((skill) => (
              <label className="configurationItem" key={skill.id}>
                <input
                  type="checkbox"
                  checked={(selectedSkillIds ?? []).includes(skill.id)}
                  disabled={configurationLocked}
                  onChange={(event) =>
                    setSelectedSkillIds((current) => {
                      const next = event.target.checked
                        ? [...new Set([...(current ?? []), skill.id])]
                        : (current ?? []).filter(
                            (skillId) => skillId !== skill.id,
                          );
                      persistSkillSelection(next);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small title={skill.path}>{skill.path}</small>
                </span>
                <button
                  type="button"
                  className="dangerButton"
                  disabled={busy === `remove-skill-${skill.id}`}
                  onClick={() => void removeSkill(skill)}
                >
                  Remove
                </button>
              </label>
            ))}
          </div>
        </article>
      </section>

      <section className="workflowActions">
        <article className="panel actionPanel">
          <div className="reviewActionGroup">
            <div className="reviewActionTitle">
              <span className="step">01</span>
              <h2>Review selected PRs</h2>
            </div>
            <label className="reviewConcurrency">
              <span>Parallel reviews</span>
              <input
                type="number"
                min={1}
                max={20}
                value={currentSettings.baselineConcurrency}
                disabled={activeReviewTasks.length > 0}
                onChange={(event) =>
                  setReviewSettings({
                    ...currentSettings,
                    baselineConcurrency: Number(event.target.value),
                  })
                }
              />
            </label>
            <button
              className={
                activeReviewTasks.length > 0
                  ? "dangerButton reviewActionButton"
                  : "primaryButton compact reviewActionButton"
              }
              disabled={
                busy === "evaluate" ||
                busy === "cancel-review" ||
                Boolean(activeManualTask) ||
                (activeReviewTasks.length === 0 &&
                  (!currentSettings.localRepoPath.trim() ||
                    !currentSettings.localRepoBranch.trim()))
              }
              onClick={() =>
                void (activeReviewTasks.length > 0
                  ? cancelActiveReviews()
                  : startReview())
              }
            >
              {busy === "cancel-review"
                ? "Cancelling..."
                : activeReviewTasks.length > 0
                  ? "Cancel PR Review"
                  : currentSettings.localRepoPath.trim() &&
                      currentSettings.localRepoBranch.trim()
                    ? "Review PR"
                    : "Set local repository path and branch first"}
            </button>
          </div>
          <p>
            Run selected baseline profiles and personal skills independently.
            Personal skills are scored directly against the expected defects.
          </p>
        </article>
      </section>

      <ComparisonMatrix
        emptyMessage="Select at least one baseline profile or personal skill to show its score for the selected PRs."
        rows={[
          ...data.baselineProfiles
            .filter((profile) =>
              (selectedProfileIds ?? []).includes(profile.id),
            )
            .map((profile) => ({
              id: `profile-${profile.id}`,
              name: profileLabel(profile),
              description: `${modelLabel(profile.model)} + ${modelLabel(profile.model_secondary)} · ${contextLabel(profile.context_tier)}`,
              kind: "baseline" as const,
              summary: filteredBaselineSummaries.find(
                (item) => item.profileId === profile.id,
              ),
            })),
          ...selectedSkills.map((skill) => ({
            id: `skill-${skill.id}`,
            name: skill.name,
            description: skillExecutionLabel(skill, currentSettings),
            kind: "personal-skill" as const,
            summary: filteredSkillSummaries.find(
              (item) => item.skillId === skill.id,
            ),
          })),
        ]}
      />

      {prioritizedActiveTasks.map((task) => (
        <section className="panel taskProgress" key={`${"kind" in task ? "workflow" : "analysis"}-${task.id}`}>
          <div className="progressLabel">
            <strong>{task.status_message}</strong>
            <span>
              {task.current_item}/{task.total_items || "?"}
            </span>
          </div>
          <div className="progressTrack">
            <span
              style={{
                width: task.total_items
                  ? `${(task.current_item / task.total_items) * 100}%`
                  : "3%",
              }}
            />
          </div>
        </section>
      ))}

      {data.tasks.find((task) => task.status === "failed") && (
        <details className="failureDetails taskFailure">
          <summary>Latest task failure</summary>
          <pre>{data.tasks.find((task) => task.status === "failed")?.error}</pre>
        </details>
      )}

      <section className="panel resultSpreadsheetPanel">
        <div className="panelHeading">
          <div>
            <span className="step">PR dataset</span>
            <h2>Spreadsheet comparison</h2>
          </div>
          <div className="bulkActions">
            <Link href={`/repositories/${id}/history-reports`}>
              HistoryReports
            </Link>
            <button
              className="secondaryButton"
              disabled={busy === "save-report"}
              onClick={() => void saveHistoryReports()}
            >
              Save report
            </button>
          </div>
        </div>

        <PrTableControls
          search={prSearch}
          onSearchChange={(value) => {
            setPrSearch(value);
            setCurrentPage(1);
          }}
          pathFilter={effectivePathFilter}
          onPathFilterChange={(value) => {
            setPrPathFilter(value);
            window.localStorage.setItem(pathFilterStorageKey, value);
            setCurrentPage(1);
          }}
          pathFilterEnabled={prPathFilterEnabled}
          onPathFilterEnabledChange={(value) => {
            setPrPathFilterEnabled(value);
            window.localStorage.setItem(
              pathFilterEnabledStorageKey,
              String(value),
            );
            setCurrentPage(1);
          }}
          showSelectedOnly={showSelectedOnly}
          onShowSelectedOnlyChange={(value) => {
            setShowSelectedOnly(value);
            window.localStorage.setItem(
              showSelectedStorageKey,
              String(value),
            );
            setCurrentPage(1);
          }}
          showReviewedOnly={showReviewedOnly}
          onShowReviewedOnlyChange={(value) => {
            setShowReviewedOnly(value);
            window.localStorage.setItem(
              showReviewedStorageKey,
              String(value),
            );
            setCurrentPage(1);
          }}
          refreshingScore={busy === "refresh-score"}
          onRefreshScore={() => void refreshScore()}
          pageSize={pageSizeInput}
          onPageSizeChange={(value) => {
            setPageSizeInput(value);
            setCurrentPage(1);
          }}
          onPageSizeBlur={() => setPageSizeInput(String(pageSize))}
          page={displayedPage}
          pageCount={pageCount}
          filteredCount={filteredPullRequests.length}
          totalCount={data.pullRequests.length}
          onPageChange={setCurrentPage}
        />

        <div className="resultTableWrap">
          {data.pullRequests.length === 0 && (
            <div className="emptyState">
              <strong>No PRs downloaded yet</strong>
              <span>Wait for collection to finish or add a PR manually.</span>
            </div>
          )}
          {data.pullRequests.length > 0 && (
            <table className="resultSpreadsheet">
              <thead>
                <tr>
                  <th rowSpan={2} className="stickySelectColumn">
                    <input
                      type="checkbox"
                      aria-label="Select all pull requests"
                      checked={
                        allPathFilteredSelected
                      }
                      disabled={selectionLocked}
                      onChange={(event) =>
                        void selectAll(event.target.checked)
                      }
                    />
                  </th>
                  <th rowSpan={2} className="stickyPrColumn">
                    <span className="sortableHeader">
                      <span>PR Info / Number</span>
                      <button
                        type="button"
                        className={`sortHeaderButton${sortKey === "pr-number" ? " active" : ""}`}
                        aria-label="Sort by PR number"
                        title="Sort by PR number"
                        onClick={() => toggleSort("pr-number", "asc")}
                      >
                        {sortIndicator("pr-number")}
                      </button>
                    </span>
                  </th>
                  {data.baselineProfiles.map((profile) => (
                    <th
                      colSpan={2}
                      className="configurationGroupHeader baselineGroupHeader"
                      key={`baseline-header-${profile.id}`}
                    >
                      <strong>{profileLabel(profile)}</strong>
                      <small>
                        Baseline · {modelLabel(profile.model)} +{" "}
                        {modelLabel(profile.model_secondary)} ·{" "}
                        {contextLabel(profile.context_tier)}
                      </small>
                    </th>
                  ))}
                  {selectedSkills.map((skill) => {
                    const incompleteResults = data.pullRequests.flatMap((pr) => {
                      const result = skillResultFor(
                        pr,
                        skill,
                        currentSettings,
                      );
                      return result && skillHasMissedScore(result)
                        ? [{ pullRequestId: pr.id, resultId: result.id }]
                        : [];
                    });
                    const activeApplyJob = activeAnalysisJobs.find(
                      (job) =>
                        job.skill_id === skill.id &&
                        job.mode === "analyze_apply",
                    );
                    return (
                      <th
                        colSpan={3}
                        className="configurationGroupHeader skillGroupHeader"
                        key={`skill-header-${skill.id}`}
                      >
                        <div className="skillHeaderTitle">
                          <strong>{skill.name}</strong>
                          <button
                            type="button"
                            className="analyzeAllButton"
                            disabled={
                              Boolean(activeApplyJob) ||
                              incompleteResults.length === 0 ||
                              busy === `analyze-apply-${skill.id}`
                            }
                            onClick={() =>
                              void analyzeSkill(
                                skill,
                                incompleteResults.map(
                                  (result) => result.pullRequestId,
                                ),
                                true,
                                incompleteResults.map(
                                  (result) => result.resultId,
                                ),
                              )
                            }
                          >
                            {activeApplyJob
                              ? activeApplyJob.status
                              : "Analyze and Apply All"}
                          </button>
                        </div>
                        <small>
                          {skillExecutionLabel(skill, currentSettings)}
                        </small>
                      </th>
                    );
                  })}
                </tr>
                <tr>
                  {data.baselineProfiles.map((profile) => (
                    <Fragment key={`baseline-subheader-${profile.id}`}>
                      <th>
                        <span className="sortableHeader">
                          <span>Review Result</span>
                          <button
                            type="button"
                            className={`sortHeaderButton${sortKey === `baseline:result:${profile.id}` ? " active" : ""}`}
                            aria-label={`Sort ${profileLabel(profile)} review results`}
                            title={`Sort ${profileLabel(profile)} review results`}
                            onClick={() =>
                              toggleSort(
                                `baseline:result:${profile.id}`,
                                "asc",
                              )
                            }
                          >
                            {sortIndicator(
                              `baseline:result:${profile.id}`,
                            )}
                          </button>
                        </span>
                      </th>
                      <th>
                        <span className="sortableHeader">
                          <span>Credits</span>
                          <button
                            type="button"
                            className={`sortHeaderButton${sortKey === `baseline:credits:${profile.id}` ? " active" : ""}`}
                            aria-label={`Sort ${profileLabel(profile)} credits`}
                            title={`Sort ${profileLabel(profile)} credits`}
                            onClick={() =>
                              toggleSort(
                                `baseline:credits:${profile.id}`,
                                "desc",
                              )
                            }
                          >
                            {sortIndicator(
                              `baseline:credits:${profile.id}`,
                            )}
                          </button>
                        </span>
                      </th>
                    </Fragment>
                  ))}
                  {selectedSkills.map((skill) => (
                    <Fragment key={`skill-subheader-${skill.id}`}>
                      <th>
                        <span className="sortableHeader">
                          <span>Review Result</span>
                          <button
                            type="button"
                            className={`sortHeaderButton${sortKey === `skill:result:${skill.id}` ? " active" : ""}`}
                            aria-label={`Sort ${skill.name} review results`}
                            title={`Sort ${skill.name} review results`}
                            onClick={() =>
                              toggleSort(
                                `skill:result:${skill.id}`,
                                "asc",
                              )
                            }
                          >
                            {sortIndicator(`skill:result:${skill.id}`)}
                          </button>
                        </span>
                      </th>
                      <th>
                        <span className="sortableHeader">
                          <span>Credits</span>
                          <button
                            type="button"
                            className={`sortHeaderButton${sortKey === `skill:credits:${skill.id}` ? " active" : ""}`}
                            aria-label={`Sort ${skill.name} credits`}
                            title={`Sort ${skill.name} credits`}
                            onClick={() =>
                              toggleSort(
                                `skill:credits:${skill.id}`,
                                "desc",
                              )
                            }
                          >
                            {sortIndicator(`skill:credits:${skill.id}`)}
                          </button>
                        </span>
                      </th>
                      <th>
                        <span className="sortableHeader">
                          <span>Analysis</span>
                          <button
                            type="button"
                            className={`sortHeaderButton${sortKey === `skill:analysis:${skill.id}` ? " active" : ""}`}
                            aria-label={`Sort ${skill.name} analysis status`}
                            title={`Sort ${skill.name} analysis status`}
                            onClick={() =>
                              toggleSort(
                                `skill:analysis:${skill.id}`,
                                "asc",
                              )
                            }
                          >
                            {sortIndicator(`skill:analysis:${skill.id}`)}
                          </button>
                        </span>
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginatedPullRequests.map((pr) => (
                  <tr
                    key={pr.id}
                    className={pr.selected ? "selectedResultRow" : ""}
                  >
                    <td className="stickySelectColumn">
                      <input
                        type="checkbox"
                        aria-label={`Select PR #${pr.number}`}
                        checked={Boolean(pr.selected)}
                        disabled={selectionLocked}
                        onChange={(event) =>
                          void updatePr(pr.id, {
                            selected: event.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="stickyPrColumn prNameCell">
                      <div>
                        <a href={pr.url} target="_blank" rel="noreferrer">
                          #{pr.number}
                        </a>{" "}
                        <span>{pr.title}</span>
                      </div>
                      <small>
                        {pr.author} · {pr.changed_files} files ·{" "}
                        {pr.valued_comment_count} findings
                      </small>
                    </td>
                    {data.baselineProfiles.map((profile) => {
                      const result = pr.baselineResults.find(
                        (item) => item.profile_id === profile.id,
                      );
                      const hasEarnedCredit =
                        baselineHasEarnedCredit(result);
                      const retryKey = `retry-baseline-${pr.id}-${profile.id}`;
                      return (
                        <Fragment key={`baseline-${profile.id}-${pr.id}`}>
                          <td
                            className={`reviewResultCell${hasEarnedCredit ? " baselineCreditCell" : ""}`}
                          >
                            {result ? (
                              <a
                                href={`/api/baseline-profile-results/${result.id}/output`}
                                target="_blank"
                              >
                                {result.status === "completed"
                                  ? "Open output"
                                  : result.status}
                              </a>
                            ) : (
                              <span className="state-not-queued">
                                not queued
                              </span>
                            )}
                            <small>{seconds(result?.duration_ms ?? null)}</small>
                            {result?.error && (
                              <details className="cellError">
                                <summary>Error</summary>
                                <pre>{result.error}</pre>
                              </details>
                            )}
                            {result?.status === "failed" && (
                              <button
                                className="cellRetryButton"
                                disabled={busy === retryKey}
                                onClick={() =>
                                  void retryResult(
                                    "baseline",
                                    pr.id,
                                    profile.id,
                                  )
                                }
                              >
                                Retry
                              </button>
                            )}
                          </td>
                          <td
                            className={`scoreCell${hasEarnedCredit ? " baselineCreditCell" : ""}`}
                          >
                            <strong>
                              {creditLabel(
                                result?.metrics_json ?? null,
                                "baseline",
                              )}
                            </strong>
                          </td>
                        </Fragment>
                      );
                    })}
                    {selectedSkills.map((skill) => {
                      const result = skillResultFor(
                        pr,
                        skill,
                        currentSettings,
                      );
                      const retryKey = `retry-evaluate-${pr.id}-${skill.id}`;
                      const resultUrl = result?.report_path
                        ? `/api/personal-skill-results/${result.id}/report`
                        : result
                          ? `/api/personal-skill-results/${result.id}/output`
                          : null;
                      const analysis = data.skillAnalysisResults.find(
                        (item) =>
                          item.skill_id === skill.id &&
                          item.pull_request_id === pr.id &&
                          item.model ===
                            (result?.model ?? currentSettings.model) &&
                          item.model_secondary ===
                            (result?.model_secondary ??
                              currentSettings.modelSecondary) &&
                          item.context_tier ===
                            (result?.context_tier ??
                              currentSettings.contextTier),
                      );
                      const analysisDetails = parsedAnalysis(
                        analysis?.analysis_json ?? null,
                        analysis?.proposal_json ?? null,
                      );
                      const activeAnalysisJob = activeAnalysisJobs.find(
                        (job) =>
                          job.skill_id === skill.id &&
                          job.model ===
                            (result?.model ?? currentSettings.model) &&
                          job.model_secondary ===
                            (result?.model_secondary ??
                              currentSettings.modelSecondary) &&
                          job.context_tier ===
                            (result?.context_tier ??
                              currentSettings.contextTier) &&
                          analysisJobPullRequestIds(job).includes(pr.id),
                      );
                      const hasMissedScore = skillHasMissedScore(result);
                      const hasEarnedCredit = skillHasEarnedCredit(result);
                      const canApply =
                        analysis?.status === "completed" &&
                        Boolean(analysisDetails?.edits.length) &&
                        !analysis.applied_at;
                      return (
                        <Fragment key={`skill-${skill.id}-${pr.id}`}>
                          <td
                            className={`reviewResultCell skillResultCell${hasEarnedCredit ? " skillCreditCell" : ""}`}
                          >
                            {result && resultUrl ? (
                              <a href={resultUrl} target="_blank">
                                {result.status === "completed"
                                  ? "Open report"
                                  : result.status}
                              </a>
                            ) : (
                              <span className="state-not-queued">
                                not queued
                              </span>
                            )}
                            <small>{seconds(result?.duration_ms ?? null)}</small>
                            {result?.error && (
                              <details className="cellError">
                                <summary>Error</summary>
                                <pre>{result.error}</pre>
                              </details>
                            )}
                            {result?.status === "failed" && (
                              <button
                                className="cellRetryButton"
                                disabled={busy === retryKey}
                                onClick={() =>
                                  void retryResult(
                                    "evaluate",
                                    pr.id,
                                    skill.id,
                                  )
                                }
                              >
                                Retry
                              </button>
                            )}
                          </td>
                          <td
                            className={`scoreCell skillScoreCell${hasEarnedCredit ? " skillCreditCell" : ""}`}
                          >
                            <strong>
                              {creditLabel(
                                result?.metrics_json ?? null,
                                "skill",
                              )}
                            </strong>
                          </td>
                          <td
                            className={`analysisCell${hasEarnedCredit ? " skillCreditCell" : ""}`}
                          >
                            {!result || result.status !== "completed" ? (
                              <span className="muted">Review required</span>
                            ) : !result.metrics_json ? (
                              <span className="muted">
                                Waiting for skill score
                              </span>
                            ) : !hasMissedScore ? (
                              <span className="state-completed">Full score</span>
                            ) : (
                              <>
                                <div className="analysisActions">
                                  <button
                                    type="button"
                                    className="secondaryButton"
                                    disabled={
                                      Boolean(activeAnalysisJob) ||
                                      busy === `analyze-${skill.id}-${pr.id}`
                                    }
                                    onClick={() =>
                                      void analyzeSkill(
                                        skill,
                                        [pr.id],
                                        false,
                                        [result.id],
                                      )
                                    }
                                  >
                                    {analysis &&
                                    ["pending", "running"].includes(
                                      analysis.status,
                                    )
                                      ? analysis.status
                                      : "Analyze"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      Boolean(analysis?.applied_at) ||
                                      !canApply ||
                                      Boolean(activeSkillTask) ||
                                      busy === `apply-analysis-${analysis?.id}`
                                    }
                                    onClick={() =>
                                      analysis &&
                                      void applyAnalysis(analysis, skill.name)
                                    }
                                  >
                                    {analysis?.applied_at ? "Applied" : "Apply"}
                                  </button>
                                  {analysis?.applied_at && (
                                    <button
                                      type="button"
                                      className="secondaryButton"
                                      disabled={
                                        Boolean(activeSkillTask) ||
                                        busy === retryKey
                                      }
                                      onClick={() =>
                                        void retryResult(
                                          "evaluate",
                                          pr.id,
                                          skill.id,
                                        )
                                      }
                                    >
                                      {busy === retryKey
                                        ? "Rerunning…"
                                        : "Rerun"}
                                    </button>
                                  )}
                                </div>
                                {analysisDetails && (
                                  <button
                                    type="button"
                                    className="analysisViewButton"
                                    onClick={() =>
                                      setAnalysisModal({
                                        prNumber: pr.number,
                                        prTitle: pr.title,
                                        skillName: skill.name,
                                        applied: Boolean(analysis?.applied_at),
                                        details: analysisDetails,
                                      })
                                    }
                                  >
                                    {analysis?.applied_at
                                      ? "View applied mitigation"
                                      : "View analysis"}
                                  </button>
                                )}
                                {(analysis?.error ||
                                  analysis?.application_error) && (
                                  <details className="cellError">
                                    <summary>
                                      {analysis.application_error
                                        ? "Apply error"
                                        : "Analysis error"}
                                    </summary>
                                    <pre>{displayedAnalysisError(analysis)}</pre>
                                  </details>
                                )}
                              </>
                            )}
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>
                ))}
                {filteredPullRequests.length === 0 && (
                  <tr>
                    <td
                      className="tableEmpty"
                      colSpan={
                        2 +
                        data.baselineProfiles.length * 2 +
                        selectedSkills.length * 3
                      }
                    >
                      {prPathFilterEnabled &&
                      parsePathFilters(effectivePathFilter).length > 0 &&
                      pathFilteredPullRequests.length === 0
                        ? `No PR has a changed file under "${effectivePathFilter}".`
                        : showSelectedOnly
                          ? "No selected PR matches the current filters."
                          : showReviewedOnly
                            ? "No reviewed PR matches the current filters."
                          : `No PR number matches "${prSearch.trim()}".`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {analysisModal && (
        <div
          className="defectModalBackdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAnalysisModal(null);
          }}
        >
          <section
            className="defectModal analysisModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analysis-modal-title"
          >
            <header>
              <div>
                <span className="eyebrow">
                  {analysisModal.applied
                    ? "Applied skill mitigation"
                    : "Skill review analysis"}
                </span>
                <h2 id="analysis-modal-title">
                  PR #{analysisModal.prNumber} analysis
                </h2>
                <p>
                  {analysisModal.skillName} · {analysisModal.prTitle}
                </p>
              </div>
              <button
                type="button"
                className="secondaryButton"
                onClick={() => setAnalysisModal(null)}
              >
                Close
              </button>
            </header>
            <div className="defectModalBody analysisModalBody">
              <article className="modalDefectCard">
                <h3>Summary</h3>
                <p>{analysisModal.details.summary}</p>
              </article>
              <article className="modalDefectCard">
                <h3>Why the skill missed it</h3>
                <p>{analysisModal.details.whyMissed}</p>
              </article>
              <article className="modalDefectCard">
                <h3>Mitigation</h3>
                <p>{analysisModal.details.mitigation}</p>
              </article>
              {analysisModal.details.edits.length > 0 && (
                <article className="modalDefectCard">
                  <h3>Exact changes made by Apply</h3>
                  <p className="analysisApplyNotice">
                    Apply uses this stored proposal exactly. If the current text
                    no longer matches once, Apply stops without changing the
                    file.
                  </p>
                  <div className="analysisPatchList">
                    {analysisModal.details.edits.map((edit) => (
                      <section
                        className="analysisPatch"
                        key={`${edit.file}-${edit.search}`}
                      >
                        <h4>{edit.file}</h4>
                        {edit.targetKind &&
                          edit.implementationPath &&
                          edit.implementationPath.length > 0 && (
                            <p className="analysisImplementationPath">
                              {edit.targetKind}:{" "}
                              {edit.implementationPath.join(" → ")}
                            </p>
                          )}
                        {edit.rationale && <p>{edit.rationale}</p>}
                        <div className="analysisPatchColumns">
                          <div>
                            <h5>Current text removed</h5>
                            <pre className="analysisPatchBefore">
                              <code>{edit.search}</code>
                            </pre>
                          </div>
                          <div>
                            <h5>Text after Apply</h5>
                            <pre className="analysisPatchAfter">
                              <code>{edit.replacement}</code>
                            </pre>
                          </div>
                        </div>
                      </section>
                    ))}
                  </div>
                </article>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="secondaryButton"
                onClick={() => setAnalysisModal(null)}
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
