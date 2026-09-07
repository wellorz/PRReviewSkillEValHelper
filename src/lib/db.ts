import fs from "node:fs";
import Database from "better-sqlite3";
import { initializeHistorySnapshots } from "@/lib/history-snapshot-store";
import { DATA_DIR, DATABASE_PATH } from "@/lib/paths";

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'github',
    clone_url TEXT NOT NULL DEFAULT '',
    organization_url TEXT,
    project_name TEXT,
    repository_name TEXT NOT NULL DEFAULT '',
    path_filter TEXT,
    skill_path TEXT NOT NULL,
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'gpt-5.4',
    context_tier TEXT NOT NULL DEFAULT 'default',
    target_prs INTEGER NOT NULL DEFAULT 100,
    scan_limit INTEGER NOT NULL DEFAULT 500,
    status TEXT NOT NULL DEFAULT 'queued',
    status_message TEXT,
    scan_current INTEGER NOT NULL DEFAULT 0,
    scan_total INTEGER NOT NULL DEFAULT 0,
    collected_count INTEGER NOT NULL DEFAULT 0,
    baseline_concurrency INTEGER NOT NULL DEFAULT 5,
    local_repo_path TEXT,
    local_repo_branch TEXT,
    local_repo_warning TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    author TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    merged_at TEXT,
    updated_at TEXT NOT NULL,
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    changed_files INTEGER NOT NULL DEFAULT 0,
    valued_comment_count INTEGER NOT NULL,
    dataset_path TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    selected INTEGER NOT NULL DEFAULT 1,
    manual INTEGER NOT NULL DEFAULT 0,
    excluded_by_user INTEGER NOT NULL DEFAULT 0,
    defect_description TEXT,
    baseline_status TEXT NOT NULL DEFAULT 'pending',
    baseline_duration_ms INTEGER,
    baseline_findings_json TEXT,
    baseline_usage_json TEXT,
    baseline_metrics_json TEXT,
    baseline_completed_at TEXT,
    skill_status TEXT NOT NULL DEFAULT 'pending',
    skill_duration_ms INTEGER,
    skill_findings_json TEXT,
    skill_metrics_json TEXT,
    skill_completed_at TEXT,
    skill_report_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, number)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    trigger TEXT NOT NULL DEFAULT 'manual',
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'gpt-5.4',
    skill_path TEXT NOT NULL,
    current_pr INTEGER NOT NULL DEFAULT 0,
    total_prs INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    summary_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS review_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    model_key TEXT NOT NULL DEFAULT 'model1',
    variant TEXT NOT NULL CHECK(variant IN ('skilled', 'baseline')),
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT,
    findings_json TEXT,
    raw_output TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id, pull_request_id, model_key, variant)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    metrics_json TEXT NOT NULL,
    report_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id, pull_request_id)
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    interval_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id)
  );

  CREATE TABLE IF NOT EXISTS quick_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL,
    title TEXT,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    stage TEXT NOT NULL DEFAULT 'waiting for worker',
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    result_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('manual_pr', 'baseline', 'skill_eval')),
    status TEXT NOT NULL DEFAULT 'queued',
    pr_ids_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT,
    current_item INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    status_message TEXT NOT NULL DEFAULT 'Waiting for worker',
    error TEXT,
    report_path TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS personal_review_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, name)
  );

  CREATE TABLE IF NOT EXISTS baseline_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'none',
    context_tier TEXT NOT NULL,
    name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, model, model_secondary, context_tier)
  );

  CREATE TABLE IF NOT EXISTS baseline_profile_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES baseline_profiles(id) ON DELETE CASCADE,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    findings_json TEXT,
    usage_json TEXT,
    metrics_json TEXT,
    raw_output TEXT,
    repository_context_mode TEXT NOT NULL DEFAULT 'diff',
    repository_commit TEXT,
    error TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_id, pull_request_id)
  );

  CREATE TABLE IF NOT EXISTS personal_skill_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES personal_review_skills(id) ON DELETE CASCADE,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    baseline_profile_id INTEGER REFERENCES baseline_profiles(id) ON DELETE SET NULL,
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'none',
    context_tier TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    findings_json TEXT,
    usage_json TEXT,
    metrics_json TEXT,
    raw_output_json TEXT,
    repository_context_mode TEXT NOT NULL DEFAULT 'diff',
    repository_commit TEXT,
    error TEXT,
    report_path TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(skill_id, pull_request_id, model, model_secondary, context_tier)
  );

  CREATE INDEX IF NOT EXISTS idx_baseline_profiles_repository
    ON baseline_profiles(repository_id, active);
  CREATE INDEX IF NOT EXISTS idx_personal_review_skills_repository
    ON personal_review_skills(repository_id, active);
  CREATE INDEX IF NOT EXISTS idx_baseline_profile_results_pr
    ON baseline_profile_results(pull_request_id);
  CREATE INDEX IF NOT EXISTS idx_personal_skill_results_pr
    ON personal_skill_results(pull_request_id);

  CREATE TABLE IF NOT EXISTS history_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    configuration_name TEXT NOT NULL,
    earned_points INTEGER NOT NULL DEFAULT 0,
    available_points INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_history_reports_repository
    ON history_reports(repository_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS skill_analysis_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES personal_review_skills(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('analyze', 'analyze_apply')),
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'none',
    context_tier TEXT NOT NULL,
    pr_ids_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    current_item INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    status_message TEXT NOT NULL DEFAULT 'Waiting for worker',
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS skill_analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES personal_review_skills(id) ON DELETE CASCADE,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    model_secondary TEXT NOT NULL DEFAULT 'none',
    context_tier TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    analysis_json TEXT,
    proposal_json TEXT,
    usage_json TEXT,
    raw_output TEXT,
    error TEXT,
    applied_at TEXT,
    application_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(
      skill_id, pull_request_id, model, model_secondary, context_tier
    )
  );

  CREATE INDEX IF NOT EXISTS idx_skill_analysis_jobs_status
    ON skill_analysis_jobs(status, id);
  CREATE INDEX IF NOT EXISTS idx_skill_analysis_results_pr
    ON skill_analysis_results(pull_request_id, skill_id);

  CREATE TABLE IF NOT EXISTS dataset_scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    path_filter_key TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    target_prs INTEGER NOT NULL,
    scan_limit INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    scanned_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    eligible_count INTEGER NOT NULL DEFAULT 0,
    newest_pr_number INTEGER,
    oldest_pr_number INTEGER,
    newest_source_date TEXT,
    oldest_source_date TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pr_scan_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    path_filter_key TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    source_updated_at TEXT,
    source_commit TEXT,
    outcome TEXT NOT NULL,
    finding_count INTEGER NOT NULL DEFAULT 0,
    scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(
      repository_id, provider, path_filter_key, policy_version, pr_number
    )
  );

  CREATE INDEX IF NOT EXISTS idx_dataset_scan_runs_repository
    ON dataset_scan_runs(repository_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pr_scan_ledger_scope
    ON pr_scan_ledger(
      repository_id, provider, path_filter_key, policy_version, pr_number
    );
`);

const pullRequestColumns = db
  .prepare("PRAGMA table_info(pull_requests)")
  .all() as Array<{ name: string }>;
if (!pullRequestColumns.some((column) => column.name === "active")) {
  db.exec("ALTER TABLE pull_requests ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}
for (const [name, definition] of [
  ["selected", "INTEGER NOT NULL DEFAULT 1"],
  ["manual", "INTEGER NOT NULL DEFAULT 0"],
  ["excluded_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["defect_description", "TEXT"],
  ["baseline_status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["baseline_duration_ms", "INTEGER"],
  ["baseline_findings_json", "TEXT"],
  ["baseline_usage_json", "TEXT"],
  ["baseline_metrics_json", "TEXT"],
  ["baseline_error", "TEXT"],
  ["baseline_completed_at", "TEXT"],
  ["skill_status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["skill_duration_ms", "INTEGER"],
  ["skill_findings_json", "TEXT"],
  ["skill_metrics_json", "TEXT"],
  ["skill_error", "TEXT"],
  ["skill_completed_at", "TEXT"],
  ["skill_report_path", "TEXT"],
] as const) {
  if (!pullRequestColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN ${name} ${definition}`);
  }
}

