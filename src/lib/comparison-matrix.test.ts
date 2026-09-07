import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonMatrix } from "@/app/comparison-matrix";
import {
  comparisonState,
  summarizeComparisonResults,
} from "@/lib/comparison-matrix";

test("counts only completed credits and preserves every execution state", () => {
  const summary = summarizeComparisonResults(
    [
      { status: "completed", earnedPoints: 3 },
      { status: "running", earnedPoints: 9 },
      { status: "failed", earnedPoints: 9 },
      { status: "pending", earnedPoints: 9 },
      { status: "not-queued", earnedPoints: 0 },
    ],
    7,
    7,
  );
  assert.deepEqual(summary, {
    earnedPoints: 3,
    availablePoints: 7,
    percentage: (3 / 7) * 100,
    completed: 1,
    running: 1,
    failed: 1,
    pending: 1,
    notQueued: 3,
    totalPullRequests: 7,
  });
  assert.equal(comparisonState(summary), "1 running");
  assert.equal(comparisonState({ ...summary, running: 0 }), "1 failed");
});

test("handles an empty filtered matrix without a fabricated score", () => {
  const summary = summarizeComparisonResults([], 0, 0);
  assert.equal(summary.percentage, null);
  assert.equal(summary.notQueued, 0);
  assert.equal(comparisonState(summary), "Complete");
});

test("renders the same six comparison columns for live and saved rows", () => {
  const summary = summarizeComparisonResults(
    Array.from({ length: 7 }, (_, index) => ({
      status: "completed",
      earnedPoints: index < 3 ? 1 : 0,
    })),
    7,
    7,
  );
  const markup = renderToStaticMarkup(createElement(ComparisonMatrix, {
    rows: [{
      id: 6,
      name: "GPT-6 ASTRA 1M",
      description: "GPT-6 Astra + None",
      kind: "baseline",
      summary,
      href: "/repositories/1/history-reports/15",
    }],
  }));
  for (const column of ["Configuration", "Type", "Score", "Credits", "Completed", "State"]) {
    assert.ok(markup.includes(`<th>${column}</th>`));
  }
  assert.ok(markup.includes('href="/repositories/1/history-reports/15"'));
  assert.ok(markup.includes("GPT-6 ASTRA 1M"));
  assert.ok(markup.includes("<td>42.9</td>"));
  assert.ok(markup.includes("<td>3/7</td>"));
  assert.ok(markup.includes("<td>7/7</td>"));
  assert.ok(markup.includes("<td>Complete</td>"));
});
