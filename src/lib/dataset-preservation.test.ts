import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findReusablePullRequests } from "@/lib/dataset-preservation";

test("preserves only credited snapshots matching the current path filter", async () => {
  const root = path.join(
    process.cwd(),
    "runtime",
    `dataset-preservation-${process.pid}-${Date.now()}`,
  );
  const matching = path.join(root, "matching");
  const outside = path.join(root, "outside");
  try {
    await Promise.all([
      fs.mkdir(matching, { recursive: true }),
      fs.mkdir(outside, { recursive: true }),
    ]);
    const creditedFinding = [
      {
        id: "finding-1",
        source: "review_comment",
        author: "reviewer",
        authorAssociation: "MEMBER",
        body: "This change drops retryable failures.",
        path: "src/service.ts",
        line: 10,
        originalLine: 10,
        url: "https://example.test/pr/1",
        createdAt: "2026-09-03T00:00:00.000Z",
        valueScore: 5,
        valueReasons: ["actionable-language"],
        scorePoint: 1,
      },
    ];
    await Promise.all([
      fs.writeFile(
        path.join(matching, "files.json"),
        JSON.stringify([{ filename: "src/service.ts" }]),
      ),
      fs.writeFile(
        path.join(matching, "human-findings.json"),
        JSON.stringify(creditedFinding),
      ),
      fs.writeFile(
        path.join(matching, "review-snapshots.json"),
        JSON.stringify({
          version: 1,
          snapshots: [
            {
              key: "iteration-1",
              iterationId: 1,
              sourceCommit: "source",
              targetCommit: "target",
              isFinal: true,
              relativePath: ".",
              findingIds: ["finding-1"],
            },
          ],
        }),
      ),
      fs.writeFile(
        path.join(outside, "files.json"),
        JSON.stringify([{ filename: "tests/service.test.ts" }]),
      ),
      fs.writeFile(
        path.join(outside, "human-findings.json"),
        JSON.stringify(creditedFinding),
      ),
      fs.writeFile(
        path.join(outside, "review-snapshots.json"),
        JSON.stringify({
          version: 1,
          snapshots: [
            {
              key: "iteration-1",
              iterationId: 1,
              sourceCommit: "source",
              targetCommit: "target",
              isFinal: true,
              relativePath: ".",
              findingIds: ["finding-1"],
            },
          ],
        }),
      ),
    ]);
    const rows = [
      {
        id: 1,
        number: 1,
        dataset_path: matching,
        defect_description: null,
        url: "https://example.test/pr/1",
      },
      {
        id: 2,
        number: 2,
        dataset_path: outside,
        defect_description: null,
        url: "https://example.test/pr/2",
      },
    ];
    assert.deepEqual(
      (await findReusablePullRequests(rows, ["src"])).map((row) => row.id),
      [1],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
