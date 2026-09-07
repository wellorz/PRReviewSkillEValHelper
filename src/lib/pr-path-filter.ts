import fs from "node:fs/promises";
import path from "node:path";
import {
  parsePathFilters,
  pathMatchesFilters,
} from "@/lib/repository-source";

type PullRequestDataset = {
  id: number;
  dataset_path: string;
};

type ChangedFile = {
  filename?: unknown;
  path?: unknown;
};

export async function loadPullRequestChangedPaths(datasetPath: string) {
  const raw = JSON.parse(
    await fs.readFile(path.join(datasetPath, "files.json"), "utf8"),
  ) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const file = item as ChangedFile;
      return typeof file.filename === "string"
        ? file.filename
        : typeof file.path === "string"
          ? file.path
          : null;
    })
    .filter((filePath): filePath is string => Boolean(filePath));
}

export function changedPathsMatchFilter(
  changedPaths: string[],
  pathFilter: string | null | undefined,
) {
  const filters = parsePathFilters(pathFilter);
  return (
    filters.length === 0 ||
    changedPaths.some((filePath) => pathMatchesFilters(filePath, filters))
  );
}

export async function filterPullRequestsByChangedPath<
  T extends PullRequestDataset,
>(pullRequests: T[], pathFilter: string | null | undefined) {
  const filters = parsePathFilters(pathFilter);
  if (filters.length === 0) return pullRequests;
  const matches = await Promise.all(
    pullRequests.map(async (pullRequest) => ({
      pullRequest,
      matches: (
        await loadPullRequestChangedPaths(pullRequest.dataset_path)
      ).some((filePath) => pathMatchesFilters(filePath, filters)),
    })),
  );
  return matches
    .filter((item) => item.matches)
    .map((item) => item.pullRequest);
}
