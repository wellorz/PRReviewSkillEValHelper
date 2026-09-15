import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "@/lib/db";
import {
  beginDatasetScan,
  cachedScanOutcome,
  completeDatasetScan,
  normalizedPathFilterKey,
  recordCachedScan,
  recordScanFailure,
  recordScanOutcome,
  scanScope,
} from "@/lib/scan-ledger";
import type { RepositoryRecord } from "@/lib/types";

test("checkpoints scans by repository, filter, policy, PR, date, and commit", () => {
  const db = getDb();
  const slug = `scan-ledger-${process.pid}-${Date.now()}`;
  const result = db
    .prepare(`
      INSERT INTO repositories (
        slug, skill_path, model, repository_name, status
      ) VALUES (?, '.', 'gpt-5.4', 'fixture', 'ready')
    `)
    .run(slug);
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as RepositoryRecord;
  try {
    assert.equal(
      normalizedPathFilterKey(["Src/Api", "src/api", "src/Core"]),
      '["src/api","src/core"]',
    );
    const scope = scanScope(repository, ["src/api"]);
    const resolvedScope = scanScope(
      { ...repository, collection_mode: "resolved_comments" },
      ["src/api"],
    );
    const customConfirmationScope = scanScope(
      {
        ...repository,
        collection_mode: "strict_confirmed",
        confirmation_words_json: '["confirmed internally"]',
      },
      ["src/api"],
    );
    assert.notEqual(scope.policyVersion, resolvedScope.policyVersion);
    assert.notEqual(scope.policyVersion, customConfirmationScope.policyVersion);
    const runId = beginDatasetScan(repository, scope);
    const first = {
      number: 42,
      sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      sourceCommit: "a".repeat(40),
    };
    recordScanOutcome(runId, scope, first, "ineligible", 0);
    assert.deepEqual(cachedScanOutcome(scope, first), {
      outcome: "ineligible",
      findingCount: 0,
    });
    assert.equal(
      cachedScanOutcome(scope, {
        ...first,
        sourceUpdatedAt: "2026-09-02T00:00:00.000Z",
      }),
      null,
    );
    recordCachedScan(runId, scope, first);
    recordScanFailure(runId, {
      number: 43,
      sourceUpdatedAt: "2026-09-01T01:00:00.000Z",
      sourceCommit: "b".repeat(40),
    });
    completeDatasetScan(runId, 0);
    assert.deepEqual(
      db
        .prepare(`
          SELECT status, scanned_count, skipped_count, failed_count,
            failed_prs_json, newest_pr_number, oldest_pr_number
          FROM dataset_scan_runs
          WHERE id = ?
        `)
        .get(runId),
      {
        status: "completed",
        scanned_count: 2,
        skipped_count: 1,
        failed_count: 1,
        failed_prs_json: "[43]",
        newest_pr_number: 43,
        oldest_pr_number: 42,
      },
    );
  } finally {
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repository.id);
  }
});
