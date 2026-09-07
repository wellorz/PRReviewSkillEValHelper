import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare(`
      SELECT number, baseline_status, baseline_duration_ms,
        baseline_findings_json, baseline_usage_json, baseline_metrics_json,
        baseline_error, baseline_completed_at
      FROM pull_requests WHERE id = ?
    `)
    .get(id) as
    | {
        number: number;
        baseline_status: string;
        baseline_duration_ms: number | null;
        baseline_findings_json: string | null;
        baseline_usage_json: string | null;
        baseline_metrics_json: string | null;
        baseline_error: string | null;
        baseline_completed_at: string | null;
      }
    | undefined;
  if (!row) {
    return NextResponse.json(
      { error: "Pull request baseline not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    pullRequest: row.number,
    status: row.baseline_status,
    durationMs: row.baseline_duration_ms,
    findings: row.baseline_findings_json
      ? JSON.parse(row.baseline_findings_json)
      : [],
    usage: row.baseline_usage_json
      ? JSON.parse(row.baseline_usage_json)
      : null,
    metrics: row.baseline_metrics_json
      ? JSON.parse(row.baseline_metrics_json)
      : null,
    error: row.baseline_error,
    completedAt: row.baseline_completed_at,
  });
}
