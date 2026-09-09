import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  localOnlyCopilotPermissionArgs,
  localOnlySandboxSettings,
  nativeWzReviewPrompt,
  nativeReviewerModels,
  parseNativeWzReviewResult,
  parseReviewOutput,
  reviewPrompt,
  validateSkillPath,
} from "@/lib/copilot";

test("builds native wzReview prompts for commit and diff-only modes", () => {
  assert.equal(
    nativeWzReviewPrompt({
      repositoryRoot: "Q:\\repo",
      outputFolder: "Q:\\output",
      sourceCommit: "source",
      targetCommit: "target",
    }),
    '/wz-review source "Q:\\output" --base target',
  );
  assert.equal(
    nativeWzReviewPrompt({
      repositoryRoot: "Q:\\snapshot with spaces",
      outputFolder: "Q:\\output with spaces",
      diffOnly: true,
    }),
    '/wz-review "Q:\\snapshot with spaces" "Q:\\output with spaces" --diff-only',
  );
});

test("keeps baseline and personal-skill reviews permanently local", () => {
  const baselinePrompt = reviewPrompt();
  const skillPrompt = reviewPrompt("wz-review");
  for (const prompt of [baselinePrompt, skillPrompt]) {
    assert.match(prompt, /permanently local-only/);
    assert.match(prompt, /Never create, update, delete, resolve, approve/);
    assert.match(prompt, /--allowpublish/);
    assert.match(prompt, /--autopublish-active/);
    assert.match(prompt, /--publish-existing/);
  }

  const nativePrompt = nativeWzReviewPrompt({
    repositoryRoot: "Q:\\repo",
    outputFolder: "Q:\\output",
    sourceCommit: "source",
    targetCommit: "target",
  });
  assert.doesNotMatch(
    nativePrompt,
    /--allowpublish|--autopublish-active|--publish-existing/,
  );
});

test("blocks review subprocess network access and credential injection", () => {
  const args = localOnlyCopilotPermissionArgs(["bluebird-os", "substratemcp"]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--deny-url=*"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--no-remote"));
  assert.deepEqual(
    args.filter(
      (arg, index) =>
        arg === "--disable-mcp-server" ||
        args[index - 1] === "--disable-mcp-server",
    ),
    [
      "--disable-mcp-server",
      "bluebird-os",
      "--disable-mcp-server",
      "substratemcp",
    ],
  );
  assert.ok(
    args.some(
      (arg) =>
        arg.startsWith("--secret-env-vars=") &&
        arg.includes("AZURE_DEVOPS_EXT_PAT") &&
        arg.includes("GH_TOKEN"),
    ),
  );

  const settings = localOnlySandboxSettings({
    writablePaths: ["Q:\\output"],
    readonlyPaths: ["Q:\\repo", "Q:\\skill"],
  });
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowBypass, false);
  assert.equal(settings.sandbox.auth.git, false);
  assert.equal(settings.sandbox.auth.gh, false);
  assert.equal(settings.sandbox.userPolicy.network.allowOutbound, false);
  assert.equal(settings.sandbox.userPolicy.network.allowLocalNetwork, false);
  assert.deepEqual(settings.sandbox.userPolicy.filesystem.readwritePaths, [
    path.resolve("Q:\\output"),
  ]);
});

test("repairs unquoted code and punctuation in native wzReview YAML", () => {
  const parsed = parseNativeWzReviewResult(`
reviewSummary:
  totalFindings: 1
findings:
  - id: exception-message
    finding: QueryFlip telemetry strips exception messages.
    evidence: \`ex.ToStringWithoutMessage()\` replaces \`ex.ToString()\` while IncludeExceptionMessages remains enabled.
    suggestion: Preserve the configured behavior: include the message when requested.
rejectedCandidates:
  - id: sentinel
    reason: The value is intentional: it represents "not resolved".
`);
  const findings = parsed.findings as Array<Record<string, unknown>>;
  const rejected = parsed.rejectedCandidates as Array<Record<string, unknown>>;
  assert.equal(
    findings[0].evidence,
    "`ex.ToStringWithoutMessage()` replaces `ex.ToString()` while IncludeExceptionMessages remains enabled.",
  );
  assert.equal(
    findings[0].suggestion,
    "Preserve the configured behavior: include the message when requested.",
  );
  assert.equal(
    rejected[0].reason,
    'The value is intentional: it represents "not resolved".',
  );
});

test("maps wzReview cross-model agreement to finding provenance", () => {
  assert.deepEqual(
    nativeReviewerModels({
      title: "Issue",
      description: "Description",
      severity: "high",
      file: "file.cs",
      lineStart: 1,
      lineEnd: 1,
      category: "correctness",
      confidence: 0.9,
      evidence: "Evidence",
      agreedBy: ["Grok-4.6", "GPT-5.6-Sol"],
    }),
    ["grok-4.6", "gpt-5.6-sol"],
  );
});

test("repairs unescaped control characters inside model JSON strings", () => {
  const raw =
    '{"summary":"line one\nline two","findings":[{"title":"Issue","description":"first line\nsecond line","severity":"high","file":"a.cs","lineStart":1,"lineEnd":1,"category":"correctness","confidence":0.9,"evidence":"x"}]}';
  const parsed = parseReviewOutput(raw);
  assert.equal(parsed.summary, "line one\nline two");
  assert.equal(parsed.findings[0]?.description, "first line\nsecond line");
});

test("repairs missing commas in model JSON", () => {
  const output = parseReviewOutput(`{
    "summary": "review"
    "findings": []
  }`);
  assert.equal(output.summary, "review");
  assert.deepEqual(output.findings, []);
});

