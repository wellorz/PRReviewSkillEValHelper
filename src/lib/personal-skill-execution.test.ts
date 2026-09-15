import assert from "node:assert/strict";
import test from "node:test";
import {
  isNativeWzReviewPath,
  personalSkillResultConfiguration,
} from "@/lib/personal-skill-execution";

test("recognizes native wz-review skill paths", () => {
  assert.equal(isNativeWzReviewPath("Q:\\skills\\wz-review"), true);
  assert.equal(isNativeWzReviewPath("Q:\\skills\\wz-review\\"), true);
  assert.equal(isNativeWzReviewPath("Q:\\skills\\other-review"), false);
});

test("keeps DevLoop as the only selectable local execution mode", () => {
  assert.deepEqual(
    personalSkillResultConfiguration("devloop-local", {
      model: "gpt-5.6-sol",
      modelSecondary: "grok-4.6",
      contextTier: "long_context",
    }),
    {
      model: "gpt-5.6-sol",
      modelSecondary: "none",
      contextTier: "long_context",
    },
  );
});
