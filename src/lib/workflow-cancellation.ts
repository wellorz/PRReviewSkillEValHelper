import { AsyncLocalStorage } from "node:async_hooks";

const workflowCancellation = new AsyncLocalStorage<AbortSignal>();

export class WorkflowCancellationError extends Error {
  constructor() {
    super("PR review cancelled");
    this.name = "WorkflowCancellationError";
  }
}

export function runWithWorkflowCancellation<T>(
  signal: AbortSignal,
  action: () => Promise<T>,
) {
  return workflowCancellation.run(signal, action);
}

export function currentWorkflowCancellationSignal() {
  return workflowCancellation.getStore();
}

export function throwIfWorkflowCancelled(error?: unknown): void {
  if (
    error instanceof WorkflowCancellationError ||
    currentWorkflowCancellationSignal()?.aborted
  ) {
    throw new WorkflowCancellationError();
  }
}
