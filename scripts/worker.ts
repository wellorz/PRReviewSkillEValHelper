import { getDb } from "../src/lib/db";
import { syncRepositoryDataset } from "../src/lib/github";
import { executeEvaluationRun } from "../src/lib/pipeline";
import { executeQuickReview } from "../src/lib/quick-review";
import { executeSkillAnalysisJob } from "../src/lib/skill-analysis";
import {
  executeSkillTrainingJob,
  type SkillTrainingJob,
} from "../src/lib/skill-training";
import { executeWorkflowTask } from "../src/lib/workflow";
import {
  hasCurrentWorkflowWorkerVersion,
  markWorkflowWorkerVersion,
} from "../src/lib/workflow-version";
import {
  cancelActiveDatasetScans,
  failActiveDatasetScans,
  interruptActiveDatasetScans,
} from "../src/lib/scan-ledger";
import {
  runWithWorkflowCancellation,
  WorkflowCancellationError,
} from "../src/lib/workflow-cancellation";
import {
  canStartWorkflowTask,
  workflowTaskSlots,
} from "../src/lib/workflow-task-concurrency";
import type { RepositoryRecord, RunRecord } from "../src/lib/types";

const db = getDb();
const MAX_CONCURRENT_ANALYSIS_JOBS = 5;
let stopping = false;
type WorkflowTask = {
  id: number;
  repository_id: number;
  kind: "manual_pr" | "baseline" | "skill_eval";
  pr_ids_json: string;
  payload_json: string | null;
  total_items: number;
  baseline_concurrency: number;
};
type AnalysisJob = {
  id: number;
  repository_id: number;
  skill_id: number;
  mode: "analyze" | "analyze_apply";
  model: string;
  model_secondary: string;
  context_tier: string;
  pr_ids_json: string;
};
const runningWorkflowTasks = new Map<
  number,
  {
    kind: WorkflowTask["kind"];
    repositoryId: number;
    slots: number;
    promise: Promise<void>;
  }
>();
const runningAnalysisJobs = new Map<
  number,
  { mode: AnalysisJob["mode"]; promise: Promise<void> }
>();
const runningRepositorySyncs = new Map<number, Promise<void>>();
const runningTrainingJobs = new Map<number, Promise<void>>();

markWorkflowWorkerVersion();
interruptActiveDatasetScans();

db.prepare(
  "UPDATE repositories SET status = 'queued', status_message = 'Recovered interrupted dataset sync' WHERE status = 'syncing'",
).run();
db.prepare(
  "UPDATE repositories SET status = 'cancelled', status_message = 'Collection cancelled' WHERE status = 'cancelling'",
).run();
db.prepare(
  "UPDATE runs SET status = 'queued', error = NULL WHERE status = 'running'",
).run();
db.prepare(
  "UPDATE quick_reviews SET status = 'queued', stage = 'Recovered interrupted review', error = NULL WHERE status = 'running'",
).run();
db.prepare(
  "UPDATE workflow_tasks SET status = 'queued', status_message = 'Recovered interrupted task', error = NULL WHERE status = 'running'",
).run();
db.prepare(
  "UPDATE skill_analysis_jobs SET status = 'queued', status_message = 'Recovered interrupted analysis', error = NULL WHERE status = 'running'",
).run();
db.prepare(
  "UPDATE skill_analysis_results SET status = 'pending', error = NULL WHERE status = 'running'",
).run();
db.prepare(
  "UPDATE skill_training_jobs SET status = 'queued', status_message = 'Recovered interrupted training', error = NULL WHERE status = 'running'",
).run();
db.prepare(`
  UPDATE skill_training_jobs
  SET status = 'queued',
    status_message = 'Retrying after configured model became unavailable',
    error = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE status = 'failed'
    AND error LIKE '%from --model flag is not available%'
`).run();

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.stack && !error.stack.startsWith(error.message)
    ? `${error.message}\n${error.stack}`
    : error.stack ?? error.message;
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

