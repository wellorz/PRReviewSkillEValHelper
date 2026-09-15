import fs from "node:fs/promises";
import path from "node:path";
import { loadGroundTruth } from "@/lib/ground-truth";
import {
  pathMatchesFilters,
  prCreatedOnOrBefore,
} from "@/lib/repository-source";

export type ExistingDatasetPullRequest = {
  id: number;
  number: number;
  dataset_path: string;
  defect_description: string | null;
  url: string;
  select_level?: number;
  source_created_at?: string | null;
};

export async function findReusablePullRequests(
  pullRequests: ExistingDatasetPullRequest[],
  filters: string[],
  expectedSelectLevel?: number,
  createdBefore?: string | null,
) {
  const reusable: ExistingDatasetPullRequest[] = [];
  for (const pullRequest of pullRequests) {
    try {
      const [filesJson, findings] = await Promise.all([
        fs.readFile(path.join(pullRequest.dataset_path, "files.json"), "utf8"),
        loadGroundTruth(pullRequest),
        fs.readFile(
          path.join(pullRequest.dataset_path, "review-snapshots.json"),
          "utf8",
        ),
      ]);
      const files = JSON.parse(filesJson) as Array<
        string | { filename?: unknown; path?: unknown }
      >;
      const filenames = files
        .map((file) =>
          typeof file === "string"
            ? file
            : typeof file.filename === "string"
              ? file.filename
              : typeof file.path === "string"
                ? file.path
                : null,
        )
        .filter((filename): filename is string => Boolean(filename));
      const matchesFilter =
        filters.length === 0 ||
        filenames.some((filename) => pathMatchesFilters(filename, filters));
      const creditedFindings = findings.filter(
        (finding) => (finding.scorePoint ?? 1) === 1,
      );
      const matchesSelectLevel =
        expectedSelectLevel === undefined ||
        pullRequest.select_level === expectedSelectLevel;
      const matchesCreationCutoff = prCreatedOnOrBefore(
        pullRequest.source_created_at,
        createdBefore,
      );
      if (
        creditedFindings.length > 0 &&
        matchesFilter &&
        matchesSelectLevel &&
        matchesCreationCutoff
      ) {
        reusable.push(pullRequest);
      }
    } catch {
      // Incomplete snapshots are recollected rather than silently preserved.
    }
  }
  return reusable;
}
