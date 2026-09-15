import assert from "node:assert/strict";
import test from "node:test";
import { resolveRepositoryReviewSettings } from "@/lib/repository-review-settings";

test("preserves saved review settings when a repository is rescanned", () => {
  const settings = resolveRepositoryReviewSettings(
    {},
    {
      skill_path: "Q:\\skills\\wz-review",
      model: "gpt-5.6-sol",
      model_secondary: "grok-4.6",
      context_tier: "long_context",
      baseline_concurrency: 9,
    },
  );

  assert.equal(settings.skillPath, "Q:\\skills\\wz-review");
  assert.equal(settings.model, "gpt-5.6-sol");
  assert.equal(settings.modelSecondary, "grok-4.6");
  assert.equal(settings.contextTier, "long_context");
  assert.equal(settings.baselineConcurrency, 9);
});

test("uses explicit review settings when supplied", () => {
  const settings = resolveRepositoryReviewSettings(
    {
      skillPath: "Q:\\skills\\replacement",
      model: "gpt-5.4",
      modelSecondary: "none",
      contextTier: "default",
      baselineConcurrency: 3,
    },
    {
      skill_path: "Q:\\skills\\wz-review",
      model: "gpt-5.6-sol",
      model_secondary: "grok-4.6",
      context_tier: "long_context",
      baseline_concurrency: 9,
    },
  );

  assert.equal(settings.skillPath, "Q:\\skills\\replacement");
  assert.equal(settings.model, "gpt-5.4");
  assert.equal(settings.modelSecondary, "none");
  assert.equal(settings.contextTier, "default");
  assert.equal(settings.baselineConcurrency, 3);
});

