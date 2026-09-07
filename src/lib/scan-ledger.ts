import { getDb } from "@/lib/db";
import type { RepositoryRecord } from "@/lib/types";

export const GROUND_TRUTH_POLICY_VERSION = "owner-confirmed-iteration-v6";

export type ScanScope = {
  repositoryId: number;
  provider: string;
  pathFilterKey: string;
  policyVersion: string;
};

export type ScanCandidate = {
  number: number;
  sourceUpdatedAt: string | null;
  sourceCommit: string | null;
};

export type ScanOutcome = "eligible" | "ineligible" | "ignored";

type LedgerRow = {
  source_updated_at: string | null;
  source_commit: string | null;
  outcome: ScanOutcome;
  finding_count: number;
};

export function normalizedPathFilterKey(filters: string[]) {
  return JSON.stringify(
    [...new Set(filters.map((filter) => filter.toLowerCase()))].sort(),
  );
}

export function scanScope(
  repository: RepositoryRecord,
  filters: string[],
): ScanScope {
  return {
    repositoryId: repository.id,
    provider: repository.provider,
    pathFilterKey: normalizedPathFilterKey(filters),
    policyVersion: GROUND_TRUTH_POLICY_VERSION,
  };
}

export function beginDatasetScan(
  repository: RepositoryRecord,
  scope: ScanScope,
) {
  const result = getDb()
    .prepare(`
      INSERT INTO dataset_scan_runs (
        repository_id, provider, path_filter_key, policy_version,
        target_prs, scan_limit
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      repository.id,
      scope.provider,
      scope.pathFilterKey,
      scope.policyVersion,
      repository.target_prs,
      repository.scan_limit,
    );
  return Number(result.lastInsertRowid);
}

export function cachedScanOutcome(
  scope: ScanScope,
  candidate: ScanCandidate,
) {
  const row = getDb()
    .prepare(`
      SELECT source_updated_at, source_commit, outcome, finding_count
      FROM pr_scan_ledger
      WHERE repository_id = ? AND provider = ? AND path_filter_key = ?
        AND policy_version = ? AND pr_number = ?
    `)
    .get(
      scope.repositoryId,
      scope.provider,
      scope.pathFilterKey,
      scope.policyVersion,
      candidate.number,
    ) as LedgerRow | undefined;
  if (
    !row ||
    row.source_updated_at !== candidate.sourceUpdatedAt ||
    row.source_commit !== candidate.sourceCommit
  ) {
    return null;
  }
  return { outcome: row.outcome, findingCount: row.finding_count };
}

function updateRunRange(
  runId: number,
  candidate: ScanCandidate,
  counter: "scanned_count" | "skipped_count",
) {
  getDb()
    .prepare(`
      UPDATE dataset_scan_runs SET
        ${counter} = ${counter} + 1,
        newest_pr_number = CASE
          WHEN newest_pr_number IS NULL OR ? > newest_pr_number THEN ?
          ELSE newest_pr_number
        END,
        oldest_pr_number = CASE
          WHEN oldest_pr_number IS NULL OR ? < oldest_pr_number THEN ?
          ELSE oldest_pr_number
        END,
        newest_source_date = CASE
          WHEN ? IS NULL THEN newest_source_date
          WHEN newest_source_date IS NULL OR ? > newest_source_date THEN ?
          ELSE newest_source_date
        END,
        oldest_source_date = CASE
          WHEN ? IS NULL THEN oldest_source_date
          WHEN oldest_source_date IS NULL OR ? < oldest_source_date THEN ?
          ELSE oldest_source_date
        END
      WHERE id = ?
    `)
    .run(
      candidate.number,
      candidate.number,
      candidate.number,
      candidate.number,
      candidate.sourceUpdatedAt,
      candidate.sourceUpdatedAt,
      candidate.sourceUpdatedAt,
      candidate.sourceUpdatedAt,
      candidate.sourceUpdatedAt,
      candidate.sourceUpdatedAt,
      runId,
    );
}

export function recordCachedScan(
  runId: number,
  scope: ScanScope,
  candidate: ScanCandidate,
) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE pr_scan_ledger
      SET last_seen_at = CURRENT_TIMESTAMP
      WHERE repository_id = ? AND provider = ? AND path_filter_key = ?
        AND policy_version = ? AND pr_number = ?
    `).run(
      scope.repositoryId,
      scope.provider,
      scope.pathFilterKey,
      scope.policyVersion,
      candidate.number,
    );
    updateRunRange(runId, candidate, "skipped_count");
  })();
}

export function recordScanOutcome(
  runId: number,
  scope: ScanScope,
  candidate: ScanCandidate,
  outcome: ScanOutcome,
  findingCount: number,
) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO pr_scan_ledger (
        repository_id, provider, path_filter_key, policy_version, pr_number,
        source_updated_at, source_commit, outcome, finding_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        repository_id, provider, path_filter_key, policy_version, pr_number
      ) DO UPDATE SET
        source_updated_at = excluded.source_updated_at,
        source_commit = excluded.source_commit,
        outcome = excluded.outcome,
        finding_count = excluded.finding_count,
        scanned_at = CURRENT_TIMESTAMP,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(
      scope.repositoryId,
      scope.provider,
      scope.pathFilterKey,
      scope.policyVersion,
      candidate.number,
      candidate.sourceUpdatedAt,
      candidate.sourceCommit,
      outcome,
      findingCount,
    );
    updateRunRange(runId, candidate, "scanned_count");
  })();
}

export function completeDatasetScan(runId: number, eligibleCount: number) {
  getDb()
    .prepare(`
      UPDATE dataset_scan_runs
      SET status = 'completed', eligible_count = ?, completed_at = ?
      WHERE id = ?
    `)
    .run(eligibleCount, new Date().toISOString(), runId);
}

export function failActiveDatasetScans(
  repositoryId: number,
  error: string,
) {
  getDb()
    .prepare(`
      UPDATE dataset_scan_runs
      SET status = 'failed', error = ?, completed_at = ?
      WHERE repository_id = ? AND status = 'running'
    `)
    .run(error, new Date().toISOString(), repositoryId);
}

export function interruptActiveDatasetScans() {
  getDb()
    .prepare(`
      UPDATE dataset_scan_runs
      SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `)
    .run();
}
