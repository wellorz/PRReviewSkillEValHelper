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
const documentedCommands = [
  "npm test",
  "npx next typegen",
  "npx tsc --noEmit",
  "npm run validate:repository",
  "npm run validate:docs",
  "npm run validate:workflows",
  "npm run lint",
  "npm run build",
];
const specification = read("specs/v1/review-training-contract.md");
for (const command of documentedCommands) {
  assert.ok(specification.includes(command), `Specification omits ${command}`);
}

for (const script of [
  "test",
  "lint",
  "build",
  "validate:repository",
  "validate:docs",
  "validate:workflows",
]) {
  assert.ok(packageJson.scripts?.[script], `Documented package script is missing: ${script}`);
}

const policy = parse(read(".github/agent-review.yml")) as {
  training?: { maximumRetriesPerPullRequest?: number };
  safety?: { localOnlyReviews?: boolean };
};
assert.equal(policy.training?.maximumRetriesPerPullRequest, 5);
assert.equal(policy.safety?.localOnlyReviews, true);

const selfHealing = parse(read(".github/self-healing.yml")) as {
  qualityFailure?: {
    maximumAutomaticReruns?: number;
    workflow?: string;
    exhaustedAction?: string;
  };
  safety?: {
    automaticCodeMutation?: boolean;
    automaticMerge?: boolean;
  };
};
assert.equal(selfHealing.qualityFailure?.maximumAutomaticReruns, 1);
assert.equal(
  selfHealing.qualityFailure?.workflow,
  ".github/workflows/quality-recovery.yml",
);
assert.equal(selfHealing.qualityFailure?.exhaustedAction, "require-human-review");
assert.equal(selfHealing.safety?.automaticCodeMutation, false);
assert.equal(selfHealing.safety?.automaticMerge, false);

for (const relativePath of [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/operations.md",
  "docs/threat-model.md",
  "specs/v1/review-training-contract.md",
]) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `Missing documented file: ${relativePath}`);
}

console.log("Documentation matches the repository operating contract.");
