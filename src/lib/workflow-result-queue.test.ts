import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  queueBaselineProfileResults,
  queuePersonalSkillResults,
} from "@/lib/workflow-result-queue";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE personal_skill_results (
      id INTEGER PRIMARY KEY,
      skill_id INTEGER NOT NULL,
      pull_request_id INTEGER NOT NULL,
      baseline_profile_id INTEGER,
      model TEXT NOT NULL,
      model_secondary TEXT NOT NULL,
      context_tier TEXT NOT NULL,
      status TEXT NOT NULL,
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
    CREATE TABLE baseline_profile_results (
      id INTEGER PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      pull_request_id INTEGER NOT NULL,
      status TEXT NOT NULL,
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
  `);
  return db;
}

test("creates pending rows for every queued personal skill and PR", () => {
  const db = createDb();
  queuePersonalSkillResults(db, {
    skillIds: [10, 11],
    pullRequestIds: [20, 21],
    model: "gpt-5.6-sol",
    modelSecondary: "none",
    contextTier: "default",
  });
  const rows = db
    .prepare(`
      SELECT skill_id, pull_request_id, status
      FROM personal_skill_results
      ORDER BY skill_id, pull_request_id
    `)
    .all();
  assert.deepEqual(rows, [
    { skill_id: 10, pull_request_id: 20, status: "pending" },
    { skill_id: 10, pull_request_id: 21, status: "pending" },
    { skill_id: 11, pull_request_id: 20, status: "pending" },
    { skill_id: 11, pull_request_id: 21, status: "pending" },
  ]);
  db.close();
});

test("clears stale output when a skill or baseline result is requeued", () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO personal_skill_results (
      skill_id, pull_request_id, model, model_secondary, context_tier,
      status, findings_json, error, completed_at
    ) VALUES (1, 2, 'gpt-5.6-sol', 'none', 'default',
      'completed', '[]', 'old', '2026-09-07T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO baseline_profile_results (
      profile_id, pull_request_id, status, findings_json, error, completed_at
    ) VALUES (3, 2, 'completed', '[]', 'old', '2026-09-07T00:00:00.000Z')
  `).run();

  queuePersonalSkillResults(db, {
    skillIds: [1],
    pullRequestIds: [2],
    model: "gpt-5.6-sol",
    modelSecondary: "none",
    contextTier: "default",
  });
  queueBaselineProfileResults(db, {
    profileIds: [3],
    pullRequestIds: [2],
  });

  assert.deepEqual(
    db
      .prepare(`
        SELECT status, findings_json, error, completed_at
        FROM personal_skill_results
      `)
      .get(),
    {
      status: "pending",
      findings_json: null,
      error: null,
      completed_at: null,
    },
  );
  assert.deepEqual(
    db
      .prepare(`
        SELECT status, findings_json, error, completed_at
        FROM baseline_profile_results
      `)
      .get(),
    {
      status: "pending",
      findings_json: null,
      error: null,
      completed_at: null,
    },
  );
  db.close();
});