function failRepository(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Repository sync ${id} failed:\n${message}`);
  failActiveDatasetScans(id, message);
  db.prepare(
    "UPDATE repositories SET status = 'failed', status_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(message, id);
}

async function executeRepositorySync(repository: RepositoryRecord) {
  const controller = new AbortController();
  const cancellationTimer = setInterval(() => {
    const current = db
      .prepare("SELECT status FROM repositories WHERE id = ?")
      .get(repository.id) as { status: string } | undefined;
    if (
      current?.status === "cancelling" ||
      current?.status === "cancelled"
    ) {
      controller.abort();
    }
  }, 500);
  try {
    await runWithWorkflowCancellation(controller.signal, () =>
      syncRepositoryDataset(repository),
    );
    const current = db
      .prepare("SELECT status FROM repositories WHERE id = ?")
      .get(repository.id) as { status: string } | undefined;
    if (
      controller.signal.aborted ||
      current?.status === "cancelling" ||
      current?.status === "cancelled"
    ) {
      throw new WorkflowCancellationError();
    }
  } catch (error) {
    if (
      error instanceof WorkflowCancellationError ||
      controller.signal.aborted
    ) {
      cancelActiveDatasetScans(repository.id);
      db.prepare(`
        UPDATE repositories
        SET status = 'cancelled', status_message = 'Collection cancelled',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(repository.id);
      return;
    }
    throw error;
  } finally {
    clearInterval(cancellationTimer);
  }
}

function failRun(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Evaluation run ${id} failed:\n${message}`);
  db.prepare(
    "UPDATE runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
  ).run(message, new Date().toISOString(), id);
}

function failQuickReview(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Quick review ${id} failed:\n${message}`);
  db.prepare(
    "UPDATE quick_reviews SET status = 'failed', stage = 'failed', error = ?, completed_at = ? WHERE id = ?",
  ).run(message, new Date().toISOString(), id);
}

function failWorkflowTask(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Workflow task ${id} failed:\n${message}`);
  db.prepare(
    "UPDATE workflow_tasks SET status = 'failed', status_message = 'Failed', error = ?, completed_at = ? WHERE id = ? AND status NOT IN ('cancelling', 'cancelled')",
  ).run(message, new Date().toISOString(), id);
}

function failSkillAnalysisJob(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Skill analysis job ${id} failed:\n${message}`);
  db.prepare(`
    UPDATE skill_analysis_jobs SET
      status = 'failed', status_message = 'Failed', error = ?, completed_at = ?
    WHERE id = ?
  `).run(message, new Date().toISOString(), id);
}

function failSkillTrainingJob(id: number, error: unknown) {
  const message = errorDetails(error);
  console.error(`Skill training job ${id} failed:\n${message}`);
  const completedAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE skill_training_jobs SET
        status = 'failed', status_message = 'Training failed', error = ?,
        completed_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(message, completedAt, id);
    db.prepare(`
      UPDATE workflow_tasks SET
        status = 'failed', status_message = 'Training failed', error = ?,
        completed_at = ?
      WHERE training_job_id = ? AND status IN ('queued', 'running')
    `).run(message, completedAt, id);
    db.prepare(`
      UPDATE skill_analysis_jobs SET
        status = 'failed', status_message = 'Training failed', error = ?,
        completed_at = ?
      WHERE training_job_id = ? AND status IN ('queued', 'running')
    `).run(message, completedAt, id);
  })();
}

