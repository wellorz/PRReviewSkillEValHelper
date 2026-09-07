import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const run = getDb()
    .prepare("SELECT summary_path FROM runs WHERE id = ?")
    .get(id) as { summary_path: string | null } | undefined;
  if (!run?.summary_path) {
    return NextResponse.json({ error: "Report is not available" }, { status: 404 });
  }
  try {
    const report = await fs.readFile(run.summary_path, "utf8");
    return new Response(report, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="run-${id}-summary.md"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Report file is missing" }, { status: 404 });
  }
}
