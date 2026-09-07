import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hasCurrentWorkflowWorkerVersion } from "@/lib/workflow-version";
import type { RepositoryRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["analyze", "analyze_apply_all"]),
  skillId: z.number().int().positive(),
  pullRequestIds: z.array(z.number().int().positive()).min(1),
  resultIds: z.array(z.number().int().positive()).min(1).optional(),
});

type EligibleResult = {
  id: number;
  pull_request_id: number;
  model: string;
  model_secondary: string;
  context_tier: string;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid analysis request" },
      { status: 400 },
    );
  }
  if (!hasCurrentWorkflowWorkerVersion()) {
    return NextResponse.json(
      { error: "Restart the worker before starting skill analysis." },
      { status: 409 },
    );
  }
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(id) as RepositoryRecord | undefined;
  if (!repository) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }
  const skill = db
    .prepare(`
      SELECT id FROM personal_review_skills
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .get(parsed.data.skillId, id) as { id: number } | undefined;
  if (!skill) {
    return NextResponse.json(
      { error: "Personal skill not found" },
      { status: 404 },
    );
  }
  const pullRequestIds = [...new Set(parsed.data.pullRequestIds)];
  if (pullRequestIds.length !== parsed.data.pullRequestIds.length) {
    return NextResponse.json(
      { error: "Analysis pull requests must be unique." },
      { status: 400 },
    );
  }
  let eligible: EligibleResult[];
  if (parsed.data.resultIds) {
    const resultIds = [...new Set(parsed.data.resultIds)];
    if (
      resultIds.length !== parsed.data.resultIds.length ||
      resultIds.length !== pullRequestIds.length
    ) {
      return NextResponse.json(
        { error: "Provide one unique review result for each pull request." },
        { status: 400 },
      );
    }
    const placeholders = resultIds.map(() => "?").join(",");
    eligible = db
      .prepare(`
        SELECT result.id, result.pull_request_id, result.model,
          result.model_secondary, result.context_tier
        FROM personal_skill_results result
        JOIN pull_requests pr ON pr.id = result.pull_request_id
        WHERE result.skill_id = ?
          AND result.status = 'completed'
          AND pr.repository_id = ?
          AND pr.active = 1
          AND result.id IN (${placeholders})
      `)
      .all(skill.id, repository.id, ...resultIds) as EligibleResult[];
    const requestedPrIds = new Set(pullRequestIds);
    if (
      eligible.length !== resultIds.length ||
      eligible.some((result) => !requestedPrIds.has(result.pull_request_id))
    ) {
      return NextResponse.json(
        {
          error:
            "Analysis requires each displayed review result to be completed and belong to its requested PR.",
        },
        { status: 409 },
      );
    }
  } else {
    const placeholders = pullRequestIds.map(() => "?").join(",");
    eligible = db
      .prepare(`
        SELECT result.id, result.pull_request_id, result.model,
          result.model_secondary, result.context_tier
        FROM personal_skill_results result
        JOIN pull_requests pr ON pr.id = result.pull_request_id
        WHERE result.skill_id = ?
          AND result.model = ?
          AND result.model_secondary = ?
          AND result.context_tier = ?
          AND result.status = 'completed'
          AND pr.repository_id = ?
          AND pr.active = 1
          AND result.pull_request_id IN (${placeholders})
      `)
      .all(
        skill.id,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
        repository.id,
        ...pullRequestIds,
      ) as EligibleResult[];
    if (eligible.length !== pullRequestIds.length) {
      return NextResponse.json(
        {
          error:
            "Analysis requires a completed result for every requested PR using the current review settings.",
        },
        { status: 409 },
      );
    }
  }
  const activeJob = db
    .prepare(`
      SELECT job.id
      FROM skill_analysis_jobs job
      WHERE job.skill_id = ?
        AND job.status IN ('queued', 'running')
        AND (
          job.mode = 'analyze_apply'
          OR ? = 'analyze_apply'
          OR EXISTS (
            SELECT 1
            FROM json_each(job.pr_ids_json) active_pr
            WHERE CAST(active_pr.value AS INTEGER) IN (
              ${pullRequestIds.map(() => "?").join(",")}
            )
          )
        )
      LIMIT 1
    `)
    .get(
      skill.id,
      parsed.data.action === "analyze_apply_all"
        ? "analyze_apply"
        : "analyze",
      ...pullRequestIds,
    );
  if (activeJob) {
    return NextResponse.json(
      {
        error:
          parsed.data.action === "analyze_apply_all"
            ? "Wait for this skill's active analyses before analyzing and applying changes."
            : "This PR already has an analysis queued or running.",
      },
      { status: 409 },
    );
  }
  const mode =
    parsed.data.action === "analyze_apply_all" ? "analyze_apply" : "analyze";
  const groups = new Map<string, EligibleResult[]>();
  for (const result of eligible) {
    const key = JSON.stringify([
      result.model,
      result.model_secondary,
      result.context_tier,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const create = db.transaction(() => {
    const insertJob = db.prepare(`
        INSERT INTO skill_analysis_jobs (
          repository_id, skill_id, mode, model, model_secondary,
          context_tier, pr_ids_json, total_items
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const upsert = db.prepare(`
      INSERT INTO skill_analysis_results (
        skill_id, pull_request_id, model, model_secondary, context_tier, status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
      ON CONFLICT(
        skill_id, pull_request_id, model, model_secondary, context_tier
      ) DO UPDATE SET
        status = 'pending',
        duration_ms = NULL,
        analysis_json = NULL,
        proposal_json = NULL,
        usage_json = NULL,
        raw_output = NULL,
        error = NULL,
        applied_at = NULL,
        application_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    `);
    const jobIds: number[] = [];
    for (const results of groups.values()) {
      const first = results[0];
      const groupPrIds = results.map((result) => result.pull_request_id);
      const inserted = insertJob.run(
        repository.id,
        skill.id,
        mode,
        first.model,
        first.model_secondary,
        first.context_tier,
        JSON.stringify(groupPrIds),
        groupPrIds.length,
      );
      jobIds.push(Number(inserted.lastInsertRowid));
      for (const result of results) {
        upsert.run(
          skill.id,
          result.pull_request_id,
          result.model,
          result.model_secondary,
          result.context_tier,
        );
      }
    }
    return jobIds;
  });
  return NextResponse.json({ jobIds: create() }, { status: 201 });
}
