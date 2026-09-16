import path from "node:path";
import { createAsyncGate, type AsyncGate } from "@/lib/async-gate";
import {
  isUnavailableModelError,
  prepareSkillRoot,
} from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { DATA_DIR } from "@/lib/paths";
import {
  executeSkillAnalysisJob,
  type SkillAnalysisJob,
} from "@/lib/skill-analysis";
import { personalSkillResultConfiguration } from "@/lib/personal-skill-execution";
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
  pullRequestId: number;
  iteration: number;
  reviewTaskId: number;
  analysisJobId?: number;
  earned: number;
  available: number;
};

type TrainingResult = {
  status: string;
  metrics_json: string | null;
  error: string | null;
};

const TRANSIENT_TRAINING_RETRY_DELAYS_MS = [15_000, 60_000] as const;
const TIMEOUT_TRAINING_RETRY_DELAYS_MS = [30_000] as const;

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

export function trainingFailureRecovery(
  value: unknown,
  phase: "review" | "analysis" = "review",
) {
  const message = value instanceof Error ? value.message : String(value);
  if (isUnavailableModelError(message)) {
    return {
      retryDelaysMs: [] as readonly number[],
      reason: "configured-model retries were already exhausted",
    };
  }
  if (
    /PR head commit .* (?:is unavailable|is not available)|no local ref contains a verified/i.test(
      message,
    )
  ) {
    return {
      retryDelaysMs: [] as readonly number[],
      reason: "the immutable repository commit is unavailable",
    };
  }
  if (/Apply stopped:|append-only mitigations/i.test(message)) {
    return {
      retryDelaysMs:
        phase === "analysis"
          ? TRANSIENT_TRAINING_RETRY_DELAYS_MS
          : ([] as readonly number[]),
      reason:
        phase === "analysis"
          ? "the unsafe edit was rejected and the analysis must regenerate an append-only proposal"
          : "the append-only mitigation safety gate rejected the edit",
    };
  }
  if (/artifacts do not match the requested source and target commits/i.test(message)) {
    return {
      retryDelaysMs: [] as readonly number[],
      reason: "the generated artifacts do not match the immutable review input",
    };
  }
  if (
    /sandbox(?:ing)?.*(?:unsupported|not supported)|requires BaseContainer/i.test(
      message,
    )
  ) {
    return {
      retryDelaysMs: [] as readonly number[],
      reason: "the required review sandbox is unavailable",
    };
  }
  if (/timed out after \d+ms|timeout/i.test(message)) {
    return {
      retryDelaysMs: TIMEOUT_TRAINING_RETRY_DELAYS_MS,
      reason: "the review or analysis timed out",
    };
  }
  if (
    /\b400 Bad Request\b|\b408 Request Timeout\b|\b409 Conflict\b|\b425 Too Early\b|\b429 Too Many Requests\b|\b5\d\d\b|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network error|temporarily unavailable|failed to delete|Permission denied|\bEPERM\b|\bEBUSY\b|Bad control character in string literal in JSON|JSON at position|Unexpected token .*JSON/i.test(
      message,
    )
  ) {
    return {
      retryDelaysMs: TRANSIENT_TRAINING_RETRY_DELAYS_MS,
      reason: "a transient service, output, or filesystem failure occurred",
    };
  }
  return {
    retryDelaysMs: [] as readonly number[],
    reason: "the failure is not classified as safely retryable",
  };
}

