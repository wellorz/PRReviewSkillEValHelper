import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const review = getDb()
    .prepare("SELECT result_path FROM quick_reviews WHERE id = ?")
    .get(id) as { result_path: string | null } | undefined;
  if (!review?.result_path) {
    return NextResponse.json({ error: "Review is not available" }, { status: 404 });
  }
  try {
    const report = await fs.readFile(review.result_path, "utf8");
    return new Response(report, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="quick-review-${id}.md"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Review file is missing" }, { status: 404 });
  }
}
