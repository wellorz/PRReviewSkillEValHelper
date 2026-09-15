import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  localOnlyCopilotPermissionArgs,
  localOnlySandboxSettings,
  isUnavailableModelError,
  nativeWzReviewArtifactError,
  nativeWzReviewPrompt,
  nativeReviewerModels,
  parseCodeReadingKnowledgeOutput,
  parseSkillAnalysisOutput,
  parseNativeWzReviewResult,
  parseReviewOutput,
  prepareSkillRoot,
  reviewPrompt,
  validateSkillPath,
} from "@/lib/copilot";
import {
  DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION,
  personalSkillTriggerInstruction,
  validatePersonalSkillTriggerInstruction,
} from "@/lib/personal-skill-trigger";

test("classifies only explicit unavailable-model failures as recoverable", () => {
  assert.equal(
    isUnavailableModelError(
      'Error: Model "gpt-5.4" from --model flag is not available.',
    ),
    true,
  );
  assert.equal(isUnavailableModelError("Copilot invocation timed out"), false);
});

test("parses and bounds repository-backed code-reading knowledge", () => {
  const output = parseCodeReadingKnowledgeOutput(
    JSON.stringify({
      summary: "The callback controls durable state.",
      gapType: "lifecycle and ownership",
      symbols: [
        {
          name: "CompleteOperation",
          kind: "method",
          sourcePath: "src/Operation.cs",
          purpose: "Finalize the operation.",
          usages: ["Called after persistence."],
          similarSymbols: [
            {
              name: "CancelOperation",
              sourcePath: "src/Operation.cs",
              similarities: "Both finish an operation.",
              differences: "Cancellation does not persist success.",
            },
          ],
          inputs: [
            {
              name: "status",
              type: "Status",
              validValues: "Success or Failure",
              invalidBehavior: "Throws.",
            },
          ],
          outputs: [
            {
              name: "result",
              type: "Task",
              expectedValues: "Completed task",
              meaning: "Persistence completed.",
            },
          ],
          errorBehavior: ["Storage failures propagate."],
          dependencies: [
            {
              name: "store",
              kind: "field",
              relationship: "Persists final state.",
            },
          ],
          callFlow: ["Caller -> CompleteOperation -> store"],
          invariants: ["State is persisted before completion is visible."],
          evidence: ["src/Operation.cs:42"],
          uncertainties: [],
        },
      ],
    }),
  );

  assert.equal(output.gapType, "lifecycle and ownership");
  assert.equal(output.symbols[0]?.name, "CompleteOperation");
  assert.equal(output.symbols[0]?.inputs[0]?.validValues, "Success or Failure");
});

test("parses change-first skill mitigation reasoning", () => {
  const output = parseSkillAnalysisOutput(
    JSON.stringify({
      summary: "The review missed a compatibility regression.",
      commentAssessmentStatus: "supported",
      changeAndCommentAssessment:
        "The comment is supported by the changed classifier contract.",
      assessmentEvidence: [
        "The legacy and replacement classifiers accept different DN forms.",
      ],
      escalation: "",
      reviewAspect: "compatibility and correctness",
      prevention:
        "Authors and reviewers should compare old and new classification boundaries.",
      skillGap:
        "The responsible reviewer does not require contract-boundary comparison.",
      whyMissed: "The delegated reviewer checked only the new helper.",
      mitigation: "Require old-versus-new contract analysis.",
      edits: [],
    }),
  );

  assert.equal(
    output.changeAndCommentAssessment,
    "The comment is supported by the changed classifier contract.",
  );
  assert.equal(output.commentAssessmentStatus, "supported");
  assert.equal(output.assessmentEvidence.length, 1);
  assert.equal(output.reviewAspect, "compatibility and correctness");
  assert.match(output.prevention, /Authors and reviewers/);
  assert.match(output.skillGap, /contract-boundary comparison/);
});

