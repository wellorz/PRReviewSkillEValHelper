import fs from "node:fs/promises";
import path from "node:path";
import type {
  HumanFinding,
  ReviewSnapshotManifest,
  ReviewSnapshotManifestEntry,
} from "@/lib/types";

type GroundTruthPr = {
  id: number;
  dataset_path: string;
  defect_description: string | null;
  url: string;
};

export type ReviewSnapshot = ReviewSnapshotManifestEntry & {
  datasetPath: string;
  truth: HumanFinding[];
};

export function restoreLegacyCappedCredits(findings: HumanFinding[]) {
  return findings.map((finding) => {
    if (!finding.valueReasons.includes("per-pr-credit-cap")) return finding;
    return {
      ...finding,
      scorePoint: 1 as const,
      valueReasons: finding.valueReasons.filter(
        (reason) => reason !== "per-pr-credit-cap",
      ),
    };
  });
}

export async function loadGroundTruth(
  pr: GroundTruthPr,
): Promise<HumanFinding[]> {
  return (await loadReviewSnapshots(pr)).flatMap((snapshot) => snapshot.truth);
}

async function readFindings(datasetPath: string) {
  let findings: HumanFinding[] = [];
  try {
    findings = JSON.parse(
      await fs.readFile(
        path.join(datasetPath, "human-findings.json"),
        "utf8",
      ),
    ) as HumanFinding[];
  } catch {
    findings = [];
  }
  findings = restoreLegacyCappedCredits(findings);
  findings = findings.map((finding) =>
    finding.id.startsWith("azure-thread-") &&
    !finding.valueReasons.includes("pr-owner-confirmed")
      ? { ...finding, scorePoint: 0 }
      : finding,
  );
  return findings;
}

async function fallbackManifest(
  pr: GroundTruthPr,
): Promise<ReviewSnapshotManifest> {
  const metadata = JSON.parse(
    await fs.readFile(path.join(pr.dataset_path, "pr.json"), "utf8"),
  ) as {
    head?: { sha?: unknown };
    base?: { sha?: unknown };
    reviewIteration?: { id?: unknown };
  };
  const sourceCommit =
    typeof metadata.head?.sha === "string" ? metadata.head.sha : "";
  const targetCommit =
    typeof metadata.base?.sha === "string" ? metadata.base.sha : "";
  const iterationId =
    typeof metadata.reviewIteration?.id === "number"
      ? metadata.reviewIteration.id
      : null;
  return {
    version: 1,
    snapshots: [
      {
        key: iterationId == null ? "final" : `iteration-${iterationId}`,
        iterationId,
        sourceCommit,
        targetCommit,
        isFinal: true,
        relativePath: ".",
        findingIds: [],
      },
    ],
  };
}

export async function loadReviewSnapshots(
  pr: GroundTruthPr,
): Promise<ReviewSnapshot[]> {
  let manifest: ReviewSnapshotManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(
        path.join(pr.dataset_path, "review-snapshots.json"),
        "utf8",
      ),
    ) as ReviewSnapshotManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.snapshots)) {
      throw new Error("Unsupported review snapshot manifest");
    }
  } catch {
    manifest = await fallbackManifest(pr);
  }
  const snapshots = await Promise.all(
    manifest.snapshots.map(async (entry) => {
      const datasetPath = path.resolve(pr.dataset_path, entry.relativePath);
      const truth = (await readFindings(datasetPath)).map((finding) => ({
        ...finding,
        iterationId: finding.iterationId ?? entry.iterationId,
        iterationSourceCommit:
          finding.iterationSourceCommit ?? entry.sourceCommit,
        iterationTargetCommit:
          finding.iterationTargetCommit ?? entry.targetCommit,
      }));
      return { ...entry, datasetPath, truth };
    }),
  );
  const finalSnapshot =
    snapshots.find((snapshot) => snapshot.isFinal) ?? snapshots.at(-1);
  if (pr.defect_description?.trim() && finalSnapshot) {
    finalSnapshot.truth.push({
      id: `manual-defect-${pr.id}`,
      source: "issue_comment",
      author: "benchmark-curator",
      authorAssociation: "OWNER",
      body: pr.defect_description.trim(),
      path: null,
      line: null,
      originalLine: null,
      url: pr.url,
      createdAt: new Date().toISOString(),
      valueScore: 10,
      valueReasons: ["manual-defect-description"],
      scorePoint: 1,
      iterationId: finalSnapshot.iterationId,
      iterationSourceCommit: finalSnapshot.sourceCommit,
      iterationTargetCommit: finalSnapshot.targetCommit,
      iterationResolution: "final",
    });
  }
  return snapshots.filter((snapshot) => snapshot.truth.length > 0);
}
