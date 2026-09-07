import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  decodePrSetBundle,
  importPrSetBundle,
  MAX_PR_SET_ARCHIVE_BYTES,
} from "@/lib/pr-set-transfer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const db = getDb();
  const activeTask = db
    .prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM workflow_tasks
        WHERE status IN ('queued', 'running', 'cancelling')
      )
      OR EXISTS (
        SELECT 1 FROM skill_analysis_jobs
        WHERE status IN ('queued', 'running')
      )
      OR EXISTS (
        SELECT 1 FROM repositories
        WHERE status IN ('queued', 'syncing')
      )
      OR EXISTS (
        SELECT 1 FROM dataset_scan_runs
        WHERE status = 'running'
      )
    `)
    .get();
  if (activeTask) {
    return NextResponse.json(
      {
        error:
          "Wait for active PR collection, review, and skill-analysis tasks to finish before importing PR sets.",
      },
      { status: 409 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PR_SET_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "PR-set bundle exceeds the 512 MB compressed size limit" },
      { status: 413 },
    );
  }
  try {
    const archive = Buffer.from(await request.arrayBuffer());
    const bundle = await decodePrSetBundle(archive);
    const imported = await importPrSetBundle(db, bundle);
    return NextResponse.json(imported, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
