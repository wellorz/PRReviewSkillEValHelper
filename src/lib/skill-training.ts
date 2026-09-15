import { getDb } from "@/lib/db";
import {
  executeSkillAnalysisJob,
  type SkillAnalysisJob,
} from "@/lib/skill-analysis";
import {
  personalSkillResultConfiguration,
} from "@/lib/personal-skill-execution";
import type {
  PersonalReviewSkillRecord,
  RepositoryRecord,
} from "@/lib/types";
import {
  executeWorkflowTask,
  type WorkflowTask,
} from "@/lib/workflow";
import {
  runWithWorkflowCancellation,
  throwIfWorkflowCancelled,
  WorkflowCancellationError,
} from "@/lib/workflow-cancellation";
import { queuePersonalSkillResults } from "@/lib/workflow-result-queue";

export type SkillTrainingJob = {
  id: number;
  repository_id: number;
  skill_id: number;
  status: string;
  pr_ids_json: string;
  current_pr_ids_json: string;
  current_iteration: number;
  max_iterations: number;
  current_item: number;
  total_items: number;
  status_message: string;
  history_json: string;
};

type TrainingHistoryEntry = {
  iteration: number;
  reviewed: number;
  zeroCredit: number;
  reviewTaskId: number;
  analysisJobId?: number;
};

function parseIds(value: string) {
  return [...new Set(JSON.parse(value) as number[])];
}

export function trainingMetricsScore(value: string | null) {
  if (!value) return null;
  try {
    const metrics = JSON.parse(value) as Record<string, unknown>;
    return {
      earned: Number(metrics.earnedPoints ?? metrics.truePositives ?? 0),
      available: Number(
        metrics.availablePoints ??
          Number(metrics.earnedPoints ?? metrics.truePositives ?? 0) +
            Number(metrics.falseNegatives ?? 0),
      ),
    };
  } catch {
    return null;
  }
}

