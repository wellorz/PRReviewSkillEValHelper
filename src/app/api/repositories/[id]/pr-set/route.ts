import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { loadGroundTruth } from "@/lib/ground-truth";
import type { RepositoryRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PrRow = {
  id: number;
  number: number;
  title: string;
  url: string;
  author: string;
  changed_files: number;
  dataset_path: string;
  defect_description: string | null;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const pullRequests = db
    .prepare(`
      SELECT id, number, title, url, author, changed_files, dataset_path,
        defect_description
      FROM pull_requests
      WHERE repository_id = ? AND active = 1
      ORDER BY manual DESC, created_at DESC, updated_at DESC
    `)
    .all(id) as PrRow[];
  const rows = await Promise.all(
    pullRequests.map(async (pr) => {
      const defects = (await loadGroundTruth(pr))
        .filter((finding) => (finding.scorePoint ?? 1) === 1)
        .map((finding) => ({
          id: finding.id,
          body: finding.normalizedBody ?? finding.body,
          originalBody: finding.body,
          path: finding.path,
          line: finding.line ?? finding.originalLine,
          author: finding.author,
          manual: finding.id.startsWith("manual-defect-"),
        }));
      return {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        changedFiles: pr.changed_files,
        defects,
      };
    }),
  );
  return NextResponse.json({
    repository: {
      id: repository.id,
      displayName: repository.display_name,
      slug: repository.slug,
    },
    pullRequests: rows,
  });
}
