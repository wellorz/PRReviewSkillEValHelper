"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageNavigation } from "@/app/page-navigation";
import {
  formatHistoryTimestamp,
  type HistorySnapshotListItem,
} from "@/lib/history-snapshots";

export default function HistoryReportsPage() {
  const { id } = useParams<{ id: string }>();
  const [snapshots, setSnapshots] = useState<HistorySnapshotListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/repositories/${id}/history-reports`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load reports");
      setSnapshots(body.snapshots as HistorySnapshotListItem[]);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="prWorkspace">
      <PageNavigation
        previous={{ href: `/repositories/${id}`, label: "Review Details" }}
        next={{ href: "/", label: "Dashboard" }}
      />
      <header className="workspaceHeader">
        <div>
          <span className="eyebrow">Immutable comparison snapshots</span>
          <h1>HistoryReports</h1>
          <p>Each Save report click preserves the comparison matrix as one snapshot.</p>
        </div>
        <div className="selectionCount">
          <strong>{snapshots.length}</strong>
          <span>saved snapshots</span>
        </div>
      </header>

      {error && <div className="notice">{error}</div>}

      <section className="panel resultSpreadsheetPanel">
        {snapshots.length === 0 ? (
          <div className="emptyState">
            <strong>No saved snapshots</strong>
            <span>Return to the workspace and click Save report.</span>
          </div>
        ) : (
          <div className="resultTableWrap">
            <table className="resultSpreadsheet">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>PRs</th>
                  <th>Configurations</th>
                  <th>Saved</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td>
                      <Link
                        href={`/repositories/${id}/history-reports/snapshots/${snapshot.id}`}
                      >
                        <strong>{snapshot.name}</strong>
                      </Link>
                      <small>Snapshot #{snapshot.id}</small>
                    </td>
                    <td>{snapshot.pullRequestCount}</td>
                    <td>{snapshot.configurationCount}</td>
                    <td>{formatHistoryTimestamp(snapshot.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
