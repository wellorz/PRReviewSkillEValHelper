import assert from "node:assert/strict";
import test from "node:test";
import {
  azureHumanFindings,
  isExplicitOwnerConfirmation,
} from "@/lib/azure-devops";

const reviewer = {
  id: "reviewer",
  displayName: "Reviewer",
  uniqueName: "reviewer@example.com",
};
const owner = {
  id: "owner",
  displayName: "Owner",
  uniqueName: "owner@example.com",
};
const pr = {
  pullRequestId: 42,
  title: "Example",
  description: null,
  status: "completed",
  isDraft: false,
  creationDate: "2026-09-01T00:00:00Z",
  closedDate: "2026-09-02T00:00:00Z",
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  createdBy: owner,
  lastMergeSourceCommit: { commitId: "source" },
  lastMergeTargetCommit: { commitId: "target" },
};

function thread(
  id: number,
  review: string,
  ownerReply: string,
) {
  return {
    id,
    status: "fixed",
    threadContext: {
      filePath: "/src/example.ts",
      rightFileStart: { line: 12 },
    },
    pullRequestThreadContext: {
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: 2,
      },
    },
    comments: [
      {
        id: 1,
        content: review,
        commentType: "text",
        isDeleted: false,
        publishedDate: "2026-09-01T01:00:00Z",
        author: reviewer,
      },
      {
        id: 2,
        content: ownerReply,
        commentType: "text",
        isDeleted: false,
        publishedDate: "2026-09-01T02:00:00Z",
        author: owner,
      },
    ],
  };
}

test("requires explicit PR-owner confirmation for Azure credit", () => {
  const findings = azureHumanFindings(
    pr,
    [
      thread(
        1,
        "This result is incorrectly skipped and can lose the security descriptor.",
        "Good catch, thanks very much!",
      ),
      thread(
        2,
        "Is it possible that both kinds of changes occur? Please make sure it was tested.",
        "It should be possible and the current branches already handle it.",
      ),
    ],
    ["src/inside-filter"],
    [
      {
        id: 2,
        sourceRefCommit: { commitId: "iteration-source" },
        targetRefCommit: { commitId: "iteration-target" },
      },
    ],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "azure-thread-1-comment-1");
  assert.ok(findings[0].valueReasons.includes("pr-owner-confirmed"));
  assert.equal(findings[0].iterationId, 2);
  assert.equal(findings[0].iterationSourceCommit, "iteration-source");
  assert.equal(findings[0].iterationResolution, "thread-context");
});

test("does not credit confirmed test-only feedback", () => {
  const findings = azureHumanFindings(
    pr,
    [thread(3, "Please add UT for this helper.", "Fixed.")],
    [],
  );
  assert.equal(findings.length, 0);
  assert.equal(isExplicitOwnerConfirmation("It should be possible."), false);
  assert.equal(isExplicitOwnerConfirmation("Good catch, thanks!"), true);
});
