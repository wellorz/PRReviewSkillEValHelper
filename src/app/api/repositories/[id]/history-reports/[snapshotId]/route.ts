import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readHistorySnapshot } from "@/lib/history-snapshot-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; snapshotId: string }> },
) {
  const { id, snapshotId } = await context.params;
  const snapshot = readHistorySnapshot(getDb(), id, snapshotId);
  if (!snapshot) {
    return NextResponse.json({ error: "History snapshot not found" }, { status: 404 });
  }
  return NextResponse.json({ snapshot });
}
