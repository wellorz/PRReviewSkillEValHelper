import assert from "node:assert/strict";
import test from "node:test";
import { humanFindingScorePoint, scoreHumanComment } from "@/lib/github";

test("rejects bot and low-value comments", () => {
  assert.equal(
    scoreHumanComment(
      {
        id: 1,
        body: "LGTM",
        html_url: "",
        created_at: "",
        author_association: "MEMBER",
        user: { login: "review-bot[bot]", type: "Bot" },
      },
      "author",
    ).score,
    0,
  );
});

test("values actionable inline review comments", () => {
  const result = scoreHumanComment(
    {
      id: 2,
      body: "This can fail when the user lookup returns null. We should guard the result before dereferencing it.",
      html_url: "",
      created_at: "",
      author_association: "MEMBER",
      user: { login: "reviewer", type: "User" },
      path: "src/users.ts",
      line: 42,
    },
    "author",
  );
  assert.ok(result.score >= 5);
  assert.ok(result.reasons.includes("inline-code-location"));
});

test("does not credit test-only or formatting comments", () => {
  assert.equal(humanFindingScorePoint("Please add UT for this method."), 0);
  assert.equal(humanFindingScorePoint("Update the formatting here."), 0);
  assert.equal(
    humanFindingScorePoint(
      "This result is incorrectly skipped and can lose the security descriptor. Add a regression test.",
    ),
    1,
  );
});
