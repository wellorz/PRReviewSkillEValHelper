import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { filterPullRequestsByChangedPath } from "@/lib/pr-path-filter";
import { hasCurrentWorkflowWorkerVersion } from "@/lib/workflow-version";
import { queuePersonalSkillResults } from "@/lib/workflow-result-queue";

const schema = z.object({
  pullRequestIds: z.array(z.number().int().positive()).min(1),
  skillIds: z.array(z.number().int().positive()).min(1).optional(),
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
    .prepare(`
      SELECT baseline_concurrency, model, model_secondary, context_tier
        , local_repo_path, local_repo_branch
      FROM repositories WHERE id = ?
    `)
    .get(id) as
    | {
        baseline_concurrency: number;
        model: string;
        model_secondary: string;
        context_tier: string;
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
          "Set a verified local repository path before evaluating personal skills.",
      },
      { status: 409 },
    );
  }
  if (!repository.local_repo_branch) {
    return NextResponse.json(
      {
        error:
          "Select and save a local repository branch before evaluating personal skills.",
      },
      { status: 409 },
    );
  }
  const placeholders = parsed.data.pullRequestIds.map(() => "?").join(",");
  const requestedRows = db
    .prepare(
      `SELECT id, dataset_path FROM pull_requests WHERE repository_id = ? AND active = 1 AND id IN (${placeholders})`,
    )
    .all(id, ...parsed.data.pullRequestIds) as Array<{
      id: number;
      dataset_path: string;
    }>;
  if (requestedRows.length !== parsed.data.pullRequestIds.length) {
    return NextResponse.json({ error: "One or more PRs are invalid" }, { status: 400 });
  }
  const rows =
    parsed.data.applyPathFilter === false
      ? requestedRows
      : await filterPullRequestsByChangedPath(
          requestedRows,
          parsed.data.pathFilter,
        );
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No selected PR has a changed file under the path filter." },
      { status: 400 },
    );
  }
  const pullRequestIds = rows.map((pullRequest) => pullRequest.id);
  const skillIds = parsed.data.skillIds
    ? [...new Set(parsed.data.skillIds)]
    : null;
  if (skillIds) {
    if (!hasCurrentWorkflowWorkerVersion()) {
      return NextResponse.json(
        {
          error:
            "The workflow worker is stopped or running outdated code. Restart npm run dev:all, then retry.",
        },
        { status: 409 },
      );
    }
    const skillPlaceholders = skillIds.map(() => "?").join(",");
    const skills = db
      .prepare(`
        SELECT id FROM personal_review_skills
        WHERE repository_id = ? AND active = 1
          AND id IN (${skillPlaceholders})
      `)
      .all(id, ...skillIds) as Array<{ id: number }>;
    if (skills.length !== skillIds.length) {
      return NextResponse.json(
        { error: "One or more personal skills are invalid" },
        { status: 400 },
      );
    }
  } else {
    return NextResponse.json(
      {
        error:
          "Select at least one named personal skill for an independent evaluation.",
      },
      { status: 400 },
    );
  }
  const totalItems = rows.length * (skillIds?.length ?? 1);
  const enqueue = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO workflow_tasks (repository_id, kind, pr_ids_json, payload_json, total_items) VALUES (?, 'skill_eval', ?, ?, ?)",
      )
      .run(
        id,
        JSON.stringify(pullRequestIds),
        JSON.stringify({
          concurrency:
            parsed.data.concurrency ?? repository.baseline_concurrency,
          ...(skillIds
            ? {
                skillIds,
                  model: repository.model,
                modelSecondary: repository.model_secondary,
                contextTier: repository.context_tier,
                localRepoPath: repository.local_repo_path,
                localRepoBranch: repository.local_repo_branch,
              }
            : {}),
        }),
        totalItems,
      );
    if (skillIds) {
      queuePersonalSkillResults(db, {
        skillIds,
        pullRequestIds,
        model: repository.model,
        modelSecondary: repository.model_secondary,
        contextTier: repository.context_tier,
      });
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
