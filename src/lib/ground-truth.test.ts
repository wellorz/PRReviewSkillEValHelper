import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadReviewSnapshots,
  restoreLegacyCappedCredits,
} from "@/lib/ground-truth";
import type { HumanFinding } from "@/lib/types";

function finding(id: string, valueScore: number): HumanFinding {
  return {
    id,
    source: "review_comment",
    author: "reviewer",
    authorAssociation: "MEMBER",
    body: id,
    path: "src/example.ts",
    line: 1,
    originalLine: 1,
    url: "https://example.test/pr/1",
    createdAt: `2026-09-03T00:00:0${id.at(-1)}.000Z`,
    valueScore,
    valueReasons: ["actionable-language"],
    scorePoint: 1,
  };
}

test("restores findings suppressed by the former per-PR credit cap", () => {
  const findings = Array.from({ length: 6 }, (_, index) =>
    finding(`finding-${index + 1}`, index + 1),
  );
  findings[0] = {
    ...findings[0],
    scorePoint: 0,
    valueReasons: ["actionable-language", "per-pr-credit-cap"],
  };
  const restored = restoreLegacyCappedCredits(findings);
  assert.equal(restored.filter((item) => item.scorePoint === 1).length, 6);
  assert.deepEqual(restored[0].valueReasons, ["actionable-language"]);
});

test("assigns curator defects to the final iteration snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-snapshots-"));
  const iteration2 = path.join(root, "iterations", "iteration-2");
  const iteration3 = path.join(root, "iterations", "iteration-3");
  await Promise.all([
    fs.mkdir(iteration2, { recursive: true }),
    fs.mkdir(iteration3, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(root, "review-snapshots.json"),
      JSON.stringify({
        version: 1,
        snapshots: [
          {
            key: "iteration-2",
            iterationId: 2,
            sourceCommit: "source-2",
            targetCommit: "target-2",
            isFinal: false,
            relativePath: path.join("iterations", "iteration-2"),
            findingIds: ["finding-1"],
          },
          {
            key: "iteration-3",
            iterationId: 3,
            sourceCommit: "source-3",
            targetCommit: "target-3",
            isFinal: true,
            relativePath: path.join("iterations", "iteration-3"),
            findingIds: [],
          },
        ],
      }),
    ),
    fs.writeFile(
      path.join(iteration2, "human-findings.json"),
      JSON.stringify([finding("finding-1", 5)]),
    ),
    fs.writeFile(path.join(iteration3, "human-findings.json"), "[]"),
  ]);
  try {
    const snapshots = await loadReviewSnapshots({
      id: 9,
      dataset_path: root,
      defect_description: "A manually curated final defect.",
      url: "https://example.test/pr/9",
    });
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].truth[0].iterationId, 2);
    assert.equal(snapshots[1].truth[0].id, "manual-defect-9");
    assert.equal(snapshots[1].truth[0].iterationId, 3);
    assert.equal(snapshots[1].truth[0].iterationResolution, "final");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
