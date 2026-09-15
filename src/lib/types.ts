export type Severity = "critical" | "high" | "medium" | "low";

export type HumanFinding = {
  id: string;
  source: "review_comment" | "issue_comment" | "review";
  author: string;
  authorAssociation: string;
  body: string;
  normalizedBody?: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  url: string;
  createdAt: string;
  valueScore: number;
  valueReasons: string[];
  scorePoint?: 0 | 1;
  iterationId?: number | null;
  iterationSourceCommit?: string | null;
  iterationTargetCommit?: string | null;
  iterationResolution?: "thread-context" | "published-date" | "final";
};

export type ModelFinding = {
  title: string;
  description: string;
  severity: Severity;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  category: string;
  confidence: number;
  evidence: string;
  iterationId?: number | null;
  iterationSourceCommit?: string | null;
  reviewer?: string | null;
  reviewers?: string[];
  suggestion?: string | null;
  verification?: string | null;
  agreedBy?: string[];
  sourceModels?: string[];
  contextTier?: string | null;
  adjudicatedHumanFindingIds?: string[];
  rejectedHumanFindingIds?: string[];
};

export type ReviewSnapshotManifestEntry = {
  key: string;
  iterationId: number | null;
  sourceCommit: string;
  targetCommit: string;
  isFinal: boolean;
  relativePath: string;
  findingIds: string[];
};

export type ReviewSnapshotManifest = {
  version: 1;
  snapshots: ReviewSnapshotManifestEntry[];
};

export type ReviewOutput = {
  summary: string;
  findings: ModelFinding[];
};

export type SkillMitigationEdit = {
  file: string;
  search: string;
  replacement: string;
  rationale: string;
  targetKind: "orchestration" | "reviewer" | "lesson" | "script" | "other";
  implementationPath: string[];
};

export type SkillAnalysisOutput = {
  summary: string;
  commentAssessmentStatus: "supported" | "unsupported" | "ambiguous";
  initialCommentAssessmentStatus?: "supported" | "unsupported" | "ambiguous";
  knowledgeRecheckPerformed?: boolean;
  knowledgeGraphSummary?: string;
  knowledgeGraphFiles?: string[];
  changeAndCommentAssessment: string;
  assessmentEvidence: string[];
  escalation: string;
  reviewAspect: string;
  prevention: string;
  skillGap: string;
  whyMissed: string;
  mitigation: string;
  edits: SkillMitigationEdit[];
};

export type CodeReadingKnowledgeSymbol = {
  name: string;
  kind: "function" | "class" | "structure" | "method" | "module" | "other";
  sourcePath: string;
  purpose: string;
  usages: string[];
  similarSymbols: Array<{
    name: string;
    sourcePath: string;
    similarities: string;
    differences: string;
  }>;
  inputs: Array<{
    name: string;
    type: string;
    validValues: string;
    invalidBehavior: string;
  }>;
  outputs: Array<{
    name: string;
    type: string;
    expectedValues: string;
    meaning: string;
  }>;
  errorBehavior: string[];
  dependencies: Array<{
    name: string;
    kind: string;
    relationship: string;
  }>;
  callFlow: string[];
  invariants: string[];
  evidence: string[];
  uncertainties: string[];
};

export type CodeReadingKnowledgeOutput = {
  summary: string;
  gapType: string;
  symbols: CodeReadingKnowledgeSymbol[];
};

export type Match = {
  humanFindingId: string;
  modelFindingIndex: number;
  score: number;
  locationScore: number;
  textScore: number;
};

export type VariantMetrics = {
  earnedPoints: number;
  availablePoints: number;
  ignoredHumanFindings: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  meanMatchScore: number;
};

export type PrMetrics = {
  skilled: VariantMetrics;
  baseline: VariantMetrics;
  skillMatches: Match[];
  baselineMatches: Match[];
  winner: "skilled" | "baseline" | "tie";
  skilledDurationMs: number;
  baselineDurationMs: number;
};

export type MultiModelPrMetrics = {
  orchestrated: PrMetrics;
  model1: PrMetrics;
  model2: PrMetrics | null;
  orchestrationDurationMs: number;
};

export type GithubPullRequest = {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string; type: string };
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  draft?: boolean;
};

export type RepositoryRecord = {
  id: number;
  slug: string;
  display_name: string;
  provider: "github" | "azure-devops";
  clone_url: string;
  organization_url: string | null;
  project_name: string | null;
  repository_name: string;
  path_filter: string | null;
  collection_mode?: "strict_confirmed" | "resolved_comments";
  confirmation_words_json?: string;
  skill_path: string;
  model: string;
  model_secondary: string;
  context_tier: string;
  target_prs: number;
  scan_limit: number;
  pr_number_greater_than: number | null;
  pr_number_less_than: number | null;
  pr_created_before?: string | null;
  status: string;
  status_message: string | null;
  scan_current: number;
  scan_total: number;
  scan_current_prs: string | null;
  collected_count: number;
  baseline_concurrency: number;
  build_knowledge_graph: number;
  local_repo_path: string | null;
  local_repo_branch: string | null;
  local_repo_warning: string | null;
  created_at: string;
  updated_at: string;
};

export type PersonalReviewSkillRecord = {
  id: number;
  repository_id: number;
  name: string;
  path: string;
  trigger_instruction: string;
  execution_mode: "copilot-skill" | "devloop-local";
  active: number;
  created_at: string;
  updated_at: string;
};

export type BaselineProfileRecord = {
  id: number;
  repository_id: number;
  model: string;
  model_secondary: string;
  context_tier: "default" | "long_context";
  name: string | null;
  active: number;
  created_at: string;
  updated_at: string;
};

export type RunRecord = {
  id: number;
  repository_id: number;
  status: string;
  trigger: string;
  model: string;
  model_secondary: string;
  skill_path: string;
  current_pr: number;
  total_prs: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  summary_path: string | null;
  created_at: string;
};
