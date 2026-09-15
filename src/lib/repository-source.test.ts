import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRepositorySource,
  pathMatchesFilters,
  prCreatedOnOrBefore,
  prNumberMatchesRange,
  reviewableChangedFilePaths,
} from "@/lib/repository-source";

test("parses Azure DevOps content URL and its path filter", () => {
  const source = parseRepositorySource(
    "https://o365exchange.visualstudio.com/O365%20Core/_git/Substrate?version=GBmaster&_a=contents&path=/sources/dev/Management/src/ServiceHost/Servicelets",
  );
  assert.equal(source.provider, "azure-devops");
  assert.equal(source.key, "o365exchange/O365 Core/Substrate");
  assert.equal(source.projectName, "O365 Core");
  assert.equal(source.repositoryName, "Substrate");
  assert.equal(
    source.suggestedPathFilter,
    "sources/dev/Management/src/ServiceHost/Servicelets",
  );
});

test("matches files under configured folder prefixes", () => {
  assert.equal(
    pathMatchesFilters(
      "/sources/dev/Management/src/ServiceHost/Servicelets/Foo.cs",
      ["sources/dev/Management/src/ServiceHost/Servicelets"],
    ),
    true,
  );
  assert.equal(
    pathMatchesFilters("sources/dev/Other/Foo.cs", [
      "sources/dev/Management/src/ServiceHost/Servicelets",
    ]),
    false,
  );
});

test("applies strict optional PR number bounds", () => {
  assert.equal(prNumberMatchesRange(200, null, null), true);
  assert.equal(prNumberMatchesRange(200, 100, null), true);
  assert.equal(prNumberMatchesRange(100, 100, null), false);
  assert.equal(prNumberMatchesRange(200, null, 300), true);
  assert.equal(prNumberMatchesRange(300, null, 300), false);
  assert.equal(prNumberMatchesRange(200, 100, 300), true);
});

test("applies an inclusive PR creation-date cutoff", () => {
  assert.equal(
    prCreatedOnOrBefore("2026-09-01T23:59:59Z", "2026-09-01"),
    true,
  );
  assert.equal(
    prCreatedOnOrBefore("2026-09-02T00:00:00Z", "2026-09-01"),
    false,
  );
  assert.equal(prCreatedOnOrBefore("2026-09-02T00:00:00Z", null), true);
});

test("requires an in-filter change but includes credited defect files outside it", () => {
  const changedFiles = [
    "sources/dev/Management/src/ServiceHost/Worker.cs",
    "sources/dev/data/src/directory/DirectoryResultsHelper.cs",
  ];
  assert.deepEqual(
    reviewableChangedFilePaths(
      changedFiles,
      ["sources/dev/data/src/directory/DirectoryResultsHelper.cs"],
      ["sources/dev/Management/src/ServiceHost"],
    ),
    changedFiles,
  );
  assert.deepEqual(
    reviewableChangedFilePaths(
      ["sources/dev/data/src/directory/DirectoryResultsHelper.cs"],
      ["sources/dev/data/src/directory/DirectoryResultsHelper.cs"],
      ["sources/dev/Management/src/ServiceHost"],
    ),
    [],
  );
});
