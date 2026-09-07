import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { summarizeComparisonResults } from "@/lib/comparison-matrix";
import {
  initializeHistorySnapshots,
  listHistorySnapshots,
  readHistorySnapshot,
  saveHistorySnapshot,
  type HistoryReportToSave,
} from "@/lib/history-snapshot-store";
import {
  historySnapshotName,
  historyTimestampIso,
  type HistoryConfigurationSnapshot,
  type HistorySnapshotScope,
} from "@/lib/history-snapshots";

const scope: HistorySnapshotScope = {
  pullRequestNumbers: [1, 2, 3, 4, 5, 6, 7],
  pathFilter: "sources/dev/Management/src/ServiceHost",
  pathFilterEnabled: true,
};

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO repositories VALUES (1, 'original'), (2, 'other');
    CREATE TABLE history_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      configuration_name TEXT NOT NULL,
      earned_points INTEGER NOT NULL,
      available_points INTEGER NOT NULL,
      completed_count INTEGER NOT NULL,
      failed_count INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function report(
  name: string,
  kind: "baseline" | "personal-skill" = "baseline",
  lastStatus = "completed",
): HistoryReportToSave {
  const results = scope.pullRequestNumbers.map((number) => {
    const status = number === 7 ? lastStatus : "completed";
    return {
      pullRequest: {
        number,
        title: `PR ${number}`,
        url: `https://example.test/pull/${number}`,
        author: "author",
        valuedCommentCount: 1,
      },
      status,
      durationMs: status === "completed" ? 1000 : null,
      completedAt: status === "completed" ? "2026-09-06T04:20:00.000Z" : null,
      repositoryCommit: "a".repeat(40),
      metrics: status === "completed" ? {
        earnedPoints: number <= 3 ? 1 : 0,
        availablePoints: 1,
        ignoredHumanFindings: 0,
        truePositives: number <= 3 ? 1 : 0,
        falsePositives: 0,
        falseNegatives: number <= 3 ? 0 : 1,
        precision: number <= 3 ? 1 : 0,
        recall: number <= 3 ? 1 : 0,
        f1: number <= 3 ? 1 : 0,
        meanMatchScore: number <= 3 ? 1 : 0,
      } : null,
      summary: "Saved review",
      findings: [],
      rawOutput: "{}",
      error: status === "failed" ? "Saved failure" : null,
    };
  });
  const summary = summarizeComparisonResults(
    results.map((result) => ({
      status: result.status,
      earnedPoints: result.metrics?.earnedPoints ?? 0,
    })),
    results.length,
    results.length,
  );
  return {
    kind,
    configurationName: name,
    snapshot: {
      version: 2,
      createdAt: "2026-09-06T04:25:00.000Z",
      repository: { id: 1, name: "Repository", slug: "owner/repository" },
      configuration: {
        kind,
        name,
        model: "gpt-6-astra",
        modelSecondary: "none",
        contextTier: "long_context",
        description: "Frozen model description",
      },
      aggregate: { earnedPoints: summary.earnedPoints, availablePoints: 7 },
      summary,
      results,
    },
  };
}

function insertLegacy(
  db: Database.Database,
  snapshot: HistoryConfigurationSnapshot,
  repositoryId = 1,
) {
  return Number(db.prepare(`
    INSERT INTO history_reports (
      repository_id, name, kind, configuration_name, earned_points,
      available_points, completed_count, failed_count, snapshot_json, created_at
    ) VALUES (?, ?, ?, ?, 3, 7, 7, 0, ?, '2026-09-04 16:08:49')
  `).run(
    repositoryId,
    `${snapshot.configuration.name} 202609050008`,
    snapshot.configuration.kind,
    snapshot.configuration.name,
    JSON.stringify(snapshot),
  ).lastInsertRowid);
}

test("uses fourteen-digit local snapshot names and interprets SQL timestamps as UTC", () => {
  assert.equal(historySnapshotName(new Date(2026, 8, 6, 12, 25, 0)), "20260906122500");
  assert.equal(historyTimestampIso("2026-09-04 16:08:49"), "2026-09-04T16:08:49.000Z");
  assert.equal(historyTimestampIso("2026-09-05T00:08:49+08:00"), "2026-09-04T16:08:49.000Z");
  assert.equal(historyTimestampIso("2026-09-04T16:08:49.207Z"), "2026-09-04T16:08:49.207Z");
  assert.throws(() => historyTimestampIso("invalid timestamp"), RangeError);
});