function updateTrainingHistory(
  jobId: number,
  entry: TrainingHistoryEntry,
) {
  const db = getDb();
  const row = db
    .prepare("SELECT history_json FROM skill_training_jobs WHERE id = ?")
    .get(jobId) as { history_json: string } | undefined;
  const history = row
    ? (JSON.parse(row.history_json || "[]") as TrainingHistoryEntry[])
    : [];
  const next = [
    ...history.filter((item) => item.iteration !== entry.iteration),
    entry,
  ].sort((left, right) => left.iteration - right.iteration);
  db.prepare(`
    UPDATE skill_training_jobs
    SET history_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(JSON.stringify(next), jobId);
}

function resultConfiguration(
  repository: RepositoryRecord,
  skill: PersonalReviewSkillRecord,
) {
  return personalSkillResultConfiguration(skill.execution_mode, {
    model: repository.model,
    modelSecondary: repository.model_secondary,
    contextTier: repository.context_tier,
  });
}

function zeroCreditPullRequests(options: {
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestIds: number[];
}) {
  const db = getDb();
  const configuration = resultConfiguration(options.repository, options.skill);
  const placeholders = options.pullRequestIds.map(() => "?").join(",");
  const rows = db
    .prepare(`
      SELECT pull_request_id, status, metrics_json, error
      FROM personal_skill_results
      WHERE skill_id = ?
        AND model = ? AND model_secondary = ? AND context_tier = ?
        AND pull_request_id IN (${placeholders})
    `)
    .all(
      options.skill.id,
      configuration.model,
      configuration.modelSecondary,
      configuration.contextTier,
      ...options.pullRequestIds,
    ) as Array<{
    pull_request_id: number;
    status: string;
    metrics_json: string | null;
    error: string | null;
  }>;
  if (rows.length !== options.pullRequestIds.length) {
    throw new Error("Training review did not produce a result for every PR");
  }
  const incomplete = rows.find((row) => row.status !== "completed");
  if (incomplete) {
    throw new Error(
      `Training review did not complete for PR ${incomplete.pull_request_id}: ${incomplete.error ?? incomplete.status}`,
    );
  }
  return rows.flatMap((row) => {
    const score = trainingMetricsScore(row.metrics_json);
    if (!score) {
      throw new Error(
        `Training review produced no score for PR ${row.pull_request_id}`,
      );
    }
    return score.available > 0 && score.earned === 0
      ? [row.pull_request_id]
      : [];
  });
}

async function runReviewBatch(options: {
  job: SkillTrainingJob;
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestIds: number[];
  iteration: number;
}) {
  const db = getDb();
  let task = db
    .prepare(`
      SELECT id, repository_id, kind, pr_ids_json, payload_json, status
      FROM workflow_tasks
      WHERE training_job_id = ? AND training_iteration = ?
    `)
    .get(options.job.id, options.iteration) as
    | (WorkflowTask & { status: string })
    | undefined;
  if (!task) {
    const payload = {
      concurrency: options.repository.baseline_concurrency,
      skillIds: [options.skill.id],
      model: options.repository.model,
      modelSecondary: options.repository.model_secondary,
      contextTier: options.repository.context_tier,
      localRepoPath: options.repository.local_repo_path,
      localRepoBranch: options.repository.local_repo_branch,
    };
    const insert = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO workflow_tasks (
            repository_id, kind, pr_ids_json, payload_json, total_items,
            status, status_message, training_job_id, training_iteration
          ) VALUES (?, 'skill_eval', ?, ?, ?, 'running', ?, ?, ?)
        `)
        .run(
          options.repository.id,
          JSON.stringify(options.pullRequestIds),
          JSON.stringify(payload),
          options.pullRequestIds.length,
          options.iteration === 0
            ? "Training: initial personal skill review"
            : `Training iteration ${options.iteration}: retrying zero-credit PRs`,
          options.job.id,
          options.iteration,
        );
      queuePersonalSkillResults(db, {
        skillIds: [options.skill.id],
        pullRequestIds: options.pullRequestIds,
        model: options.repository.model,
        modelSecondary: options.repository.model_secondary,
        contextTier: options.repository.context_tier,
      });
      return Number(result.lastInsertRowid);
    })();
    task = {
      id: insert,
      repository_id: options.repository.id,
      kind: "skill_eval",
      pr_ids_json: JSON.stringify(options.pullRequestIds),
      payload_json: JSON.stringify(payload),
      status: "running",
    };
  }
  if (task.status === "completed") return task.id;
  if (task.status === "failed" || task.status === "cancelled") {
    throw new Error(`Training review task ${task.id} ${task.status}`);
  }
  db.prepare(`
    UPDATE workflow_tasks
    SET status = 'running', error = NULL
    WHERE id = ?
  `).run(task.id);
  try {
    await executeWorkflowTask(task);
  } catch (error) {
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'failed', status_message = 'Training review failed',
        error = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')
    `).run(
      error instanceof Error ? error.message : String(error),
      new Date().toISOString(),
      task.id,
    );
    throw error;
  }
  return task.id;
}

async function runAnalysisBatch(options: {
  job: SkillTrainingJob;
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestIds: number[];
  iteration: number;
}) {
  const db = getDb();
  const configuration = resultConfiguration(options.repository, options.skill);
  let analysisJob = db
    .prepare(`
      SELECT id, repository_id, skill_id, mode, model, model_secondary,
        context_tier, pr_ids_json, status, error
      FROM skill_analysis_jobs
      WHERE training_job_id = ? AND training_iteration = ?
    `)
    .get(options.job.id, options.iteration) as
    | (SkillAnalysisJob & { status: string; error: string | null })
    | undefined;
  if (!analysisJob) {
    const create = db.transaction(() => {
      const inserted = db
        .prepare(`
          INSERT INTO skill_analysis_jobs (
            repository_id, skill_id, mode, model, model_secondary,
            context_tier, pr_ids_json, total_items, status, status_message,
            training_job_id, training_iteration
          ) VALUES (?, ?, 'analyze_apply', ?, ?, ?, ?, ?, 'running', ?, ?, ?)
        `)
        .run(
          options.repository.id,
          options.skill.id,
          configuration.model,
          configuration.modelSecondary,
          configuration.contextTier,
          JSON.stringify(options.pullRequestIds),
          options.pullRequestIds.length,
          `Training iteration ${options.iteration}: analyzing and applying gaps`,
          options.job.id,
          options.iteration,
        );
      const upsert = db.prepare(`
        INSERT INTO skill_analysis_results (
          skill_id, pull_request_id, model, model_secondary, context_tier,
          status
        ) VALUES (?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(
          skill_id, pull_request_id, model, model_secondary, context_tier
        ) DO UPDATE SET
          status = 'pending', duration_ms = NULL, analysis_json = NULL,
          proposal_json = NULL, usage_json = NULL, raw_output = NULL,
          error = NULL, applied_at = NULL, application_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const pullRequestId of options.pullRequestIds) {
        upsert.run(
          options.skill.id,
          pullRequestId,
          configuration.model,
          configuration.modelSecondary,
          configuration.contextTier,
        );
      }
      return Number(inserted.lastInsertRowid);
    })();
    analysisJob = {
      id: create,
      repository_id: options.repository.id,
      skill_id: options.skill.id,
      mode: "analyze_apply",
      model: configuration.model,
      model_secondary: configuration.modelSecondary,
      context_tier: configuration.contextTier,
      pr_ids_json: JSON.stringify(options.pullRequestIds),
      status: "running",
      error: null,
    };
  }
  if (analysisJob.status === "completed") {
    if (analysisJob.error) throw new Error(analysisJob.error);
    return analysisJob.id;
  }
  if (analysisJob.status === "failed") {
    throw new Error(analysisJob.error ?? "Training analysis failed");
  }
  db.prepare(`
    UPDATE skill_analysis_jobs
    SET status = 'running', error = NULL
    WHERE id = ?
  `).run(analysisJob.id);
  try {
    await executeSkillAnalysisJob(analysisJob);
  } catch (error) {
    db.prepare(`
      UPDATE skill_analysis_jobs
      SET status = 'failed', status_message = 'Training analysis failed',
        error = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')
    `).run(
      error instanceof Error ? error.message : String(error),
      new Date().toISOString(),
      analysisJob.id,
    );
    throw error;
  }
  const completed = db
    .prepare("SELECT error FROM skill_analysis_jobs WHERE id = ?")
    .get(analysisJob.id) as { error: string | null } | undefined;
  if (completed?.error) throw new Error(completed.error);
  return analysisJob.id;
}

