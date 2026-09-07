import assert from "node:assert/strict";
import test from "node:test";
import {
  jaccard,
  matchFindings,
  scoreReview,
  scoreReviewPair,
  semanticTokenSimilarity,
} from "@/lib/scoring";
import { humanFindingScorePoint } from "@/lib/github";
import type { HumanFinding, ModelFinding } from "@/lib/types";

const human: HumanFinding = {
  id: "review-comment-1",
  source: "review_comment",
  author: "reviewer",
  authorAssociation: "MEMBER",
  body: "This can dereference a null user when the lookup does not find a record.",
  path: "src/users.ts",
  line: 42,
  originalLine: 42,
  url: "https://example.test",
  createdAt: "2026-01-01T00:00:00Z",
  valueScore: 5,
  valueReasons: ["inline-code-location", "actionable-language"],
};

const matching: ModelFinding = {
  title: "Missing null guard",
  description: "The user lookup can return null and is dereferenced immediately.",
  severity: "high",
  file: "src/users.ts",
  lineStart: 42,
  lineEnd: 42,
  category: "correctness",
  confidence: 0.9,
  evidence: "lookup result is used without checking for null",
};

test("jaccard identifies related review text", () => {
  assert.ok(jaccard(human.body, matching.description) > 0.1);
});

test("matching combines location and semantic overlap", () => {
  assert.equal(matchFindings([human], [matching]).length, 1);
});

test("matching does not credit a finding from a different PR iteration", () => {
  assert.equal(
    matchFindings(
      [{ ...human, iterationId: 2 }],
      [{ ...matching, iterationId: 3 }],
    ).length,
    0,
  );
  assert.equal(
    matchFindings(
      [{ ...human, iterationId: 2 }],
      [{ ...matching, iterationId: 2 }],
    ).length,
    1,
  );
});

test("matching uses the normalized defect assertion", () => {
  const normalized = {
    ...human,
    body: "Could you take a look at this?",
    normalizedBody:
      "The user lookup can return null and is dereferenced without a guard.",
  };
  assert.equal(matchFindings([normalized], [matching]).length, 1);
});

test("matching credits concise root causes for pathless expected defects", () => {
  const expected = {
    ...human,
    id: "manual-defect",
    path: null,
    line: null,
    originalLine: null,
    body:
      "Bucket zero changes the normal AD-OS Delta Compare arbitration mailbox identity. " +
      "The default BucketIndex 0 appends an unexpected -0 suffix to ConfigurationName, " +
      "causing repeated cancellation and overlapping workers with high memory pressure.",
  };
  const finding = {
    ...matching,
    title: "config-name-bucket-zero",
    description:
      "Appending bucket zero changes existing normal ConfigurationName identities and " +
      "breaks arbitration-mailbox matching.",
    evidence:
      "The condition changed from BucketIndex > 0 to >= 0 while normal callers pass zero.",
  };
  const similarity = semanticTokenSimilarity(
    expected.body,
    `${finding.title} ${finding.description} ${finding.evidence}`,
  );
  assert.ok(similarity.score >= 0.26);
  assert.equal(matchFindings([expected], [finding]).length, 1);
});

test("pathless matching rejects unrelated findings from the same subsystem", () => {
  const expected = {
    ...human,
    id: "manual-defect",
    path: null,
    line: null,
    originalLine: null,
    body:
      "Changing the cleanup configuration is ignored because equality checks only the " +
      "destination and data generation, so the running task is not restarted.",
  };
  const finding = {
    ...matching,
    title: "Transient scan failures are not retried",
    description:
      "A cleanup table scan faults when its asynchronous page request fails.",
    evidence:
      "The scan path does not apply the configured retry count or sleep interval.",
  };
  assert.equal(matchFindings([expected], [finding]).length, 0);
});

test("semantic overlap does not override a conflicting human file location", () => {
  assert.equal(
    matchFindings(
      [
        {
          ...human,
          body:
            "BucketIndex zero appends an unexpected suffix to ConfigurationName.",
        },
      ],
      [
        {
          ...matching,
          title: "Bucket zero suffix",
          description:
            "BucketIndex zero appends an unexpected suffix to ConfigurationName.",
          file: "src/unrelated.ts",
        },
      ],
    ).length,
    0,
  );
});

test("paired scoring selects the stronger review", () => {
  const metrics = scoreReviewPair([human], [matching], [], 1000, 800);
  assert.equal(metrics.winner, "skilled");
  assert.equal(metrics.skilled.recall, 1);
  assert.equal(metrics.baseline.recall, 0);
  assert.equal(metrics.skilled.earnedPoints, 1);
  assert.equal(metrics.skilled.availablePoints, 1);
});

test("standalone scoring compares one review directly with defects", () => {
  const metrics = scoreReview([human], [matching]);
  assert.equal(metrics.earnedPoints, 1);
  assert.equal(metrics.availablePoints, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falseNegatives, 0);
});

test("winner is based on earned credits rather than false-positive penalties", () => {
  const extra = {
    ...matching,
    title: "Unrelated warning",
    description: "An unrelated warning that does not match ground truth.",
    file: "src/other.ts",
    lineStart: 10,
    lineEnd: 10,
  };
  const metrics = scoreReviewPair(
    [human],
    [matching, extra],
    [matching],
    1000,
    800,
  );
  assert.equal(metrics.skilled.earnedPoints, 1);
  assert.equal(metrics.baseline.earnedPoints, 1);
  assert.ok(metrics.skilled.f1 < metrics.baseline.f1);
  assert.equal(metrics.winner, "tie");
});

test("minor comments have zero points and do not reduce coverage", () => {
  const minor = {
    ...human,
    id: "minor-comment",
    body: "Nit: rename this variable to match the naming convention.",
    scorePoint: 0 as const,
  };
  const metrics = scoreReviewPair([human, minor], [matching], [], 1000, 800);
  assert.equal(humanFindingScorePoint(minor.body), 0);
  assert.equal(metrics.skilled.earnedPoints, 1);
  assert.equal(metrics.skilled.availablePoints, 1);
  assert.equal(metrics.skilled.ignoredHumanFindings, 1);
  assert.equal(metrics.skilled.recall, 1);
});
