import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  adaptDevLoopReviewResponse,
  devLoopRunnerEnvironment,
} from "@/lib/devloop-review";

const sourceCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);

function response(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    savedModels: ["gpt-5.6-sol[1m]", "gpt-5.6-terra[1m]"],
    evaluationRunPath: path.resolve("Q:\\devloop-evaluation"),
    review: {
      prId: 7,
      reviewedSha: sourceCommit,
      baseSha: targetCommit,
      reviewedIteration: 8,
      publishRequested: false,
      reviewerModels: ["gpt-5.6-sol[1m]", "gpt-5.6-terra[1m]"],
      comments: [
        {
          id: "c0",
          file: "/src/file.cs",
          line: 12,
          severity: "concern",
          body: "The retry advances the checkpoint before the durable write.",
          reviewerModels: [
            "gpt-5.6-sol[1m]",
            "gpt-5.6-terra[1m]",
          ],
          reviewerIds: ["reviewer-sol", "reviewer-terra"],
        },
      ],
      ...overrides,
    },
  });
}

test("adapts DevLoop findings without outer-model attribution", () => {
  const adapted = adaptDevLoopReviewResponse(response(), {
    prId: 7,
    sourceCommit,
    targetCommit,
    iterationId: 8,
  });
  assert.deepEqual(adapted.output.findings[0]?.sourceModels, [
    "gpt-5.6-sol[1m]",
    "gpt-5.6-terra[1m]",
  ]);
  assert.equal(adapted.output.findings[0]?.severity, "high");
  assert.equal(adapted.evidence.publishRequested, false);
  assert.equal(adapted.evidence.reviewedIteration, 8);
  assert.equal(adapted.evidence.evaluationRunPath, path.resolve("Q:\\devloop-evaluation"));
});

test("rejects mismatched or publication-enabled DevLoop responses", () => {
  const expected = {
    prId: 7,
    sourceCommit,
    targetCommit,
    iterationId: 8,
  };
  assert.throws(
    () =>
      adaptDevLoopReviewResponse(
        response({ reviewedSha: "3".repeat(40) }),
        expected,
      ),
    /different PR iteration or commit/,
  );
  assert.throws(
    () =>
      adaptDevLoopReviewResponse(
        response({ publishRequested: true }),
        expected,
      ),
    /unexpectedly requested publication/,
  );
});

test("sanitizes the DevLoop runner environment", () => {
  const env = devLoopRunnerEnvironment({
    NODE_ENV: "test",
    PATH: "Q:\\bin",
    DEVLOOP_BACKEND_URL: "http://127.0.0.1:9999",
    GH_TOKEN: "secret",
    AZURE_DEVOPS_EXT_PAT: "secret",
  });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PATH, "Q:\\bin");
  assert.equal(env.DEVLOOP_BACKEND_URL, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.AZURE_DEVOPS_EXT_PAT, undefined);
});