function enqueueDueSchedules() {
  const now = new Date().toISOString();
  const schedules = db
    .prepare(`
      SELECT s.id, s.repository_id, s.interval_minutes, r.model, r.model_secondary, r.skill_path
      FROM schedules s
      JOIN repositories r ON r.id = s.repository_id
      WHERE s.enabled = 1 AND s.next_run_at <= ? AND r.status = 'ready'
    `)
    .all(now) as Array<{
    id: number;
    repository_id: number;
    interval_minutes: number;
    model: string;
    model_secondary: string;
    skill_path: string;
  }>;
  const insertRun = db.prepare(
    "INSERT INTO runs (repository_id, trigger, model, model_secondary, skill_path) VALUES (?, 'schedule', ?, ?, ?)",
  );
  const updateSchedule = db.prepare(
    "UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?",
  );
  const transaction = db.transaction(() => {
    for (const schedule of schedules) {
      const active = db
        .prepare(
          "SELECT 1 FROM runs WHERE repository_id = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .get(schedule.repository_id);
      const nextRun = new Date(
        Date.now() + schedule.interval_minutes * 60_000,
      ).toISOString();
      if (!active) {
        insertRun.run(
          schedule.repository_id,
          schedule.model,
          schedule.model_secondary,
          schedule.skill_path,
        );
      }
      updateSchedule.run(now, nextRun, schedule.id);
    }
  });
  transaction();
}

async function tick() {
  markWorkflowWorkerVersion();
  if (!hasCurrentWorkflowWorkerVersion()) return;

  enqueueDueSchedules();

  if (
    runningTrainingJobs.size === 0 &&
    runningAnalysisJobs.size === 0
  ) {
    const trainingJob = db
      .prepare(`
        SELECT id, repository_id, skill_id, status, pr_ids_json,
          current_pr_ids_json, current_iteration, max_iterations,
          current_item, total_items, status_message, history_json
        FROM skill_training_jobs training
        WHERE training.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_tasks task
            WHERE task.repository_id = training.repository_id
              AND task.training_job_id IS NULL
              AND task.status IN ('queued', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM skill_analysis_jobs analysis
            WHERE analysis.repository_id = training.repository_id
              AND analysis.training_job_id IS NULL
              AND analysis.status IN ('queued', 'running')
          )
        ORDER BY training.id ASC
        LIMIT 1
      `)
      .get() as SkillTrainingJob | undefined;
    if (
      trainingJob &&
      db
        .prepare(
          "UPDATE skill_training_jobs SET status = 'running' WHERE id = ? AND status = 'queued'",
        )
        .run(trainingJob.id).changes === 1
    ) {
      const promise = executeSkillTrainingJob(trainingJob)
        .catch((error) => failSkillTrainingJob(trainingJob.id, error))
        .finally(() => {
          runningTrainingJobs.delete(trainingJob.id);
        });
      runningTrainingJobs.set(trainingJob.id, promise);
    }
  }

  if (
    runningTrainingJobs.size === 0 &&
    runningAnalysisJobs.size < MAX_CONCURRENT_ANALYSIS_JOBS
  ) {
    const analysisJobs = db
      .prepare(`
        SELECT id, repository_id, skill_id, mode, model, model_secondary,
          context_tier, pr_ids_json
        FROM skill_analysis_jobs job
        WHERE status = 'queued'
          AND training_job_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM skill_training_jobs training
            WHERE training.repository_id = job.repository_id
              AND training.status IN ('queued', 'running')
          )
          AND (
            mode = 'analyze'
            OR NOT EXISTS (
              SELECT 1 FROM workflow_tasks task
              WHERE task.repository_id = job.repository_id
                AND task.kind = 'skill_eval'
                AND task.status IN ('queued', 'running')
            )
          )
        ORDER BY id ASC
        LIMIT 20
      `)
      .all() as AnalysisJob[];
    for (const analysisJob of analysisJobs) {
      if (runningAnalysisJobs.size >= MAX_CONCURRENT_ANALYSIS_JOBS) break;
      const applyJobRunning = [...runningAnalysisJobs.values()].some(
        (job) => job.mode === "analyze_apply",
      );
      if (
        applyJobRunning ||
        (analysisJob.mode === "analyze_apply" &&
          runningAnalysisJobs.size > 0)
      ) {
        continue;
      }
      if (
        db
        .prepare(
          "UPDATE skill_analysis_jobs SET status = 'running' WHERE id = ? AND status = 'queued'",
        )
          .run(analysisJob.id).changes !== 1
      ) {
        continue;
      }
      const promise = executeSkillAnalysisJob(analysisJob)
        .catch((error) => failSkillAnalysisJob(analysisJob.id, error))
        .finally(() => {
          runningAnalysisJobs.delete(analysisJob.id);
        });
      runningAnalysisJobs.set(analysisJob.id, {
        mode: analysisJob.mode,
        promise,
      });
      if (analysisJob.mode === "analyze_apply") break;
    }
  }

  const manualTaskActive = [...runningWorkflowTasks.values()].some(
    (task) => task.kind === "manual_pr",
  );
  if (!manualTaskActive) {
    const queuedTasks = db
      .prepare(`
        SELECT task.id, task.repository_id, task.kind, task.pr_ids_json,
          task.payload_json, task.total_items, repository.baseline_concurrency
        FROM workflow_tasks task
        JOIN repositories repository ON repository.id = task.repository_id
        WHERE task.status = 'queued'
          AND task.training_job_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM skill_training_jobs training
            WHERE training.repository_id = task.repository_id
              AND training.status IN ('queued', 'running')
          )
        ORDER BY
          CASE task.kind
            WHEN 'manual_pr' THEN 0
            WHEN 'skill_eval' THEN 1
            ELSE 2
          END,
          task.id ASC
        LIMIT 20
      `)
      .all() as WorkflowTask[];
    for (const workflowTask of queuedTasks) {
      if (
        workflowTask.kind === "skill_eval" &&
        runningTrainingJobs.size > 0
      ) {
        continue;
      }
      if (
        workflowTask.kind === "skill_eval" &&
        [...runningAnalysisJobs.values()].some(
          (job) => job.mode === "analyze_apply",
        )
      ) {
        continue;
      }
      if (
        !canStartWorkflowTask(
          {
            kind: workflowTask.kind,
            repositoryId: workflowTask.repository_id,
            totalItems: workflowTask.total_items,
            payloadJson: workflowTask.payload_json,
          },
          [...runningWorkflowTasks.values()].map((task) => ({
            kind: task.kind,
            repositoryId: task.repositoryId,
            slots: task.slots,
          })),
          workflowTask.baseline_concurrency,
        )
      ) {
        continue;
      }
      const claimed = db
        .prepare(
          "UPDATE workflow_tasks SET status = 'running' WHERE id = ? AND status = 'queued'",
        )
        .run(workflowTask.id);
      if (claimed.changes !== 1) continue;
      const promise = executeWorkflowTask(workflowTask)
        .catch((error) => failWorkflowTask(workflowTask.id, error))
        .finally(() => {
          runningWorkflowTasks.delete(workflowTask.id);
        });
      runningWorkflowTasks.set(workflowTask.id, {
        kind: workflowTask.kind,
        repositoryId: workflowTask.repository_id,
        slots: workflowTaskSlots({
          kind: workflowTask.kind,
          repositoryId: workflowTask.repository_id,
          totalItems: workflowTask.total_items,
          payloadJson: workflowTask.payload_json,
        }),
        promise,
      });
      if (workflowTask.kind === "manual_pr") break;
    }
  }

  const repository =
    runningRepositorySyncs.size === 0
      ? (db
          .prepare(
            "SELECT * FROM repositories WHERE status = 'queued' ORDER BY updated_at DESC, id DESC LIMIT 1",
          )
          .get() as RepositoryRecord | undefined)
      : undefined;
  if (repository) {
    const promise = executeRepositorySync(repository)
      .catch((error) => failRepository(repository.id, error))
      .finally(() => {
        runningRepositorySyncs.delete(repository.id);
      });
    runningRepositorySyncs.set(repository.id, promise);
    return;
  }

  const quickReview = db
    .prepare(
      "SELECT id, repository_id, pr_number FROM quick_reviews WHERE status = 'queued' ORDER BY id DESC LIMIT 1",
    )
    .get() as
    | { id: number; repository_id: number; pr_number: number }
    | undefined;
  if (quickReview) {
    try {
      await executeQuickReview(quickReview);
    } catch (error) {
      failQuickReview(quickReview.id, error);
    }
    return;
  }

  const run = db
    .prepare(
      "SELECT * FROM runs WHERE status = 'queued' ORDER BY CASE WHEN trigger = 'manual' THEN 0 ELSE 1 END, id DESC LIMIT 1",
    )
    .get() as RunRecord | undefined;
  if (run) {
    try {
      await executeEvaluationRun(run);
    } catch (error) {
      failRun(run.id, error);
    }
  }
}

async function main() {
  console.log("PR review benchmark worker started.");
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  await Promise.all([
    ...[...runningWorkflowTasks.values()].map((task) => task.promise),
    ...[...runningAnalysisJobs.values()].map((job) => job.promise),
    ...runningTrainingJobs.values(),
    ...runningRepositorySyncs.values(),
  ]);
  console.log("PR review benchmark worker stopped.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