async function waitForTrainingRetry(jobId: number, delayMs: number) {
  let remaining = delayMs;
  while (remaining > 0) {
    throwIfWorkflowCancelled();
    if (trainingCancellationRequested(jobId)) {
      throw new WorkflowCancellationError();
    }
    const waitMs = Math.min(remaining, 500);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    remaining -= waitMs;
  }
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

function updateTrainingHistory(jobId: number, entry: TrainingHistoryEntry) {
  const db = getDb();
  const row = db
    .prepare("SELECT history_json FROM skill_training_jobs WHERE id = ?")
    .get(jobId) as { history_json: string } | undefined;
  const history = row
    ? (JSON.parse(row.history_json || "[]") as TrainingHistoryEntry[])
    : [];
  const next = [
    ...history.filter(
      (item) =>
        item.pullRequestId !== entry.pullRequestId ||
        item.iteration !== entry.iteration,
    ),
    entry,
  ].sort(
    (left, right) =>
      left.pullRequestId - right.pullRequestId ||
      left.iteration - right.iteration,
  );
  db.prepare(`
    UPDATE skill_training_jobs
    SET history_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(JSON.stringify(next), jobId);
}

function readTrainingResult(options: {
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestId: number;
}) {
  const configuration = resultConfiguration(options.repository, options.skill);
  return getDb()
    .prepare(`
      SELECT status, metrics_json, error
      FROM personal_skill_results
      WHERE skill_id = ? AND pull_request_id = ?
        AND model = ? AND model_secondary = ? AND context_tier = ?
    `)
    .get(
      options.skill.id,
      options.pullRequestId,
      configuration.model,
      configuration.modelSecondary,
      configuration.contextTier,
    ) as TrainingResult | undefined;
}

async function prepareTrainingSkillSnapshot(options: {
  jobId: number;
  skill: PersonalReviewSkillRecord;
  pullRequestId: number;
  iteration: number;
  mutationGate: AsyncGate;
}) {
  return options.mutationGate.run(() =>
    prepareSkillRoot(
      options.skill.path,
      path.join(
        DATA_DIR,
        "skill-training",
        `job-${options.jobId}`,
        `pr-${options.pullRequestId}`,
        `attempt-${options.iteration}`,
      ),
    ),
  );
}

async function runReview(options: {
  job: SkillTrainingJob;
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestId: number;
  iteration: number;
  preparedSkillRoot: string;
}) {
  const db = getDb();
  let task = db
    .prepare(`
      SELECT id, repository_id, kind, pr_ids_json, payload_json, status,
        error, training_retry_count
      FROM workflow_tasks
      WHERE training_job_id = ? AND training_pull_request_id = ?
        AND training_iteration = ?
    `)
    .get(options.job.id, options.pullRequestId, options.iteration) as
    | (WorkflowTask & {
        status: string;
        error: string | null;
        training_retry_count: number;
      })
    | undefined;
  if (!task) {
    const payload = {
      concurrency: 1,
      skillIds: [options.skill.id],
      model: options.repository.model,
      modelSecondary: options.repository.model_secondary,
      contextTier: options.repository.context_tier,
      localRepoPath: options.repository.local_repo_path,
      localRepoBranch: options.repository.local_repo_branch,
      preparedSkillRoots: {
        [options.skill.id]: options.preparedSkillRoot,
      },
    };
    const taskId = db.transaction(() => {
      const inserted = db
        .prepare(`
          INSERT INTO workflow_tasks (
            repository_id, kind, pr_ids_json, payload_json, total_items,
            status, status_message, training_job_id,
            training_pull_request_id, training_iteration
          ) VALUES (?, 'skill_eval', ?, ?, 1, 'running', ?, ?, ?, ?)
        `)
        .run(
          options.repository.id,
          JSON.stringify([options.pullRequestId]),
          JSON.stringify(payload),
          options.iteration === 0
            ? "Training: initial personal skill review"
            : `Training retry ${options.iteration}/${options.job.max_iterations}`,
          options.job.id,
          options.pullRequestId,
          options.iteration,
        );
      queuePersonalSkillResults(db, {
        skillIds: [options.skill.id],
        pullRequestIds: [options.pullRequestId],
        model: options.repository.model,
        modelSecondary: options.repository.model_secondary,
        contextTier: options.repository.context_tier,
      });
      return Number(inserted.lastInsertRowid);
    })();
    task = {
      id: taskId,
      repository_id: options.repository.id,
      kind: "skill_eval",
      pr_ids_json: JSON.stringify([options.pullRequestId]),
      payload_json: JSON.stringify(payload),
      status: "running",
      error: null,
      training_retry_count: 0,
    };
  }
  if (task.status === "completed") return task.id;
  if (task.status === "failed" || task.status === "cancelled") {
    throw new Error(
      task.error ?? `Training review task ${task.id} ${task.status}`,
    );
  }
  let retryCount = task.training_retry_count;
  for (;;) {
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'running', error = NULL, completed_at = NULL
      WHERE id = ?
    `).run(task.id);
    try {
      await executeWorkflowTask(task);
      return task.id;
    } catch (error) {
      throwIfWorkflowCancelled(error);
      const message = error instanceof Error ? error.message : String(error);
      const recovery = trainingFailureRecovery(error, "review");
      const delayMs = recovery.retryDelaysMs[retryCount];
      if (delayMs !== undefined) {
        retryCount += 1;
        const retryMessage =
          `Automatic review retry ${retryCount}/${recovery.retryDelaysMs.length} ` +
          `for PR ${options.pullRequestId} in ${Math.ceil(delayMs / 1000)}s · ${recovery.reason}`;
        db.transaction(() => {
          queuePersonalSkillResults(db, {
            skillIds: [options.skill.id],
            pullRequestIds: [options.pullRequestId],
            model: options.repository.model,
            modelSecondary: options.repository.model_secondary,
            contextTier: options.repository.context_tier,
          });
          db.prepare(`
            UPDATE workflow_tasks
            SET status = 'running', current_item = 0, status_message = ?,
              error = NULL, completed_at = NULL, training_retry_count = ?
            WHERE id = ?
          `).run(retryMessage, retryCount, task.id);
          db.prepare(`
            UPDATE skill_training_jobs
            SET status_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
          `).run(retryMessage, options.job.id);
        })();
        await waitForTrainingRetry(options.job.id, delayMs);
        const runningMessage =
          `Automatic review retry ${retryCount}/${recovery.retryDelaysMs.length} ` +
          `for PR ${options.pullRequestId} · ${recovery.reason}`;
        db.prepare(`
          UPDATE workflow_tasks SET status_message = ? WHERE id = ?
        `).run(runningMessage, task.id);
        db.prepare(`
          UPDATE skill_training_jobs
          SET status_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
        `).run(runningMessage, options.job.id);
        continue;
      }
      const finalMessage =
        retryCount > 0
          ? `${message}\nAutomatic execution retries performed: ${retryCount}. Final classification: ${recovery.reason}.`
          : message;
      db.prepare(`
        UPDATE workflow_tasks
        SET status = 'failed', status_message = 'Training review failed',
          error = ?, completed_at = ?, training_retry_count = ?
        WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')
      `).run(
        finalMessage,
        new Date().toISOString(),
        retryCount,
        task.id,
      );
      throw new Error(finalMessage);
    }
  }
}

