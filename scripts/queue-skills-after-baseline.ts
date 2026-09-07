import { getDb } from "../src/lib/db";

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function queuedPullRequestIds(
  db: ReturnType<typeof getDb>,
  repositoryId: number,
) {
  const rows = db
    .prepare(`
      SELECT pr_ids_json
      FROM workflow_tasks
      WHERE repository_id = ? AND kind = 'skill_eval'
        AND status IN ('queued', 'running')
    `)
    .all(repositoryId) as Array<{ pr_ids_json: string }>;
  return new Set(
    rows.flatMap((row) => JSON.parse(row.pr_ids_json) as number[]),
  );
}

async function main() {
  const repositoryId = Number(process.argv[2] ?? 1);
  const batchSize = Math.max(1, Math.min(50, Number(process.argv[3] ?? 10)));
  const pollMs = Math.max(2_000, Number(process.argv[4] ?? 5_000));
  const db = getDb();
  while (true) {
    const repository = db
      .prepare(`
        SELECT model, model_secondary, context_tier, baseline_concurrency,
          local_repo_path, local_repo_branch
        FROM repositories
        WHERE id = ?
      `)
      .get(repositoryId) as
      | {
          model: string;
          model_secondary: string;
          context_tier: string;
          baseline_concurrency: number;
          local_repo_path: string | null;
          local_repo_branch: string | null;
        }
      | undefined;
    if (!repository?.local_repo_path || !repository.local_repo_branch) {
      throw new Error("Repository review settings are incomplete");
    }
    const profile = db
      .prepare(`
        SELECT id
        FROM baseline_profiles
        WHERE repository_id = ? AND active = 1 AND model = ?
          AND model_secondary = ? AND context_tier = ?
      `)
      .get(
        repositoryId,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
      ) as { id: number } | undefined;
    if (!profile) {
      throw new Error("The matching baseline profile does not exist");
    }
    const skillIds = (
      db
        .prepare(`
        SELECT id
        FROM personal_review_skills
        WHERE repository_id = ? AND active = 1
        ORDER BY id
      `)
        .all(repositoryId) as Array<{ id: number }>
    ).map((row) => row.id);
    if (skillIds.length === 0) {
      throw new Error("No active personal skills are configured");
    }
    const queued = queuedPullRequestIds(db, repositoryId);
    const totals = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM pull_requests
            WHERE repository_id = ? AND active = 1) AS pull_requests,
          (SELECT COUNT(*) FROM baseline_profile_results result
            JOIN pull_requests pr ON pr.id = result.pull_request_id
            WHERE pr.repository_id = ? AND pr.active = 1
              AND result.profile_id = ?
              AND result.status = 'completed') AS baseline_completed,
          (SELECT COUNT(*) FROM baseline_profile_results result
            JOIN pull_requests pr ON pr.id = result.pull_request_id
            WHERE pr.repository_id = ? AND pr.active = 1
              AND result.profile_id = ?
              AND result.status IN ('completed', 'failed')) AS baseline_terminal,
          (SELECT COUNT(*) FROM personal_skill_results result
            JOIN pull_requests pr ON pr.id = result.pull_request_id
            WHERE pr.repository_id = ? AND pr.active = 1
              AND result.skill_id IN (
                SELECT id FROM personal_review_skills
                WHERE repository_id = ? AND active = 1
              )
              AND result.model = ?
              AND result.model_secondary = ?
              AND result.context_tier = ?
              AND result.status IN ('completed', 'failed')) AS skill_terminal
      `)
      .get(
        repositoryId,
        repositoryId,
        profile.id,
        repositoryId,
        profile.id,
        repositoryId,
        repositoryId,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
      ) as {
      pull_requests: number;
      baseline_completed: number;
      baseline_terminal: number;
      skill_terminal: number;
    };
    const ready = db
      .prepare(`
      SELECT pr.id
      FROM pull_requests pr
      JOIN baseline_profile_results baseline
        ON baseline.pull_request_id = pr.id
       AND baseline.profile_id = ?
       AND baseline.status = 'completed'
      WHERE pr.repository_id = ? AND pr.active = 1
        AND (
          SELECT COUNT(DISTINCT result.skill_id)
          FROM personal_skill_results result
          WHERE result.pull_request_id = pr.id
            AND result.skill_id IN (
              SELECT id FROM personal_review_skills
              WHERE repository_id = ? AND active = 1
            )
            AND result.model = ?
            AND result.model_secondary = ?
            AND result.context_tier = ?
            AND result.status = 'completed'
        ) < ?
        AND NOT EXISTS (
          SELECT 1
          FROM personal_skill_results result
          WHERE result.pull_request_id = pr.id
            AND result.skill_id IN (
              SELECT id FROM personal_review_skills
              WHERE repository_id = ? AND active = 1
            )
            AND result.model = ?
            AND result.model_secondary = ?
            AND result.context_tier = ?
            AND result.status IN ('pending', 'running')
        )
      ORDER BY pr.number
    `)
      .all(
        profile.id,
        repositoryId,
        repositoryId,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
        skillIds.length,
        repositoryId,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
      ) as Array<{ id: number }>;
    const unqueued = ready
      .map((row) => row.id)
      .filter((id) => !queued.has(id));
    const flushRemainder =
      totals.baseline_terminal === totals.pull_requests;
    const batch =
      unqueued.length >= batchSize || flushRemainder
        ? unqueued.slice(0, batchSize)
        : [];
    if (batch.length > 0) {
      const prPlaceholders = batch.map(() => "?").join(",");
      const skillPlaceholders = skillIds.map(() => "?").join(",");
      db.prepare(`
        UPDATE personal_skill_results SET
          status = 'pending',
          error = NULL,
          completed_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE pull_request_id IN (${prPlaceholders})
          AND skill_id IN (${skillPlaceholders})
          AND model = ?
          AND model_secondary = ?
          AND context_tier = ?
          AND status = 'failed'
      `).run(
        ...batch,
        ...skillIds,
        repository.model,
        repository.model_secondary,
        repository.context_tier,
      );
      db.prepare(`
      INSERT INTO workflow_tasks (
        repository_id, kind, pr_ids_json, payload_json, total_items
      ) VALUES (?, 'skill_eval', ?, ?, ?)
      `).run(
        repositoryId,
        JSON.stringify(batch),
        JSON.stringify({
          concurrency: repository.baseline_concurrency,
          skillIds,
          baselineProfileId: profile.id,
          model: repository.model,
          modelSecondary: repository.model_secondary,
          contextTier: repository.context_tier,
          localRepoPath: repository.local_repo_path,
          localRepoBranch: repository.local_repo_branch,
        }),
        batch.length * skillIds.length,
      );
      process.stdout.write(
        `Queued personal skills for ${batch.length} completed baseline PRs\n`,
      );
    }
    const activeSkillTasks = db
      .prepare(`
        SELECT COUNT(*) count
        FROM workflow_tasks
        WHERE repository_id = ? AND kind = 'skill_eval'
          AND status IN ('queued', 'running')
      `)
      .get(repositoryId) as { count: number };
    if (
      totals.baseline_terminal === totals.pull_requests &&
      totals.skill_terminal === totals.baseline_completed * skillIds.length &&
      activeSkillTasks.count === 0 &&
      batch.length === 0
    ) {
      process.stdout.write("All matching personal skill reruns are terminal\n");
      break;
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
