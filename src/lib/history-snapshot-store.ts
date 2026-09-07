import type Database from "better-sqlite3";
import { summarizeComparisonResults } from "@/lib/comparison-matrix";
import {
  historyConfigurationDescription,
  historySnapshotName,
  historyTimestampIso,
  type HistoryConfigurationSnapshot,
  type HistorySnapshot,
  type HistorySnapshotListItem,
  type HistorySnapshotScope,
} from "@/lib/history-snapshots";

type StoredReport = {
  id: number;
  repository_id: number;
  kind: "baseline" | "personal-skill";
  configuration_name: string;
  earned_points: number;
  available_points: number;
  completed_count: number;
  failed_count: number;
  snapshot_json: string;
  created_at: string;
};

export type HistoryReportToSave = {
  kind: "baseline" | "personal-skill";
  configurationName: string;
  snapshot: HistoryConfigurationSnapshot;
};

export function initializeHistorySnapshots(db: Database.Database) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scope_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_snapshots_repository
        ON history_snapshots(repository_id, id DESC);
    `);
    const columns = db.prepare("PRAGMA table_info(history_reports)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "snapshot_id")) {
      db.exec(`
        ALTER TABLE history_reports ADD COLUMN snapshot_id INTEGER
          REFERENCES history_snapshots(id) ON DELETE CASCADE;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_reports_snapshot
        ON history_reports(snapshot_id, id);
    `);
    const legacy = db.prepare(`
      SELECT id, repository_id, snapshot_json, created_at
      FROM history_reports WHERE snapshot_id IS NULL ORDER BY id
    `).all() as Pick<StoredReport, "id" | "repository_id" | "snapshot_json" | "created_at">[];
    const groups = new Map<string, {
      repositoryId: number;
      createdAt: string;
      reportIds: number[];
      numbers: Set<number>;
    }>();
    for (const report of legacy) {
      const snapshot = JSON.parse(report.snapshot_json) as HistoryConfigurationSnapshot;
      const createdAt = historyTimestampIso(snapshot.createdAt ?? report.created_at);
      const key = `${report.repository_id}:${createdAt}`;
      let group = groups.get(key);
      if (!group) {
        group = { repositoryId: report.repository_id, createdAt, reportIds: [], numbers: new Set() };
        groups.set(key, group);
      }
      group.reportIds.push(report.id);
      for (const result of snapshot.results) {
        group.numbers.add(result.pullRequest.number);
      }
    }
    const insert = db.prepare(`
      INSERT INTO history_snapshots (repository_id, name, created_at, scope_json)
      VALUES (?, ?, ?, ?)
    `);
    const attach = db.prepare("UPDATE history_reports SET snapshot_id = ? WHERE id = ?");
    for (const group of groups.values()) {
      const scope: HistorySnapshotScope = {
        pullRequestNumbers: [...group.numbers].sort((a, b) => a - b),
        pathFilter: null,
        pathFilterEnabled: null,
      };
      const saved = insert.run(
        group.repositoryId,
        historySnapshotName(new Date(group.createdAt)),
        group.createdAt,
        JSON.stringify(scope),
      );
      for (const reportId of group.reportIds) {
        attach.run(Number(saved.lastInsertRowid), reportId);
      }
    }
  }).immediate();
}

export function saveHistorySnapshot(
  db: Database.Database,
  options: {
    repositoryId: number;
    scope: HistorySnapshotScope;
    reports: HistoryReportToSave[];
    savedAt: Date;
  },
) {
  if (options.reports.length === 0) {
    throw new Error("A history snapshot requires at least one configuration.");
  }
  const name = historySnapshotName(options.savedAt);
  const createdAt = options.savedAt.toISOString();
  return db.transaction(() => {
    const parent = db.prepare(`
      INSERT INTO history_snapshots (repository_id, name, created_at, scope_json)
      VALUES (?, ?, ?, ?)
    `).run(options.repositoryId, name, createdAt, JSON.stringify(options.scope));
    const snapshotId = Number(parent.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO history_reports (
        repository_id, snapshot_id, name, kind, configuration_name,
        earned_points, available_points, completed_count, failed_count,
        snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const reports = options.reports.map((report) => {
      const snapshot = { ...report.snapshot, createdAt };
      const summary = snapshot.summary;
      if (!summary) throw new Error("A saved comparison requires its aggregate summary.");
      const reportName = `${report.configurationName} ${name}`;
      const result = insert.run(
        options.repositoryId,
        snapshotId,
        reportName,
        report.kind,
        report.configurationName,
        summary.earnedPoints,
        summary.availablePoints,
        summary.completed,
        summary.failed,
        JSON.stringify(snapshot),
        createdAt,
      );
      return { id: Number(result.lastInsertRowid), name: reportName };
    });
    return { snapshot: { id: snapshotId, name, createdAt }, reports, saved: reports.length };
  })();
}

export function listHistorySnapshots(
  db: Database.Database,
  repositoryId: number | string,
): HistorySnapshotListItem[] {
  const rows = db.prepare(`
    SELECT snapshot.id, snapshot.name, snapshot.created_at, snapshot.scope_json,
      COUNT(report.id) AS configuration_count
    FROM history_snapshots snapshot
    LEFT JOIN history_reports report ON report.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ?
    GROUP BY snapshot.id
    ORDER BY snapshot.id DESC
  `).all(repositoryId) as Array<{
    id: number;
    name: string;
    created_at: string;
    scope_json: string;
    configuration_count: number;
  }>;
  return rows.map((row) => {
    const scope = JSON.parse(row.scope_json) as HistorySnapshotScope;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      pullRequestCount: scope.pullRequestNumbers.length,
      configurationCount: row.configuration_count,
    };
  });
}

export function readHistorySnapshot(
  db: Database.Database,
  repositoryId: number | string,
  snapshotId: number | string,
): HistorySnapshot | null {
  const row = db.prepare(`
    SELECT id, repository_id, name, created_at, scope_json
    FROM history_snapshots WHERE repository_id = ? AND id = ?
  `).get(repositoryId, snapshotId) as {
    id: number;
    repository_id: number;
    name: string;
    created_at: string;
    scope_json: string;
  } | undefined;
  if (!row) return null;
  const reports = db.prepare(`
    SELECT id, kind, configuration_name, earned_points, available_points,
      completed_count, failed_count, snapshot_json
    FROM history_reports WHERE snapshot_id = ? ORDER BY id
  `).all(row.id) as StoredReport[];
  return {
    id: row.id,
    repositoryId: row.repository_id,
    name: row.name,
    createdAt: row.created_at,
    scope: JSON.parse(row.scope_json) as HistorySnapshotScope,
    rows: reports.map((report) => {
      const snapshot = JSON.parse(report.snapshot_json) as HistoryConfigurationSnapshot;
      const summary = snapshot.summary ?? {
        ...summarizeComparisonResults(
          snapshot.results.map((result) => ({
            status: result.status,
            earnedPoints: result.metrics?.earnedPoints ?? 0,
          })),
          snapshot.results.length,
          report.available_points,
        ),
        earnedPoints: report.earned_points,
        percentage: report.available_points > 0
          ? (report.earned_points / report.available_points) * 100
          : null,
        completed: report.completed_count,
        failed: report.failed_count,
      };
      return {
        id: report.id,
        reportId: report.id,
        name: report.configuration_name,
        description: historyConfigurationDescription({
          ...snapshot.configuration,
          kind: report.kind,
        }),
        kind: report.kind,
        summary,
      };
    }),
  };
}
