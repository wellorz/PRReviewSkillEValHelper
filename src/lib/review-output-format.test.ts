import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewResult } from "@/lib/review-output-format";

test("formats review findings and preserves execution metadata", () => {
  const output = formatReviewResult({
    metadata: {
      type: "personal-skill",
      pullRequest: 5186793,
      pullRequestTitle: "Compare Engine Setup",
      configuration: "wzReview",
      model: "gpt-5.6-sol",
      modelSecondary: "gpt-5.6-terra",
      contextTier: "long_context",
      repositoryContextMode: "local_repo",
      repositoryCommit: "7ad5385",
      rawJsonUrl: "/api/results/1/output?format=json",
    },
    findings: [
      {
        title: "Bucket zero changes mailbox identity",
        description: "The added suffix breaks the existing mailbox name.",
        severity: "high",
        file: "ObjectStoreConfiguration.cs",
        lineStart: 135,
        lineEnd: 139,
        category: "reliability",
        confidence: 0.99,
        evidence: "BucketIndex defaults to zero.",
        reviewer: "Gpt/Reliability",
        reviewers: ["Gpt/Reliability", "Claude/FeatureOwner"],
        sourceModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
        contextTier: "long_context",
        suggestion: "Do not append -0 to the legacy configuration name.",
        verification: "cross-model",
        agreedBy: ["gpt-5.6-sol", "gpt-5.6-terra"],
      },
    ],
    metrics: null,
  });

  assert.match(output, /model: gpt-5\.6-sol/);
  assert.match(output, /modelSecondary: gpt-5\.6-terra/);
  assert.match(output, /repositoryCommit: "7ad5385"/);
  assert.match(output, /title: "Bucket zero changes mailbox identity"/);
  assert.match(output, /finding: \|-/);
  assert.match(output, /evidence: \|-/);
  assert.match(output, /reviewers: \["Gpt\/Reliability","Claude\/FeatureOwner"\]/);
  assert.match(output, /sourceModels: \["gpt-5\.6-sol","gpt-5\.6-terra"\]/);
  assert.match(output, /contextTier: long_context/);
  assert.match(output, /verification: cross-model/);
  assert.match(output, /suggestion: \|-/);
});

test("adds configured model and context to unattributed findings", () => {
  const output = formatReviewResult({
    metadata: {
      type: "baseline",
      pullRequest: 5504211,
      pullRequestTitle: "Add request size metrics",
      configuration: "GPT-5.6 Sol 4K",
      model: "gpt-5.6-sol",
      modelSecondary: "none",
      contextTier: "default",
      repositoryContextMode: "local_repo",
      repositoryCommit: "abc123",
      rawJsonUrl: "/api/results/2/output?format=json",
    },
    findings: [
      {
        title: "Missing request size",
        description: "The metric omits the request size.",
        severity: "medium",
        file: "Metrics.cs",
        lineStart: 42,
        lineEnd: 42,
        category: "correctness",
        confidence: 0.9,
        evidence: "The new event does not set RequestSize.",
      },
    ],
    metrics: null,
  });

  assert.match(output, /sourceModels: \["gpt-5\.6-sol"\]/);
  assert.match(output, /contextTier: default/);
});