const repositoryColumns = db
  .prepare("PRAGMA table_info(repositories)")
  .all() as Array<{ name: string }>;
if (!repositoryColumns.some((column) => column.name === "model_secondary")) {
  db.exec(
    "ALTER TABLE repositories ADD COLUMN model_secondary TEXT NOT NULL DEFAULT 'gpt-5.4'",
  );
}
for (const [name, definition] of [
  ["display_name", "TEXT NOT NULL DEFAULT ''"],
  ["provider", "TEXT NOT NULL DEFAULT 'github'"],
  ["clone_url", "TEXT NOT NULL DEFAULT ''"],
  ["organization_url", "TEXT"],
  ["project_name", "TEXT"],
  ["repository_name", "TEXT NOT NULL DEFAULT ''"],
  ["path_filter", "TEXT"],
  ["scan_current", "INTEGER NOT NULL DEFAULT 0"],
  ["scan_total", "INTEGER NOT NULL DEFAULT 0"],
  ["collected_count", "INTEGER NOT NULL DEFAULT 0"],
  ["baseline_concurrency", "INTEGER NOT NULL DEFAULT 5"],
  ["local_repo_path", "TEXT"],
  ["local_repo_branch", "TEXT"],
  ["local_repo_warning", "TEXT"],
] as const) {
  if (!repositoryColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE repositories ADD COLUMN ${name} ${definition}`);
  }
}

db.exec(`
  UPDATE repositories
  SET model = CASE lower(model)
    WHEN 'gpt-5.6 sol' THEN 'gpt-5.6-sol'
    WHEN 'gpt-5.6 luna' THEN 'gpt-5.6-luna'
    WHEN 'gpt-5.6 tera' THEN 'gpt-5.6-terra'
    WHEN 'gpt-5.6 terra' THEN 'gpt-5.6-terra'
    ELSE model
  END,
  model_secondary = CASE lower(model_secondary)
    WHEN 'gpt-5.6 sol' THEN 'gpt-5.6-sol'
    WHEN 'gpt-5.6 luna' THEN 'gpt-5.6-luna'
    WHEN 'gpt-5.6 tera' THEN 'gpt-5.6-terra'
    WHEN 'gpt-5.6 terra' THEN 'gpt-5.6-terra'
    ELSE model_secondary
  END;
`);

const runColumns = db.prepare("PRAGMA table_info(runs)").all() as Array<{
  name: string;
}>;
if (!runColumns.some((column) => column.name === "model_secondary")) {
  db.exec(
    "ALTER TABLE runs ADD COLUMN model_secondary TEXT NOT NULL DEFAULT 'gpt-5.4'",
  );
}

const reviewColumns = db
  .prepare("PRAGMA table_info(review_results)")
  .all() as Array<{ name: string }>;
if (!reviewColumns.some((column) => column.name === "model_key")) {
  db.exec(`
    ALTER TABLE review_results RENAME TO review_results_legacy;
    CREATE TABLE review_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      model_key TEXT NOT NULL DEFAULT 'model1',
      variant TEXT NOT NULL CHECK(variant IN ('skilled', 'baseline')),
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      findings_json TEXT,
      raw_output TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, pull_request_id, model_key, variant)
    );
    INSERT INTO review_results (
      id, run_id, pull_request_id, model_key, variant, status, duration_ms,
      usage_json, findings_json, raw_output, error, created_at
    )
    SELECT
      id, run_id, pull_request_id, 'model1', variant, status, duration_ms,
      usage_json, findings_json, raw_output, error, created_at
    FROM review_results_legacy;
    DROP TABLE review_results_legacy;
  `);
}

const baselineProfileResultColumns = db
  .prepare("PRAGMA table_info(baseline_profile_results)")
  .all() as Array<{ name: string }>;
for (const [name, definition] of [
  ["repository_context_mode", "TEXT NOT NULL DEFAULT 'diff'"],
  ["repository_commit", "TEXT"],
] as const) {
  if (!baselineProfileResultColumns.some((column) => column.name === name)) {
    db.exec(
      `ALTER TABLE baseline_profile_results ADD COLUMN ${name} ${definition}`,
    );
  }

  const baselineProfileColumns = db
    .prepare("PRAGMA table_info(baseline_profiles)")
    .all() as Array<{ name: string }>;
  if (
    !baselineProfileColumns.some((column) => column.name === "model_secondary")
  ) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      ALTER TABLE baseline_profile_results RENAME TO baseline_profile_results_legacy;
      ALTER TABLE personal_skill_results RENAME TO personal_skill_results_legacy;
      ALTER TABLE baseline_profiles RENAME TO baseline_profiles_legacy;

      CREATE TABLE baseline_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        model_secondary TEXT NOT NULL DEFAULT 'none',
        context_tier TEXT NOT NULL,
        name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(repository_id, model, model_secondary, context_tier)
      );
      INSERT INTO baseline_profiles (
        id, repository_id, model, model_secondary, context_tier, name,
        active, created_at, updated_at
      )
      SELECT id, repository_id, model, 'none', context_tier, name,
        active, created_at, updated_at
      FROM baseline_profiles_legacy;

      CREATE TABLE baseline_profile_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES baseline_profiles(id) ON DELETE CASCADE,
        pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        duration_ms INTEGER,
        findings_json TEXT,
        usage_json TEXT,
        metrics_json TEXT,
        raw_output TEXT,
        repository_context_mode TEXT NOT NULL DEFAULT 'diff',
        repository_commit TEXT,
        error TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(profile_id, pull_request_id)
      );
      INSERT INTO baseline_profile_results
      SELECT * FROM baseline_profile_results_legacy;

      CREATE TABLE personal_skill_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL REFERENCES personal_review_skills(id) ON DELETE CASCADE,
        pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        baseline_profile_id INTEGER REFERENCES baseline_profiles(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        model_secondary TEXT NOT NULL DEFAULT 'none',
        context_tier TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        duration_ms INTEGER,
        findings_json TEXT,
        usage_json TEXT,
        metrics_json TEXT,
        raw_output_json TEXT,
        repository_context_mode TEXT NOT NULL DEFAULT 'diff',
        repository_commit TEXT,
        error TEXT,
        report_path TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(skill_id, pull_request_id, model, model_secondary, context_tier)
      );
      INSERT INTO personal_skill_results
      SELECT * FROM personal_skill_results_legacy;

      DROP TABLE baseline_profile_results_legacy;
      DROP TABLE personal_skill_results_legacy;
      DROP TABLE baseline_profiles_legacy;

      CREATE INDEX IF NOT EXISTS idx_baseline_profiles_repository
        ON baseline_profiles(repository_id, active);
      CREATE INDEX IF NOT EXISTS idx_baseline_profile_results_pr
        ON baseline_profile_results(pull_request_id);
      CREATE INDEX IF NOT EXISTS idx_personal_skill_results_pr
        ON personal_skill_results(pull_request_id);
    `);
    db.pragma("foreign_keys = ON");
  }
}

const personalSkillResultColumns = db
  .prepare("PRAGMA table_info(personal_skill_results)")
  .all() as Array<{ name: string }>;
for (const [name, definition] of [
  ["repository_context_mode", "TEXT NOT NULL DEFAULT 'diff'"],
  ["repository_commit", "TEXT"],
] as const) {
  if (!personalSkillResultColumns.some((column) => column.name === name)) {
    db.exec(
      `ALTER TABLE personal_skill_results ADD COLUMN ${name} ${definition}`,
    );
  }
}

initializeHistorySnapshots(db);

export function getDb() {
  return db;
}
