"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ComparisonMatrix } from "@/app/comparison-matrix";
import { PageNavigation } from "@/app/page-navigation";
import {
  formatHistoryTimestamp,
  type HistorySnapshot,
} from "@/lib/history-snapshots";

export default function HistorySnapshotPage() {
  const { id, snapshotId } = useParams<{ id: string; snapshotId: string }>();
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/repositories/${id}/history-reports/${snapshotId}`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load snapshot");
      setSnapshot(body.snapshot as HistorySnapshot);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [id, snapshotId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="prWorkspace">
      <PageNavigation
        previous={{
          href: `/repositories/${id}/history-reports`,
          label: "History Reports",
        }}
        next={{ href: `/repositories/${id}`, label: "Review Details" }}
      />
      {!snapshot ? (
        <div className="panel loadingPanel">{error ?? "Loading snapshot..."}</div>
      ) : (
        <>
          <header className="workspaceHeader">
            <div>
              <span className="eyebrow">Saved comparison snapshot</span>
              <h1>{snapshot.name}</h1>
              <p>Saved {formatHistoryTimestamp(snapshot.createdAt)}</p>
              <p>Scores, names, and states are frozen at save time.</p>
              {snapshot.scope.pathFilterEnabled === null ? (
                <p>Imported from earlier reports; original filter settings were not recorded.</p>
              ) : snapshot.scope.pathFilterEnabled && snapshot.scope.pathFilter ? (
                <p>Changed file path: <code>{snapshot.scope.pathFilter}</code></p>
              ) : (
                <p>No changed-file path restriction.</p>
              )}
            </div>
            <div className="selectionCount">
              <strong>{snapshot.scope.pullRequestNumbers.length}</strong>
              <span>PRs &middot; {snapshot.rows.length} configurations</span>
            </div>
          </header>
          <ComparisonMatrix
            rows={snapshot.rows.map((row) => ({
              ...row,
              href: `/repositories/${id}/history-reports/${row.reportId}`,
            }))}
          />
        </>
      )}
    </main>
  );
}
