import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare(`
      SELECT id, repository_id, name, kind, configuration_name,
        earned_points, available_points, completed_count, failed_count,
        snapshot_json, created_at, snapshot_id
      FROM history_reports
      WHERE id = ?
    `)
    .get(id) as
    | {
        id: number;
        repository_id: number;
        name: string;
        kind: string;
        configuration_name: string;
        earned_points: number;
        available_points: number;
        completed_count: number;
        failed_count: number;
        snapshot_json: string;
        created_at: string;
        snapshot_id: number | null;
      }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "History report not found" }, { status: 404 });
  }
  return NextResponse.json({
    report: {
      ...row,
      snapshot_json: undefined,
      snapshot: JSON.parse(row.snapshot_json),
    },
  });
}