test("escalates disputed comments without returning mitigation edits", () => {
  const output = parseSkillAnalysisOutput(
    JSON.stringify({
      summary: "The human claim is not established.",
      commentAssessmentStatus: "unsupported",
      changeAndCommentAssessment:
        "The named path is unchanged and the alleged call is unreachable.",
      assessmentEvidence: [
        "diff.patch does not modify the classifier.",
        "The caller returns before the alleged path.",
      ],
      escalation:
        "A human should verify whether another snapshot contains the claimed change.",
      reviewAspect: "correctness",
      prevention: "Confirm the executable path before filing the defect.",
      skillGap: "No skill gap is established.",
      whyMissed: "The review did not report an unsupported claim.",
      mitigation: "No mitigation should be applied.",
      edits: [
        {
          file: "SKILL.md",
          search: "existing",
          replacement: "existing\nunsafe lesson",
          rationale: "Should be suppressed.",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
    }),
  );

  assert.equal(output.commentAssessmentStatus, "unsupported");
  assert.equal(output.assessmentEvidence.length, 2);
  assert.match(output.escalation, /human should verify/i);
  assert.deepEqual(output.edits, []);
});

test("builds native wzReview prompts for commit and diff-only modes", () => {
  const commitPrompt = nativeWzReviewPrompt({
      repositoryRoot: "Q:\\repo",
      outputFolder: "Q:\\output",
      sourceCommit: "source",
      targetCommit: "target",
    });
  const diffPrompt = nativeWzReviewPrompt({
      repositoryRoot: "Q:\\snapshot with spaces",
      outputFolder: "Q:\\output with spaces",
      diffOnly: true,
    });
  assert.match(commitPrompt, /^\/wz-review source "Q:\\output" --base target/);
  assert.match(
    diffPrompt,
    /^\/wz-review "Q:\\snapshot with spaces" "Q:\\output with spaces" --diff-only/,
  );
  for (const prompt of [commitPrompt, diffPrompt]) {
    assert.match(prompt, /Never launch a background agent/);
    assert.match(prompt, /review-result\.yaml and review\.md both exist/);
    assert.match(prompt, /permanently local-only/);
  }
});

test("reports unsupported Windows sandboxing instead of missing artifacts", () => {
  const message = nativeWzReviewArtifactError(
    {
      stdout:
        "Blocked: Windows sandboxing requires BaseContainer. No review artifacts were created.",
      stderr:
        "Warning: Sandboxing is enabled but is not supported on this host.",
    },
    ["source.yaml", "review-result.yaml"],
  );

  assert.match(message, /requires BaseContainer/);
  assert.match(message, /Sandbox enforcement was not bypassed/);
  assert.doesNotMatch(message, /did not create required artifacts/);
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

  test("uses saved personal-skill trigger instructions", () => {
    const instruction =
      "Prioritize compatibility regressions and verify every changed contract.";
    const prompt = reviewPrompt("contract-review", instruction);
    assert.match(prompt, new RegExp(instruction));
    assert.match(prompt, /loaded skill is named `contract-review`/);
    assert.equal(
      personalSkillTriggerInstruction("  "),
      DEFAULT_PERSONAL_SKILL_TRIGGER_INSTRUCTION,
    );
    assert.equal(
      validatePersonalSkillTriggerInstruction(`  ${instruction}  `),
      instruction,
    );
    assert.throws(
      () =>
        validatePersonalSkillTriggerInstruction(
          "Run the review with --allowpublish",
        ),
      /permanently local-only/,
    );
    assert.throws(
      () =>
        validatePersonalSkillTriggerInstruction(
          'copilot -p "Review this snapshot" --model gpt-5.6-sol',
        ),
      /not the full Copilot command/,
    );
  });

  test("keeps the native command while appending its saved instruction", () => {
    const prompt = nativeWzReviewPrompt({
      repositoryRoot: "Q:\\repo",
      outputFolder: "Q:\\output",
      sourceCommit: "source",
      targetCommit: "target",
      triggerInstruction: "Focus on recovery and durable progress.",
    });
    assert.match(
      prompt,
      /^\/wz-review source "Q:\\output" --base target/,
    );
    assert.match(prompt, /Additional benchmark review instruction/);
    assert.match(prompt, /Focus on recovery and durable progress/);
    assert.match(prompt, /permanently local-only/);
    assert.doesNotMatch(
      prompt.split(/\r?\n/, 1)[0],
      /--allowpublish|--autopublish-active|--publish-existing/,
    );
  });
  assert.doesNotMatch(
    nativePrompt.split(/\r?\n/, 1)[0],
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

test("trusted native wzReview explicitly disables the unsupported sandbox", () => {
  const args = localOnlyCopilotPermissionArgs(["substratemcp"], {
    sandbox: false,
  });
  assert.ok(!args.includes("--sandbox"));
  assert.ok(args.includes("--no-sandbox"));
  assert.ok(args.includes("--experimental"));
  assert.ok(args.includes("--deny-url=*"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--disable-mcp-server"));
  assert.ok(args.includes("substratemcp"));
  assert.ok(args.includes("--no-remote"));
  assert.ok(
    args.some(
      (arg) =>
        arg.startsWith("--secret-env-vars=") &&
        arg.includes("AZURE_DEVOPS_EXT_PAT") &&
        arg.includes("GH_TOKEN"),
    ),
  );
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

test("preserves valid wrapped native wzReview YAML scalars", () => {
  const parsed = parseNativeWzReviewResult(`
reviewSummary:
  totalFindings: 1
findings:
- id: reader-mode-skew
  finding: The reader snapshots its mode at construction, while classifiers
    read the live gate and can observe a different mode.
  evidence: Reader.cs:10-12 captures the mode, while Classifier.cs:20-22
    retrieves the current configuration.
  suggestion: Carry one effective mode through the operation.
`);
  const findings = parsed.findings as Array<Record<string, unknown>>;
  assert.equal(
    findings[0].finding,
    "The reader snapshots its mode at construction, while classifiers read the live gate and can observe a different mode.",
  );
  assert.equal(
    findings[0].evidence,
    "Reader.cs:10-12 captures the mode, while Classifier.cs:20-22 retrieves the current configuration.",
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

    test("prepares an immutable copy of repository-style skills", async () => {
      const root = path.join(
        process.cwd(),
        "runtime",
        `skill-copy-${process.pid}`,
      );
      const repository = path.join(root, "repository");
      const runtime = path.join(root, "runtime");
      const sourceSkill = path.join(
        repository,
        ".github",
        "skills",
        "generated-review",
      );
      try {
        await fs.mkdir(sourceSkill, { recursive: true });
        await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "original");
        const prepared = await prepareSkillRoot(repository, runtime);
        await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "changed");
        assert.equal(
          await fs.readFile(
            path.join(
              prepared,
              ".github",
              "skills",
              "generated-review",
              "SKILL.md",
            ),
            "utf8",
          ),
          "original",
        );
        assert.notEqual(prepared, repository);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
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
