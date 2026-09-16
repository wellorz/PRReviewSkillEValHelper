import assert from "node:assert/strict";
import test from "node:test";
import {
  trainingFailureRecovery,
  trainingMetricsScore,
} from "@/lib/skill-training";

test("identifies zero-credit training results without treating invalid scores as zero", () => {
  assert.deepEqual(
    trainingMetricsScore(
      JSON.stringify({ earnedPoints: 0, availablePoints: 2 }),
    ),
    { earned: 0, available: 2 },
  );
  assert.deepEqual(
    trainingMetricsScore(
      JSON.stringify({ truePositives: 1, falseNegatives: 2 }),
    ),
    { earned: 1, available: 3 },
  );
  assert.equal(trainingMetricsScore(null), null);
  assert.equal(trainingMetricsScore("{invalid"), null);
});

test("retries transient training failures without retrying deterministic safety failures", () => {
  assert.deepEqual(
    trainingFailureRecovery(
      "Execution failed: 400 Bad Request (Request ID: transient)",
    ).retryDelaysMs,
    [15_000, 60_000],
  );
  assert.deepEqual(
    trainingFailureRecovery("copilot timed out after 5400000ms").retryDelaysMs,
    [30_000],
  );
  assert.deepEqual(
    trainingFailureRecovery(
      "PR head commit abc is unavailable, and no local ref contains a verified commit",
    ).retryDelaysMs,
    [],
  );
  assert.deepEqual(
    trainingFailureRecovery(
      "Apply stopped: SKILL.md contains a replacement or removal",
    ).retryDelaysMs,
    [],
  );
  assert.deepEqual(
    trainingFailureRecovery(
      "Apply stopped: SKILL.md contains a replacement or removal",
      "analysis",
    ).retryDelaysMs,
    [15_000, 60_000],
  );
});
