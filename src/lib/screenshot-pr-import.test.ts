import assert from "node:assert/strict";
import test from "node:test";
import { extractExplicitPrNumbers } from "@/lib/screenshot-pr-import";

test("extracts explicit PR numbers without treating commits or task IDs as PRs", () => {
  const text = `
Merged PR 5606853: Support soft-deleted mailbox backfill
3f0c822f Aastha Ghimire
Task 7803973: unrelated work item
Merged PR #5486582: Add cleanup engine
PR: 5602844 Setting flags
455b8596 commit
Merged PR 5486582: duplicate OCR line
`;

  assert.deepEqual(extractExplicitPrNumbers(text), [
    5606853,
    5486582,
    5602844,
  ]);
});