test("repairs unescaped code quotes inside model JSON strings", () => {
  const output = parseReviewOutput(`{
    "summary": "review",
    "findings": [{
      "title": "Escaped DN",
      "description": "The implementation checks dn.Contains("\\\\0ACNF:") instead of the expected value.",
      "severity": "medium",
      "file": "src/file.cs",
      "lineStart": 10,
      "lineEnd": 10,
      "category": "correctness",
      "confidence": 0.9,
      "evidence": "It also checks dn.Contains("\\nCNF:")."
    }]
  }`);
  assert.equal(output.findings.length, 1);
  assert.match(output.findings[0].description, /dn\.Contains/);
});

test("repairs unescaped JSON property examples inside model descriptions", () => {
  const output = parseReviewOutput(`{
    "summary": "review",
    "findings": [{
      "title": "Null values bypass validation",
      "description": "An explicit JSON null such as "skuId":null or "status":null is consumed as data.",
      "severity": "high",
      "file": "src/file.cs",
      "lineStart": 10,
      "lineEnd": 12,
      "category": "correctness",
      "confidence": 0.98,
      "evidence": "The parser accepts "value":null without checking the response status."
    }]
  }`);
  assert.equal(output.findings.length, 1);
  assert.match(output.findings[0].description, /"skuId":null/);
  assert.match(output.findings[0].evidence, /"value":null/);
});

test("repairs embedded JSON objects and quoted values in evidence", () => {
  const output = parseReviewOutput(`{
    "summary": "review",
    "findings": [{
      "title": "Malformed configuration",
      "description": "The override maps the meter directly to "Enabled", plus a sibling exporter section.",
      "severity": "high",
      "file": "src/settings.ini",
      "lineStart": 176,
      "lineEnd": 176,
      "category": "reliability",
      "confidence": 0.98,
      "evidence": "The added value is {"SubstrateMetering":{"R9Metering":{"MeterStateOverrides":{"Meter":{"MeterState":"Enabled"}}}}}; existing configurations map the value directly to "Enabled"."
    }]
  }`);
  assert.equal(output.findings.length, 1);
  assert.match(output.findings[0].description, /"Enabled"/);
  assert.match(output.findings[0].evidence, /"SubstrateMetering"/);
});

test("repairs quoted code followed by prose punctuation", () => {
  const output = parseReviewOutput(`{
    "summary": "review",
    "findings": [{
      "title": "Escaped DN",
      "description": "Wrong DN handling.",
      "severity": "medium",
      "file": "src/file.cs",
      "lineStart": 10,
      "lineEnd": 10,
      "category": "correctness",
      "confidence": 0.9,
      "evidence": "It checks DistinguishedName for "\\\\0ACNF:", confirming the escaped form."
    }]
  }`);
  assert.match(output.findings[0].evidence, /confirming/);
});

test("validates direct skills and repository skill roots", async () => {
  const root = path.join(
    process.cwd(),
    "runtime",
    `skill-validation-${process.pid}`,
  );
  const direct = path.join(root, "direct");
  const repository = path.join(root, "repository");
  try {
    await fs.mkdir(direct, { recursive: true });
    await fs.writeFile(path.join(direct, "SKILL.md"), "# Test");
    await fs.mkdir(path.join(repository, ".github", "skills"), {
      recursive: true,
    });
    assert.equal((await validateSkillPath(direct)).kind, "skill");
    assert.deepEqual(await validateSkillPath(path.join(direct, "SKILL.md")), {
      resolved: direct,
      kind: "skill",
    });
    assert.equal((await validateSkillPath(repository)).kind, "repository");
    await assert.rejects(
      validateSkillPath(path.join(root, "missing")),
      /must be a SKILL\.md file/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("repairs hard-wrapped keys, paths, and numeric fields", () => {
  const output = parseReviewOutput(`{"summary":"review","findings":[{
    "title":"Missing projection",
    "description":"The required projection was removed.",
    "severity":"high",
    "file":"sources/dev/Serv
iceHost/PolicyHandler.cs",
    "lineStart":11
2,
    "lineEnd":11
8,
    "categor
y":"security",
    "confidence":0.
92,
    "evidence":"The evaluator consumes the missing field."
  }]}`);
  assert.equal(output.findings[0].file, "sources/dev/ServiceHost/PolicyHandler.cs");
  assert.equal(output.findings[0].lineStart, 112);
  assert.equal(output.findings[0].lineEnd, 118);
  assert.equal(output.findings[0].category, "security");
  assert.equal(output.findings[0].confidence, 0.92);
});

test("repairs quoted evidence followed by prose arguments", () => {
  const output = parseReviewOutput(`{
    "summary":"review",
    "findings":[{
      "title":"Severity regression",
      "description":"A warning became informational.",
      "severity":"medium",
      "file":"TenantHelper.cs",
      "lineStart":180,
      "lineEnd":180,
      "category":"reliability",
      "confidence":0.91,
      "evidence":"The diff removes "StuckTenantRemediation: re-attempting upgrade", null)."
    }]
  }`);
  assert.equal(output.findings.length, 1);
  assert.match(output.findings[0].evidence, /StuckTenantRemediation/);
});

test("uses the last complete review when output contains draft JSON", () => {
  const output = parseReviewOutput(
    `{"summary":"Review in progress.","findings":[]}

{"summary":"Review in progress.","findings":[]}

{"summary":"Final review.","findings":[{
  "title":"Final issue",
  "description":"The completed inference found this issue.",
  "severity":"high",
  "file":"file.cs",
  "lineStart":10,
  "lineEnd":10,
  "category":"correctness",
  "confidence":0.9,
  "evidence":"Final evidence."
}]}`,
  );
  assert.equal(output.summary, "Final review.");
  assert.equal(output.findings.length, 1);
});
