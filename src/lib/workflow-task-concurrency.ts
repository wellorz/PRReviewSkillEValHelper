export type WorkflowTaskCapacity = {
  kind: "manual_pr" | "baseline" | "skill_eval";
  repositoryId: number;
  totalItems: number;
  payloadJson: string | null;
};

export type RunningWorkflowTaskCapacity = {
  kind: WorkflowTaskCapacity["kind"];
  repositoryId: number;
  slots: number;
};

export type ActiveSkillTaskCapacity = {
  totalItems: number;
  currentItem: number;
  payloadJson: string | null;
};

function taskCapacityRequest(payloadJson: string | null) {
  let requested = 1;
  let reservesFullConcurrency = false;
  try {
    const payload = JSON.parse(payloadJson ?? "{}") as {
      concurrency?: unknown;
      snapshotParallelism?: unknown;
    };
    if (
      typeof payload.concurrency === "number" &&
      Number.isInteger(payload.concurrency)
    ) {
      requested = Math.max(1, payload.concurrency);
    }
    reservesFullConcurrency = payload.snapshotParallelism === true;
  } catch {
    // Invalid task payloads are handled by the workflow executor.
  }
  return { requested, reservesFullConcurrency };
}

export function workflowTaskSlots(task: WorkflowTaskCapacity) {
  if (task.kind !== "skill_eval") return 1;
  const { requested } = taskCapacityRequest(task.payloadJson);
  return Math.min(Math.max(1, task.totalItems), requested);
}

export function reservedSkillReviewSlots(
  tasks: ActiveSkillTaskCapacity[],
  repositoryConcurrency: number,
) {
  const capacity = Math.max(1, repositoryConcurrency);
  return Math.min(
    capacity,
    tasks.reduce((total, task) => {
      const remaining = Math.max(0, task.totalItems - task.currentItem);
      const request = taskCapacityRequest(task.payloadJson);
      return (
        total +
        (request.reservesFullConcurrency && remaining > 0
          ? request.requested
          : Math.min(remaining, request.requested))
      );
    }, 0),
  );
}

export function canStartWorkflowTask(
  task: WorkflowTaskCapacity,
  running: RunningWorkflowTaskCapacity[],
  repositoryConcurrency: number,
) {
  if (task.kind === "manual_pr") return running.length === 0;
  if (running.some((active) => active.kind === "manual_pr")) return false;
  if (task.kind === "baseline") {
    return !running.some((active) => active.kind === "baseline");
  }

  const activeSkillTasks = running.filter(
    (active) => active.kind === "skill_eval",
  );
  if (task.totalItems > 1) return activeSkillTasks.length === 0;
  if (activeSkillTasks.some((active) => active.slots > 1)) return false;
  const usedSlots = activeSkillTasks
    .filter((active) => active.repositoryId === task.repositoryId)
    .reduce((sum, active) => sum + active.slots, 0);
  return usedSlots < Math.max(1, repositoryConcurrency);
}
