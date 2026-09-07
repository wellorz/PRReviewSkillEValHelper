import { getDb } from "../src/lib/db";
import { syncRepositoryDataset } from "../src/lib/github";
import { executeEvaluationRun } from "../src/lib/pipeline";
import { executeQuickReview } from "../src/lib/quick-review";
import { executeSkillAnalysisJob } from "../src/lib/skill-analysis";
import { executeWorkflowTask } from "../src/lib/workflow";
import {
  hasCurrentWorkflowWorkerVersion,
  markWorkflowWorkerVersion,
} from "../src/lib/workflow-version";
import { repositorySyncQueueMessage } from "../src/lib/repository-queue";
import {
  failActiveDatasetScans,
  interruptActiveDatasetScans,
} from "../src/lib/scan-ledger";
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
  { kind: WorkflowTask["kind"]; promise: Promise<void> }
>();
const runningAnalysisJobs = new Map<
  number,
  { mode: AnalysisJob["mode"]; promise: Promise<void> }
>();

markWorkflowWorkerVersion();
interruptActiveDatasetScans();

db.prepare(
  "UPDATE repositories SET status = 'queued', status_message = 'Recovered interrupted dataset sync' WHERE status = 'syncing'",
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

  if (runningAnalysisJobs.size < MAX_CONCURRENT_ANALYSIS_JOBS) {
    const analysisJobs = db
      .prepare(`
        SELECT id, repository_id, skill_id, mode, model, model_secondary,
          context_tier, pr_ids_json
        FROM skill_analysis_jobs job
        WHERE status = 'queued'
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

  const activeKinds = new Set(
    [...runningWorkflowTasks.values()].map((task) => task.kind),
  );
  const manualTaskActive = activeKinds.has("manual_pr");
  if (!manualTaskActive) {
    const queuedTasks = db
      .prepare(`
        SELECT id, repository_id, kind, pr_ids_json, payload_json
        FROM workflow_tasks
        WHERE status = 'queued'
        ORDER BY
          CASE kind
            WHEN 'manual_pr' THEN 0
            WHEN 'skill_eval' THEN 1
            ELSE 2
          END,
          id ASC
        LIMIT 20
      `)
      .all() as WorkflowTask[];
    for (const workflowTask of queuedTasks) {
      if (workflowTask.kind === "manual_pr") {
        if (runningWorkflowTasks.size > 0) continue;
      } else {
        if (activeKinds.has(workflowTask.kind)) continue;
        if (
          workflowTask.kind === "skill_eval" &&
          [...runningAnalysisJobs.values()].some(
            (job) => job.mode === "analyze_apply",
          )
        ) {
          continue;
        }
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
        promise,
      });
      activeKinds.add(workflowTask.kind);
      if (workflowTask.kind === "manual_pr") break;
    }
  }

  if (runningWorkflowTasks.size > 0 || runningAnalysisJobs.size > 0) {
    const queuedRepositories = db
      .prepare("SELECT id FROM repositories WHERE status = 'queued'")
      .all() as Array<{ id: number }>;
    const updateMessage = db.prepare(
      "UPDATE repositories SET status_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    for (const queuedRepository of queuedRepositories) {
      updateMessage.run(
        repositorySyncQueueMessage(queuedRepository.id),
        queuedRepository.id,
      );
    }
    return;
  }

  const repository = db
    .prepare(
      "SELECT * FROM repositories WHERE status = 'queued' ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .get() as RepositoryRecord | undefined;
  if (repository) {
    try {
      await syncRepositoryDataset(repository);
    } catch (error) {
      failRepository(repository.id, error);
    }
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
  ]);
  console.log("PR review benchmark worker stopped.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
