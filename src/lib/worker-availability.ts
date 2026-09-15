import { hasCurrentWorkflowWorkerVersion } from "@/lib/workflow-version";

export function hasRecentRepositoryScanProgress(repository: {
  status: string;
  updated_at: string;
}) {
  if (repository.status !== "syncing") return false;
  const lastProgress = Date.parse(
    repository.updated_at.includes("T")
      ? repository.updated_at
      : `${repository.updated_at.replace(" ", "T")}Z`,
  );
  return (
    Number.isFinite(lastProgress) &&
    Date.now() - lastProgress <= 5 * 60 * 1000
  );
}

export function workerAvailableForRepository(repository: {
  status: string;
  updated_at: string;
}) {
  return (
    hasCurrentWorkflowWorkerVersion() ||
    hasRecentRepositoryScanProgress(repository)
  );
}
