import assert from "node:assert/strict";
import test from "node:test";
import { trainingMetricsScore } from "@/lib/skill-training";

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
