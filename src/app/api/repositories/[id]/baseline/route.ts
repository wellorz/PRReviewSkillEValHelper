import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { filterPullRequestsByChangedPath } from "@/lib/pr-path-filter";
import { hasCurrentWorkflowWorkerVersion } from "@/lib/workflow-version";
import { queueBaselineProfileResults } from "@/lib/workflow-result-queue";

const schema = z.object({
  pullRequestIds: z.array(z.number().int().positive()).min(1),
  profileIds: z.array(z.number().int().positive()).min(1).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  applyPathFilter: z.boolean().optional(),
  pathFilter: z.string().trim().max(2000).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select at least one PR" }, { status: 400 });
  }
  const db = getDb();
  const repository = db
    .prepare(
      "SELECT baseline_concurrency, local_repo_path, local_repo_branch FROM repositories WHERE id = ?",
    )
    .get(id) as
    | {
        baseline_concurrency: number;
        local_repo_path: string | null;
        local_repo_branch: string | null;
      }
    | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  if (!repository.local_repo_path) {
    return NextResponse.json(
      {
        error:
          "Set a verified local repository path before running baseline reviews.",
      },
      { status: 409 },
    );
  }
  if (!repository.local_repo_branch) {
    return NextResponse.json(
      {
        error:
          "Select and save a local repository branch before running baseline reviews.",
      },
      { status: 409 },
    );
  }
  const placeholders = parsed.data.pullRequestIds.map(() => "?").join(",");
  const requested = db
    .prepare(
      `SELECT id, dataset_path FROM pull_requests WHERE repository_id = ? AND active = 1 AND id IN (${placeholders})`,
    )
    .all(id, ...parsed.data.pullRequestIds) as Array<{
      id: number;
      dataset_path: string;
    }>;
  if (requested.length !== parsed.data.pullRequestIds.length) {
    return NextResponse.json({ error: "One or more PRs are invalid" }, { status: 400 });
  }
  const valid =
    parsed.data.applyPathFilter === false
      ? requested
      : await filterPullRequestsByChangedPath(
          requested,
          parsed.data.pathFilter,
        );
  if (valid.length === 0) {
    return NextResponse.json(
      { error: "No selected PR has a changed file under the path filter." },
      { status: 400 },
    );
  }
  const pullRequestIds = valid.map((pullRequest) => pullRequest.id);
  const profileIds = parsed.data.profileIds
    ? [...new Set(parsed.data.profileIds)]
    : null;
  if (profileIds) {
    if (!hasCurrentWorkflowWorkerVersion()) {
      return NextResponse.json(
        {
          error:
            "The workflow worker is stopped or running outdated code. Restart npm run dev:all, then retry.",
        },
        { status: 409 },
      );
    }
    const profilePlaceholders = profileIds.map(() => "?").join(",");
    const profiles = db
      .prepare(`
        SELECT id FROM baseline_profiles
        WHERE repository_id = ? AND active = 1
          AND id IN (${profilePlaceholders})
      `)
      .all(id, ...profileIds) as Array<{ id: number }>;
    if (profiles.length !== profileIds.length) {
      return NextResponse.json(
        { error: "One or more baseline profiles are invalid" },
        { status: 400 },
      );
    }
  }
  const totalItems = valid.length * (profileIds?.length ?? 1);
  const enqueue = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO workflow_tasks (repository_id, kind, pr_ids_json, payload_json, total_items) VALUES (?, 'baseline', ?, ?, ?)",
      )
      .run(
        id,
        JSON.stringify(pullRequestIds),
        JSON.stringify({
          concurrency:
            parsed.data.concurrency ?? repository.baseline_concurrency,
          ...(profileIds ? { profileIds } : {}),
          ...(profileIds
            ? {
                localRepoPath: repository.local_repo_path,
                localRepoBranch: repository.local_repo_branch,
              }
            : {}),
        }),
        totalItems,
      );
    if (profileIds) {
      queueBaselineProfileResults(db, { profileIds, pullRequestIds });
    }
    return result;
  });
  const result = enqueue();
  return NextResponse.json(
    {
      taskId: Number(result.lastInsertRowid),
      queuedPullRequests: pullRequestIds.length,
      filteredOut:
        parsed.data.pullRequestIds.length - pullRequestIds.length,
    },
    { status: 201 },
  );
}
