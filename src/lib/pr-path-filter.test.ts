import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  changedPathsMatchFilter,
  filterPullRequestsByChangedPath,
} from "@/lib/pr-path-filter";

test("matches changed paths by normalized directory prefix", () => {
  const changedPaths = [
    "sources/dev/Store/src/Worker.cs",
    "build/corext/corext.config",
  ];

  assert.equal(
    changedPathsMatchFilter(changedPaths, "sources\\dev\\Store"),
    true,
  );
  assert.equal(
    changedPathsMatchFilter(changedPaths, "sources/dev/Directory"),
    false,
  );
});

test("keeps only pull requests with files under the submitted path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-path-filter-"));
  const matching = path.join(root, "matching");
  const excluded = path.join(root, "excluded");
  try {
    await Promise.all([
      fs.mkdir(matching),
      fs.mkdir(excluded),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(matching, "files.json"),
        JSON.stringify([
          { filename: "sources/dev/Store/src/Worker.cs" },
          { filename: "README.md" },
        ]),
      ),
      fs.writeFile(
        path.join(excluded, "files.json"),
        JSON.stringify([{ path: "/sources/dev/Directory/User.cs" }]),
      ),
    ]);

    const result = await filterPullRequestsByChangedPath(
      [
        { id: 1, dataset_path: matching },
        { id: 2, dataset_path: excluded },
      ],
      "sources/dev/Store",
    );

    assert.deepEqual(
      result.map((pullRequest) => pullRequest.id),
      [1],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
