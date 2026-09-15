import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCollectionMode,
  normalizeConfirmationWords,
  parseConfirmationWords,
  selectionLevelForMode,
} from "@/lib/collection-policy";

test("normalizes collection policy values", () => {
  assert.equal(normalizeCollectionMode(undefined), "strict_confirmed");
  assert.equal(normalizeCollectionMode("resolved_comments"), "resolved_comments");
  assert.equal(selectionLevelForMode("strict_confirmed"), 1);
  assert.equal(selectionLevelForMode("resolved_comments"), 0);
});

test("normalizes and parses custom confirmation words", () => {
  assert.deepEqual(
    normalizeConfirmationWords([" Confirmed ", "Confirmed", "", "Accepted"]),
    ["Confirmed", "Accepted"],
  );
  assert.deepEqual(
    parseConfirmationWords('["Confirmed","Accepted","Confirmed"]'),
    ["Confirmed", "Accepted"],
  );
  assert.deepEqual(parseConfirmationWords("invalid"), []);
});
