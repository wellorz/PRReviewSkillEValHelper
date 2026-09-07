import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRepositorySource,
  pathMatchesFilters,
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
