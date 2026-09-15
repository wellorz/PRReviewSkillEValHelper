import { spawn, type ChildProcess } from "node:child_process";
import {
  WORKFLOW_WORKER_VERSION,
  workflowRuntimeFingerprint,
} from "../src/lib/workflow-version";
import { getDb } from "../src/lib/db";

const POLL_INTERVAL_MS = 1_000;
let worker: ChildProcess | null = null;
let stopping = false;
let restartRequested = false;
let observedVersion = WORKFLOW_WORKER_VERSION;

function startWorker() {
  restartRequested = false;
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/worker.ts"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  worker.once("error", (error) => {
    console.error("Unable to start the workflow worker:", error);
    process.exitCode = 1;
  });
  worker.once("exit", (code, signal) => {
    worker = null;
    if (stopping) {
      process.exitCode = code ?? (signal ? 1 : 0);
      return;
    }
    if (restartRequested) {
      console.log("Workflow worker code updated; starting the new version.");
      startWorker();
      return;
    }
    console.error(
      `Workflow worker exited unexpectedly (${signal ?? `code ${code ?? 1}`}).`,
    );
    process.exitCode = code ?? 1;
  });
}

function requestRestart() {
  if (stopping || restartRequested) return;
  restartRequested = true;
  console.log(
    "Workflow code changed; waiting for active work to finish before restarting the worker.",
  );
  restartWorkerIfIdle();
}

function restartWorkerIfIdle() {
  if (!restartRequested || stopping) return;
  const active = getDb()
    .prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM workflow_tasks
        WHERE status IN ('running', 'cancelling')
      )
      OR EXISTS (
        SELECT 1 FROM skill_analysis_jobs
        WHERE status = 'running'
      )
      OR EXISTS (
        SELECT 1 FROM repositories
        WHERE status IN ('syncing', 'cancelling')
      )
      OR EXISTS (
        SELECT 1 FROM quick_reviews
        WHERE status = 'running'
      )
      OR EXISTS (
        SELECT 1 FROM runs
        WHERE status = 'running'
      )
      LIMIT 1
    `)
    .get();
  if (active) return;
  if (worker) {
    worker.kill("SIGTERM");
  } else {
    startWorker();
  }
}

const poller = setInterval(() => {
  const currentVersion = workflowRuntimeFingerprint();
  if (currentVersion !== observedVersion) {
    observedVersion = currentVersion;
    requestRestart();
  }
  restartWorkerIfIdle();
}, POLL_INTERVAL_MS);
poller.unref();

function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  clearInterval(poller);
  if (worker) {
    worker.kill(signal);
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

startWorker();
