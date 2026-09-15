import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { RepositoryRecord } from "@/lib/types";
import { workerAvailableForRepository } from "@/lib/worker-availability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  skillId: z.number().int().positive(),
  pullRequestIds: z.array(z.number().int().positive()).min(1),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Select one personal skill and at least one PR." },
      { status: 400 },
    );
  }
  const pullRequestIds = [...new Set(parsed.data.pullRequestIds)];
  if (pullRequestIds.length !== parsed.data.pullRequestIds.length) {
    return NextResponse.json(
      { error: "Training pull requests must be unique." },
      { status: 400 },
    );
  }
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  if (!repository.local_repo_path || !repository.local_repo_branch) {
    return NextResponse.json(
      {
        error:
          "Set and save a verified Local repository path and branch before training.",
      },
      { status: 409 },
    );
  }
  if (!workerAvailableForRepository(repository)) {
    return NextResponse.json(
      {
        error:
          "The workflow worker is stopped or outdated. Restart npm run dev:all, then retry.",
      },
      { status: 409 },
    );
  }
  const skill = db
    .prepare(`
      SELECT id, name FROM personal_review_skills
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .get(parsed.data.skillId, repository.id) as
    | { id: number; name: string }
    | undefined;
  if (!skill) {
    return NextResponse.json(
      { error: "Selected personal skill was not found." },
      { status: 404 },
    );
  }
  const placeholders = pullRequestIds.map(() => "?").join(",");
  const validPullRequests = db
    .prepare(`
      SELECT id FROM pull_requests
      WHERE repository_id = ? AND active = 1
        AND id IN (${placeholders})
    `)
    .all(repository.id, ...pullRequestIds) as Array<{ id: number }>;
  if (validPullRequests.length !== pullRequestIds.length) {
    return NextResponse.json(
      { error: "One or more selected PRs are unavailable." },
      { status: 400 },
    );
  }
  const active = db
    .prepare(`
      SELECT id FROM skill_training_jobs
      WHERE repository_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `)
    .get(repository.id);
  if (active) {
    return NextResponse.json(
      { error: "A personal skill training job is already active." },
      { status: 409 },
    );
  }
  const result = db
    .prepare(`
      INSERT INTO skill_training_jobs (
        repository_id, skill_id, pr_ids_json, current_pr_ids_json,
        max_iterations, total_items, status_message
      ) VALUES (?, ?, ?, ?, 5, ?, ?)
    `)
    .run(
      repository.id,
      skill.id,
      JSON.stringify(pullRequestIds),
      JSON.stringify(pullRequestIds),
      pullRequestIds.length,
      `Waiting to train "${skill.name}" on ${pullRequestIds.length} PRs`,
    );
  return NextResponse.json(
    {
      jobId: Number(result.lastInsertRowid),
      skillName: skill.name,
      pullRequestCount: pullRequestIds.length,
      maxIterations: 5,
    },
    { status: 201 },
  );
}