async function runAnalysis(options: {
  job: SkillTrainingJob;
  repository: RepositoryRecord;
  skill: PersonalReviewSkillRecord;
  pullRequestId: number;
  iteration: number;
}) {
  const db = getDb();
  const configuration = resultConfiguration(options.repository, options.skill);
  let analysisJob = db
    .prepare(`
      SELECT id, repository_id, skill_id, mode, model, model_secondary,
        context_tier, pr_ids_json, status, error, training_retry_count
      FROM skill_analysis_jobs
      WHERE training_job_id = ? AND training_pull_request_id = ?
        AND training_iteration = ?
    `)
    .get(options.job.id, options.pullRequestId, options.iteration) as
    | (SkillAnalysisJob & {
        status: string;
        error: string | null;
        training_retry_count: number;
      })
    | undefined;
  if (!analysisJob) {
    const analysisJobId = db.transaction(() => {
      const inserted = db
        .prepare(`
          INSERT INTO skill_analysis_jobs (
            repository_id, skill_id, mode, model, model_secondary,
            context_tier, pr_ids_json, total_items, status, status_message,
            training_job_id, training_pull_request_id, training_iteration
          ) VALUES (?, ?, 'analyze_apply', ?, ?, ?, ?, 1, 'running', ?, ?, ?, ?)
        `)
        .run(
          options.repository.id,
          options.skill.id,
          configuration.model,
          configuration.modelSecondary,
          configuration.contextTier,
          JSON.stringify([options.pullRequestId]),
          `Training retry ${options.iteration}: analyzing and applying gap`,
          options.job.id,
          options.pullRequestId,
          options.iteration,
        );
      db.prepare(`
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
      `).run(
        options.skill.id,
        options.pullRequestId,
        configuration.model,
        configuration.modelSecondary,
        configuration.contextTier,
      );
      return Number(inserted.lastInsertRowid);
    })();
    analysisJob = {
      id: analysisJobId,
      repository_id: options.repository.id,
      skill_id: options.skill.id,
      mode: "analyze_apply",
      model: configuration.model,
      model_secondary: configuration.modelSecondary,
      context_tier: configuration.contextTier,
      pr_ids_json: JSON.stringify([options.pullRequestId]),
      status: "running",
      error: null,
      training_retry_count: 0,
    };
  }
  if (analysisJob.status === "completed") {
    if (analysisJob.error) throw new Error(analysisJob.error);
    return analysisJob.id;
  }
  if (analysisJob.status === "failed" || analysisJob.status === "cancelled") {
    throw new Error(
      analysisJob.error ?? `Training analysis ${analysisJob.status}`,
    );
  }
  let retryCount = analysisJob.training_retry_count;
  for (;;) {
    db.prepare(`
      UPDATE skill_analysis_jobs
      SET status = 'running', error = NULL, completed_at = NULL
      WHERE id = ?
    `).run(analysisJob.id);
    try {
      await executeSkillAnalysisJob(analysisJob);
      const completed = db
        .prepare("SELECT error FROM skill_analysis_jobs WHERE id = ?")
        .get(analysisJob.id) as { error: string | null } | undefined;
      if (completed?.error) throw new Error(completed.error);
      return analysisJob.id;
    } catch (error) {
      throwIfWorkflowCancelled(error);
      const message = error instanceof Error ? error.message : String(error);
      const recovery = trainingFailureRecovery(error, "analysis");
      const delayMs = recovery.retryDelaysMs[retryCount];
      if (delayMs !== undefined) {
        retryCount += 1;
        const retryMessage =
          `Automatic analysis retry ${retryCount}/${recovery.retryDelaysMs.length} ` +
          `for PR ${options.pullRequestId} in ${Math.ceil(delayMs / 1000)}s · ${recovery.reason}`;
        db.transaction(() => {
          db.prepare(`
            UPDATE skill_analysis_results
            SET status = 'pending', duration_ms = NULL, analysis_json = NULL,
              proposal_json = NULL, usage_json = NULL, raw_output = NULL,
              error = NULL, applied_at = NULL, application_error = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE skill_id = ? AND pull_request_id = ?
              AND model = ? AND model_secondary = ? AND context_tier = ?
          `).run(
            options.skill.id,
            options.pullRequestId,
            configuration.model,
            configuration.modelSecondary,
            configuration.contextTier,
          );
          db.prepare(`
            UPDATE skill_analysis_jobs
            SET status = 'running', current_item = 0, status_message = ?,
              error = NULL, completed_at = NULL, training_retry_count = ?
            WHERE id = ?
          `).run(retryMessage, retryCount, analysisJob.id);
          db.prepare(`
            UPDATE skill_training_jobs
            SET status_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'
          `).run(retryMessage, options.job.id);
        })();
        await waitForTrainingRetry(options.job.id, delayMs);
        const runningMessage =
          `Automatic analysis retry ${retryCount}/${recovery.retryDelaysMs.length} ` +
          `for PR ${options.pullRequestId} · ${recovery.reason}`;
        db.prepare(`
          UPDATE skill_analysis_jobs SET status_message = ? WHERE id = ?
        `).run(runningMessage, analysisJob.id);
        db.prepare(`
          UPDATE skill_training_jobs
          SET status_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
        `).run(runningMessage, options.job.id);
        continue;
      }
      const finalMessage =
        retryCount > 0
          ? `${message}\nAutomatic execution retries performed: ${retryCount}. Final classification: ${recovery.reason}.`
          : message;
      db.prepare(`
        UPDATE skill_analysis_jobs
        SET status = 'failed', status_message = 'Training analysis failed',
          error = ?, completed_at = ?, training_retry_count = ?
        WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')
      `).run(
        finalMessage,
        new Date().toISOString(),
        retryCount,
        analysisJob.id,
      );
      throw new Error(finalMessage);
    }
  }
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
  const trainingRepository = repository;
  const trainingSkill = skill;
  const pullRequestIds = parseIds(job.pr_ids_json);
  const concurrency = Math.max(
    1,
    Math.min(
      repository.baseline_concurrency,
      Math.max(1, pullRequestIds.length),
    ),
  );
  db.prepare(`
    UPDATE skill_training_jobs
    SET status = 'running', started_at = COALESCE(started_at, ?),
      error = NULL, total_items = ?, status_message = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    pullRequestIds.length,
    `Training with ${concurrency} parallel PR pipelines`,
    job.id,
  );

  const mutationGate = createAsyncGate(1);
  const remainingZeroCredit = new Set<number>();
  const failures: string[] = [];
  let nextIndex = 0;
  let completed = 0;
  let active = 0;

  function updateProgress(message?: string) {
    db.prepare(`
      UPDATE skill_training_jobs
      SET current_item = ?, current_pr_ids_json = ?,
        status_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(
      completed,
      JSON.stringify([...remainingZeroCredit]),
      message ??
        `Training with ${concurrency} pipelines · ${completed}/${pullRequestIds.length} PRs complete · ${active} active`,
      job.id,
    );
  }

  async function trainPullRequest(pullRequestId: number) {
    for (
      let iteration = 0;
      iteration <= job.max_iterations;
      iteration += 1
    ) {
      throwIfWorkflowCancelled();
      db.prepare(`
        UPDATE skill_training_jobs
        SET current_iteration = MAX(current_iteration, ?),
          status_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running'
      `).run(
        iteration,
        iteration === 0
          ? `Reviewing PR ${pullRequestId}`
          : `Retrying PR ${pullRequestId} · ${iteration}/${job.max_iterations}`,
        job.id,
      );
      const preparedSkillRoot = await prepareTrainingSkillSnapshot({
        jobId: job.id,
        skill: trainingSkill,
        pullRequestId,
        iteration,
        mutationGate,
      });
      const reviewTaskId = await runReview({
        job,
        repository: trainingRepository,
        skill: trainingSkill,
        pullRequestId,
        iteration,
        preparedSkillRoot,
      });
      throwIfWorkflowCancelled();
      const result = readTrainingResult({
        repository: trainingRepository,
        skill: trainingSkill,
        pullRequestId,
      });
      if (!result || result.status !== "completed") {
        throw new Error(
          `Training review did not complete for PR ${pullRequestId}: ${result?.error ?? result?.status ?? "missing result"}`,
        );
      }
      const score = trainingMetricsScore(result.metrics_json);
      if (!score) {
        throw new Error(`Training review produced no score for PR ${pullRequestId}`);
      }
      remainingZeroCredit.delete(pullRequestId);
      updateTrainingHistory(job.id, {
        pullRequestId,
        iteration,
        reviewTaskId,
        earned: score.earned,
        available: score.available,
      });
      if (score.available === 0 || score.earned > 0) return;
      remainingZeroCredit.add(pullRequestId);
      updateProgress();
      if (iteration === job.max_iterations) return;
      const analysisJobId = await mutationGate.run(() =>
        runAnalysis({
          job,
          repository: trainingRepository,
          skill: trainingSkill,
          pullRequestId,
          iteration: iteration + 1,
        }),
      );
      throwIfWorkflowCancelled();
      updateTrainingHistory(job.id, {
        pullRequestId,
        iteration,
        reviewTaskId,
        analysisJobId,
        earned: score.earned,
        available: score.available,
      });
    }
  }

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pullRequestIds.length) return;
      const pullRequestId = pullRequestIds[index];
      active += 1;
      updateProgress();
      try {
        await trainPullRequest(pullRequestId);
      } catch (error) {
        throwIfWorkflowCancelled(error);
        remainingZeroCredit.delete(pullRequestId);
        if (isUnavailableModelError(error)) throw error;
        failures.push(
          `PR ${pullRequestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        active -= 1;
        completed += 1;
        updateProgress();
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );
  throwIfWorkflowCancelled();
  const statusMessage =
    failures.length > 0
      ? `Training complete with ${failures.length} failure${failures.length === 1 ? "" : "s"} and ${remainingZeroCredit.size} zero-credit PR${remainingZeroCredit.size === 1 ? "" : "s"}`
      : remainingZeroCredit.size > 0
        ? `Training stopped with ${remainingZeroCredit.size} zero-credit PR${remainingZeroCredit.size === 1 ? "" : "s"} after five retries`
        : "Training complete: every selected PR earned credit";
  db.prepare(`
    UPDATE skill_training_jobs
    SET status = 'completed', current_item = total_items,
      current_pr_ids_json = ?, status_message = ?, error = ?,
      completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(
    JSON.stringify([...remainingZeroCredit]),
    statusMessage,
    failures.length > 0 ? failures.join("\n") : null,
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
    controller.abort();
    throw error;
  } finally {
    clearInterval(cancellationTimer);
  }
}