test("one save groups all configurations and freezes scores, names, scope, and states", () => {
  const db = database();
  try {
    initializeHistorySnapshots(db);
    const baseline = report("GPT-6 ASTRA 1M");
    const skill = report("wzReview", "personal-skill", "running");
    const savedAt = new Date(2026, 8, 6, 12, 25, 0);
    const saved = saveHistorySnapshot(db, {
      repositoryId: 1, scope, reports: [baseline, skill], savedAt,
    });
    assert.equal(saved.snapshot.name, "20260906122500");
    assert.equal(saved.saved, 2);
    const list = listHistorySnapshots(db, 1);
    assert.equal(list.length, 1);
    assert.equal(list[0].configurationCount, 2);
    assert.equal(list[0].pullRequestCount, 7);
    const snapshot = readHistorySnapshot(db, 1, saved.snapshot.id);
    assert.ok(snapshot);
    assert.equal(snapshot.rows[0].name, "GPT-6 ASTRA 1M");
    assert.equal(snapshot.rows[0].summary?.earnedPoints, 3);
    assert.equal(snapshot.rows[1].summary?.completed, 6);
    assert.equal(snapshot.rows[1].summary?.running, 1);
    assert.equal(snapshot.rows[1].description, "Frozen model description");
    assert.deepEqual(snapshot.scope, scope);
    const frozen = JSON.stringify(snapshot);

    baseline.snapshot.configuration.name = "Renamed after saving";
    baseline.snapshot.results[0].status = "failed";
    skill.snapshot.results[6].status = "completed";
    db.prepare("UPDATE repositories SET name = 'changed' WHERE id = 1").run();
    initializeHistorySnapshots(db);
    assert.equal(JSON.stringify(readHistorySnapshot(db, 1, saved.snapshot.id)), frozen);
    assert.equal(readHistorySnapshot(db, 2, saved.snapshot.id), null);

    const raw = db.prepare("SELECT snapshot_json FROM history_reports WHERE id = ?")
      .get(saved.reports[0].id) as { snapshot_json: string };
    const detailed = JSON.parse(raw.snapshot_json) as HistoryConfigurationSnapshot;
    assert.equal(detailed.results[0].completedAt, "2026-09-06T04:20:00.000Z");
    assert.equal(detailed.createdAt, savedAt.toISOString());

    const second = saveHistorySnapshot(db, {
      repositoryId: 1, scope, reports: [report("Second save")], savedAt,
    });
    assert.notEqual(second.snapshot.id, saved.snapshot.id);
    assert.equal(second.snapshot.name, saved.snapshot.name);
    assert.equal(listHistorySnapshots(db, 1).length, 2);
    assert.equal(JSON.stringify(readHistorySnapshot(db, 1, saved.snapshot.id)), frozen);
  } finally {
    db.close();
  }
});

test("backfills legacy saves by exact save time without changing report IDs or contents", () => {
  const db = database();
  try {
    const first = report("Sol").snapshot;
    first.version = 1;
    first.createdAt = "2026-09-04T16:08:49.207Z";
    delete first.summary;
    const second = { ...first, configuration: { ...first.configuration, name: "Terra" } };
    const later = { ...first, createdAt: "2026-09-04T16:08:49.800Z" };
    const ids = [
      insertLegacy(db, first),
      insertLegacy(db, second),
      insertLegacy(db, later),
      insertLegacy(db, first, 2),
    ];
    const original = db.prepare("SELECT id, snapshot_json FROM history_reports ORDER BY id").all();
    initializeHistorySnapshots(db);
    initializeHistorySnapshots(db);
    assert.deepEqual(db.prepare("SELECT id, snapshot_json FROM history_reports ORDER BY id").all(), original);
    const list = listHistorySnapshots(db, 1);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((item) => item.configurationCount), [1, 2]);
    assert.equal(listHistorySnapshots(db, 2).length, 1);
    const grouped = readHistorySnapshot(db, 1, list[1].id);
    assert.ok(grouped);
    assert.deepEqual(grouped.rows.map((row) => row.reportId), ids.slice(0, 2));
    assert.equal(grouped.rows[0].summary?.earnedPoints, 3);
    assert.equal(grouped.rows[0].summary?.completed, 7);
    assert.equal(grouped.createdAt, first.createdAt);
    assert.equal(grouped.scope.pathFilterEnabled, null);
    assert.match(grouped.name, /^\d{14}$/);
  } finally {
    db.close();
  }
});

test("rolls back the parent and all reports when any configuration cannot be saved", () => {
  const db = database();
  try {
    initializeHistorySnapshots(db);
    const invalid = report("Invalid");
    delete invalid.snapshot.summary;
    assert.throws(() => saveHistorySnapshot(db, {
      repositoryId: 1,
      scope,
      reports: [report("Valid"), invalid],
      savedAt: new Date(),
    }), /requires its aggregate summary/);
    assert.deepEqual(listHistorySnapshots(db, 1), []);
    assert.deepEqual(db.prepare("SELECT id FROM history_reports").all(), []);
    assert.throws(() => saveHistorySnapshot(db, {
      repositoryId: 1, scope, reports: [], savedAt: new Date(),
    }), /at least one configuration/);
  } finally {
    db.close();
  }
});
