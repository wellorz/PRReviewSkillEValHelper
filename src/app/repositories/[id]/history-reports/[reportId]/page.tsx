"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageNavigation } from "@/app/page-navigation";
import { formatHistoryTimestamp } from "@/lib/history-snapshots";

type Finding = {
  title: string;
  description: string;
  severity: string;
  file: string | null;
  lineStart: number | null;
};

type SnapshotResult = {
  pullRequest: {
    number: number;
    title: string;
    url: string;
    author: string;
    valuedCommentCount: number;
  };
  status: string;
  durationMs: number | null;
  completedAt?: string | null;
  repositoryCommit: string | null;
  summary: string;
  metrics: {
    earnedPoints: number;
    availablePoints: number;
    f1: number;
  } | null;
  findings: Finding[];
  rawOutput: string | null;
  error: string | null;
};

type HistoryReport = {
  id: number;
  name: string;
  kind: string;
  earned_points: number;
  available_points: number;
  completed_count: number;
  failed_count: number;
  created_at: string;
  snapshot_id: number | null;
  snapshot: {
    configuration: {
      name: string;
      model: string;
      modelSecondary: string;
      contextTier: string;
    };
    results: SnapshotResult[];
  };
};

function duration(value: number | null) {
  return value == null ? "—" : `${(value / 1000).toFixed(1)}s`;
}

function highestSeverity(findings: Finding[]) {
  return (
    ["critical", "high", "medium", "low"].find((severity) =>
      findings.some((finding) => finding.severity === severity),
    ) ?? "none"
  ).toUpperCase();
}

export default function HistoryReportPage() {
  const { id, reportId } = useParams<{ id: string; reportId: string }>();
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/history-reports/${reportId}`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load report");
      setReport(body.report as HistoryReport);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  }, [reportId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!report) {
    return (
      <main className="prWorkspace">
        <PageNavigation
          previous={{
            href: `/repositories/${id}/history-reports`,
            label: "History Reports",
          }}
          next={{ href: `/repositories/${id}`, label: "Review Details" }}
        />
        <div className="panel loadingPanel">{error ?? "Loading report…"}</div>
      </main>
    );
  }

  return (
    <main className="prWorkspace">
      <PageNavigation
        previous={{
          href: report.snapshot_id
            ? `/repositories/${id}/history-reports/snapshots/${report.snapshot_id}`
            : `/repositories/${id}/history-reports`,
          label: report.snapshot_id ? "Saved Snapshot" : "History Reports",
        }}
        next={{ href: `/repositories/${id}`, label: "Review Details" }}
      />
      <header className="workspaceHeader">
        <div>
          <span className="eyebrow">Saved review snapshot</span>
          <h1>{report.name}</h1>
          <p>
            {report.snapshot.configuration.model}
            {report.snapshot.configuration.modelSecondary !== "none"
              ? ` + ${report.snapshot.configuration.modelSecondary}`
              : ""}{" "}
            · {report.snapshot.configuration.contextTier}
          </p>
        </div>
        <div className="selectionCount">
          <strong>
            {report.available_points > 0
              ? `${((report.earned_points / report.available_points) * 100).toFixed(1)}%`
              : "—"}
          </strong>
          <span>
            {report.earned_points}/{report.available_points} credits ·{" "}
            {formatHistoryTimestamp(report.created_at)}
          </span>
        </div>
      </header>

      <section className="panel resultSpreadsheetPanel">
        <div className="resultTableWrap">
          <table className="resultSpreadsheet">
            <thead>
              <tr>
                <th>PR Info</th>
                <th>Status</th>
                <th>Score</th>
                <th>Review result</th>
              </tr>
            </thead>
            <tbody>
              {report.snapshot.results.map((result) => (
                <tr key={result.pullRequest.number}>
                  <td className="prNameCell">
                    <a
                      href={result.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{result.pullRequest.number}
                    </a>{" "}
                    {result.pullRequest.title}
                    <small>
                      {result.pullRequest.author} ·{" "}
                      {result.pullRequest.valuedCommentCount} findings
                    </small>
                  </td>
                  <td>
                    {result.status}
                    <small>{duration(result.durationMs)}</small>
                    {result.completedAt && (
                      <small>Completed {formatHistoryTimestamp(result.completedAt)}</small>
                    )}
                  </td>
                  <td>
                    {result.metrics
                      ? result.metrics.availablePoints > 0
                        ? `${((result.metrics.earnedPoints / result.metrics.availablePoints) * 100).toFixed(1)}%`
                        : "—"
                      : "—"}
                    <small>
                      {result.metrics
                        ? `${result.metrics.earnedPoints}/${result.metrics.availablePoints} credits · `
                        : ""}
                      F1{" "}
                      {result.metrics
                        ? `${(result.metrics.f1 * 100).toFixed(1)}%`
                        : "—"}
                    </small>
                  </td>
                  <td className="historyReviewCell">
                    {result.summary && (
                      <>
                        <strong>Summary</strong>
                        <p>{result.summary}</p>
                        <strong>
                          Severity: {highestSeverity(result.findings)}
                        </strong>
                      </>
                    )}
                    {result.findings.map((finding, index) => (
                      <details key={`${finding.title}-${index}`}>
                        <summary>
                          {finding.severity.toUpperCase()} — {finding.title}
                        </summary>
                        <p>{finding.description}</p>
                        <small>
                          {finding.file ?? "No file"}
                          {finding.lineStart ? `:${finding.lineStart}` : ""}
                        </small>
                      </details>
                    ))}
                    {result.error && <pre>{result.error}</pre>}
                    {result.rawOutput && (
                      <details>
                        <summary>Raw saved output</summary>
                        <pre>{result.rawOutput}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
