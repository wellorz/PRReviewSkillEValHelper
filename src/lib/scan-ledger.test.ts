import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "@/lib/db";
import {
  beginDatasetScan,
  cachedScanOutcome,
  completeDatasetScan,
  normalizedPathFilterKey,
  recordCachedScan,
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
    completeDatasetScan(runId, 0);
    assert.deepEqual(
      db
        .prepare(`
          SELECT status, scanned_count, skipped_count, newest_pr_number,
            oldest_pr_number
          FROM dataset_scan_runs
          WHERE id = ?
        `)
        .get(runId),
      {
        status: "completed",
        scanned_count: 1,
        skipped_count: 1,
        newest_pr_number: 42,
        oldest_pr_number: 42,
      },
    );
  } finally {
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repository.id);
  }
});
