import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";

const WORKFLOW_VERSION_FILES = [
  ["scripts", "worker.ts"],
  ["src", "lib", "copilot.ts"],
  ["src", "lib", "process.ts"],
  ["src", "lib", "repository-context.ts"],
  ["src", "lib", "workflow-cancellation.ts"],
  ["src", "lib", "workflow.ts"],
];
const WORKER_HEARTBEAT_MAX_AGE_MS = 15_000;

function runtimeFingerprint() {
  const hash = createHash("sha256");
  hash.update("workflow-runtime-v5");
  for (const segments of WORKFLOW_VERSION_FILES) {
    const absolutePath = path.join(process.cwd(), ...segments);
    hash.update(segments.join("/"));
    try {
      hash.update(fs.readFileSync(absolutePath));
    } catch {
      hash.update("unavailable");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export const WORKFLOW_WORKER_VERSION = runtimeFingerprint();

export function markWorkflowWorkerVersion() {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO app_state (key, value)
      VALUES ('workflow_worker_version', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
      .run(WORKFLOW_WORKER_VERSION);
    db.prepare(`
      INSERT INTO app_state (key, value)
      VALUES ('workflow_worker_heartbeat', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
      .run(now);
  })();
}

export function hasCurrentWorkflowWorkerVersion() {
  const rows = getDb()
    .prepare(`
      SELECT key, value FROM app_state
      WHERE key IN ('workflow_worker_version', 'workflow_worker_heartbeat')
    `)
    .all() as Array<{ key: string; value: string }>;
  const state = new Map(rows.map((row) => [row.key, row.value]));
  const heartbeat = Date.parse(state.get("workflow_worker_heartbeat") ?? "");
  return (
    state.get("workflow_worker_version") === WORKFLOW_WORKER_VERSION &&
    Number.isFinite(heartbeat) &&
    Date.now() - heartbeat <= WORKER_HEARTBEAT_MAX_AGE_MS
  );
}