function trainingCancellationRequested(jobId: number) {
  const row = getDb()
    .prepare("SELECT status FROM skill_training_jobs WHERE id = ?")
    .get(jobId) as { status: string } | undefined;
  return row?.status === "cancelling" || row?.status === "cancelled";
}

function markTrainingCancelled(jobId: number) {
  const db = getDb();
  const completedAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE skill_training_jobs
      SET status = 'cancelled', status_message = 'Training cancelled',
        error = NULL, completed_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(completedAt, jobId);
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'cancelled', status_message = 'Cancelled',
        error = NULL, completed_at = ?
      WHERE training_job_id = ?
        AND status IN ('queued', 'running', 'cancelling')
    `).run(completedAt, jobId);
    db.prepare(`
      UPDATE skill_analysis_jobs
      SET status = 'cancelled', status_message = 'Cancelled',
        error = NULL, completed_at = ?
      WHERE training_job_id = ?
        AND status IN ('queued', 'running', 'cancelling')
    `).run(completedAt, jobId);
    db.prepare(`
      UPDATE skill_analysis_results
      SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND EXISTS (
          SELECT 1
          FROM skill_analysis_jobs analysis, json_each(analysis.pr_ids_json) pr
          WHERE analysis.training_job_id = ?
            AND analysis.skill_id = skill_analysis_results.skill_id
            AND analysis.model = skill_analysis_results.model
            AND analysis.model_secondary = skill_analysis_results.model_secondary
            AND analysis.context_tier = skill_analysis_results.context_tier
            AND CAST(pr.value AS INTEGER) =
              skill_analysis_results.pull_request_id
        )
    `).run(jobId);
  })();
}

async function runSkillTrainingJob(job: SkillTrainingJob) {
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(job.repository_id) as RepositoryRecord | undefined;
  const skill = db
    .prepare(`
      SELECT * FROM personal_review_skills
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .get(job.skill_id, job.repository_id) as
    | PersonalReviewSkillRecord
    | undefined;
  if (!repository || !skill) {
    throw new Error("Training repository or personal skill was not found");
  }
  if (!repository.local_repo_path || !repository.local_repo_branch) {
    throw new Error(
      "Training requires a verified Local repository path and branch",
    );
  }
  const selectedIds = parseIds(job.pr_ids_json);
  db.prepare(`
    UPDATE skill_training_jobs
    SET status = 'running', started_at = COALESCE(started_at, ?),
      error = NULL, total_items = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(new Date().toISOString(), selectedIds.length, job.id);

  let reviewTaskId = await runReviewBatch({
    job,
    repository,
    skill,
    pullRequestIds: selectedIds,
    iteration: 0,
  });
  throwIfWorkflowCancelled();
  let zeroCreditIds = zeroCreditPullRequests({
    repository,
    skill,
    pullRequestIds: selectedIds,
  });
  updateTrainingHistory(job.id, {
    iteration: 0,
    reviewed: selectedIds.length,
    zeroCredit: zeroCreditIds.length,
    reviewTaskId,
  });
  if (zeroCreditIds.length === 0) {
    db.prepare(`
      UPDATE skill_training_jobs
      SET status = 'completed', current_pr_ids_json = '[]',
        current_item = total_items, status_message = 'Training complete: every selected PR earned credit',
        completed_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), job.id);
    return;
  }

  for (let iteration = 1; iteration <= job.max_iterations; iteration += 1) {
    db.prepare(`
      UPDATE skill_training_jobs
      SET current_iteration = ?, current_pr_ids_json = ?,
        current_item = ?, status_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      iteration,
      JSON.stringify(zeroCreditIds),
      selectedIds.length - zeroCreditIds.length,
      `Training iteration ${iteration}/${job.max_iterations}: analyzing ${zeroCreditIds.length} zero-credit PRs`,
      job.id,
    );
    const analysisJobId = await runAnalysisBatch({
      job,
      repository,
      skill,
      pullRequestIds: zeroCreditIds,
      iteration,
    });
    throwIfWorkflowCancelled();
    db.prepare(`
      UPDATE skill_training_jobs
      SET status_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      `Training iteration ${iteration}/${job.max_iterations}: retrying ${zeroCreditIds.length} PRs`,
      job.id,
    );
    const reviewedIds = zeroCreditIds;
    reviewTaskId = await runReviewBatch({
      job,
      repository,
      skill,
      pullRequestIds: reviewedIds,
      iteration,
    });
    throwIfWorkflowCancelled();
    zeroCreditIds = zeroCreditPullRequests({
      repository,
      skill,
      pullRequestIds: reviewedIds,
    });
    updateTrainingHistory(job.id, {
      iteration,
      reviewed: reviewedIds.length,
      zeroCredit: zeroCreditIds.length,
      reviewTaskId,
      analysisJobId,
    });
    if (zeroCreditIds.length === 0) {
      db.prepare(`
        UPDATE skill_training_jobs
        SET status = 'completed', current_pr_ids_json = '[]',
          current_item = total_items,
          status_message = ?,
          completed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
      `).run(
        `Training complete after ${iteration} iteration${iteration === 1 ? "" : "s"}: every retried PR earned credit`,
        new Date().toISOString(),
        job.id,
      );
      return;
    }
  }

  db.prepare(`
    UPDATE skill_training_jobs
    SET status = 'completed', current_pr_ids_json = ?,
      current_item = total_items - ?,
      status_message = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(
    JSON.stringify(zeroCreditIds),
    zeroCreditIds.length,
    `Training stopped after ${job.max_iterations} iterations with ${zeroCreditIds.length} zero-credit PR${zeroCreditIds.length === 1 ? "" : "s"} remaining`,
    new Date().toISOString(),
    job.id,
  );
}

export async function executeSkillTrainingJob(job: SkillTrainingJob) {
  const controller = new AbortController();
  const cancellationTimer = setInterval(() => {
    if (trainingCancellationRequested(job.id)) controller.abort();
  }, 500);
  try {
    if (trainingCancellationRequested(job.id)) {
      throw new WorkflowCancellationError();
    }
    await runWithWorkflowCancellation(controller.signal, () =>
      runSkillTrainingJob(job),
    );
    if (trainingCancellationRequested(job.id)) {
      throw new WorkflowCancellationError();
    }
  } catch (error) {
    if (
      error instanceof WorkflowCancellationError ||
      trainingCancellationRequested(job.id) ||
      controller.signal.aborted
    ) {
      markTrainingCancelled(job.id);
      return;
    }
    throw error;
  } finally {
    clearInterval(cancellationTimer);
  }
}
