import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = getDb()
    .prepare("SELECT skill_report_path FROM pull_requests WHERE id = ?")
    .get(id) as { skill_report_path: string | null } | undefined;
  if (!row?.skill_report_path) {
    return NextResponse.json({ error: "Evaluation report not found" }, { status: 404 });
  }
  const content = await fs.readFile(row.skill_report_path, "utf8");
  return new Response(content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
