import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const packageJson = JSON.parse(read("package.json")) as {
  scripts?: Record<string, string>;
};
for (const script of ["dev:all", "test", "lint", "build"]) {
  assert.ok(packageJson.scripts?.[script], `Missing package script: ${script}`);
}

const policy = parse(read(".github/agent-review.yml")) as {
  review?: { requiredCommands?: string[] };
  safety?: {
    localOnlyReviews?: boolean;
    humanFindingsModelVisible?: boolean;
    prohibitedPublicationFlags?: string[];
  };
  training?: {
    maximumRetriesPerPullRequest?: number;
    unavailableModelPolicy?: string;
    cancellationRequired?: boolean;
  };
};

assert.deepEqual(policy.review?.requiredCommands, [
  "npm test",
  "npx tsc --noEmit",
  "npm run lint",
  "npm run build",
]);
assert.equal(policy.safety?.localOnlyReviews, true);
assert.equal(policy.safety?.humanFindingsModelVisible, false);
assert.deepEqual(policy.safety?.prohibitedPublicationFlags, [
  "--allowpublish",
  "--autopublish-active",
  "--publish-existing",
]);
assert.equal(policy.training?.maximumRetriesPerPullRequest, 5);
assert.equal(policy.training?.unavailableModelPolicy, "retry-same-model");
assert.equal(policy.training?.cancellationRequired, true);

const copilotSource = read("src/lib/copilot.ts");
for (const flag of policy.safety?.prohibitedPublicationFlags ?? []) {
  assert.ok(
    copilotSource.includes(flag),
    `Copilot execution boundary does not prohibit ${flag}`,
  );
}
for (const delay of ["15_000", "30_000", "60_000", "120_000", "240_000"]) {
  assert.ok(
    copilotSource.includes(delay),
    `Copilot same-model recovery delay is missing: ${delay}`,
  );
}

const databaseSource = read("src/lib/db.ts");
assert.match(
  databaseSource,
  /max_iterations INTEGER NOT NULL DEFAULT 5/,
  "Training retry limit no longer matches the agent-review contract",
);

const trainingSource = read("src/lib/skill-training.ts");
assert.ok(
  trainingSource.includes("iteration <= job.max_iterations"),
  "Training no longer enforces the persisted retry limit",
);

const requiredFiles = [
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/quality.yml",
  ".github/workflows/quality-report.yml",
  ".github/workflows/codeql.yml",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/operations.md",
];
for (const relativePath of requiredFiles) {
  assert.ok(
    fs.existsSync(path.join(root, relativePath)),
    `Missing repository contract file: ${relativePath}`,
  );
}

console.log("Repository operating contract is valid.");
