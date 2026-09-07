import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  decodePrSetBundle,
  PR_SET_BUNDLE_VERSION,
} from "@/lib/pr-set-transfer";

function bundle(filePath = "diff.patch") {
  return {
    format: "pr-review-skill-eval-helper",
    version: PR_SET_BUNDLE_VERSION,
    exportedAt: "2026-09-07T00:00:00.000Z",
    repositories: [
      {
        slug: "owner/repository",
        displayName: "Repository",
        provider: "github",
        cloneUrl: "https://example.invalid/owner/repository.git",
        organizationUrl: null,
        projectName: null,
        repositoryName: "repository",
        model: "gpt-5.6-sol",
        modelSecondary: "none",
        contextTier: "default",
        pullRequests: [
          {
            number: 42,
            title: "Fix issue",
            url: "https://example.invalid/pull/42",
            author: "octocat",
            baseRef: "main",
            headRef: "feature",
            mergedAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            additions: 10,
            deletions: 2,
            changedFiles: 1,
            valuedCommentCount: 1,
            rawJson: "{}",
            selected: true,
            manual: false,
            defectDescription: null,
            files: [
              {
                path: filePath,
                contentBase64: Buffer.from("diff").toString("base64"),
              },
            ],
          },
        ],
      },
    ],
  };
}

test("decodes a compressed portable PR-set bundle", async () => {
  const decoded = await decodePrSetBundle(
    gzipSync(Buffer.from(JSON.stringify(bundle()))),
  );
  assert.equal(decoded.repositories[0]?.pullRequests[0]?.number, 42);
  assert.equal(
    decoded.repositories[0]?.pullRequests[0]?.files[0]?.path,
    "diff.patch",
  );
});

test("accepts empty files in imported PR-set bundles", async () => {
  const input = bundle();
  input.repositories[0]!.pullRequests[0]!.files[0]!.contentBase64 = "";
  const decoded = await decodePrSetBundle(
    gzipSync(Buffer.from(JSON.stringify(input))),
  );
  assert.equal(
    decoded.repositories[0]?.pullRequests[0]?.files[0]?.contentBase64,
    "",
  );
});

test("rejects unsupported PR-set bundle versions", async () => {
  const input = bundle();
  input.version = PR_SET_BUNDLE_VERSION + 1;
  await assert.rejects(
    decodePrSetBundle(gzipSync(Buffer.from(JSON.stringify(input)))),
    /Unsupported PR-set bundle format or version/,
  );
});

test("rejects path traversal in imported PR-set files", async () => {
  await assert.rejects(
    decodePrSetBundle(
      gzipSync(Buffer.from(JSON.stringify(bundle("../outside.txt")))),
    ),
    /Unsafe PR-set file path/,
  );
});
