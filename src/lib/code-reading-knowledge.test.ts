import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renderCodeReadingKnowledgeHtml,
  safeKnowledgeSegment,
  writeCodeReadingKnowledge,
} from "@/lib/code-reading-knowledge";
import type { CodeReadingKnowledgeOutput } from "@/lib/types";

const output: CodeReadingKnowledgeOutput = {
  summary: "A <summary> with evidence.",
  gapType: "contract & lifecycle",
  symbols: [
    {
      name: 'Finalize<Operation>:"',
      kind: "method",
      sourcePath: "src/Operation.cs",
      purpose: "Finalize <state> safely.",
      usages: ["Called by Manager & Worker."],
      similarSymbols: [],
      inputs: [],
      outputs: [],
      errorBehavior: ["Errors propagate."],
      dependencies: [],
      callFlow: ["Manager -> Finalize"],
      invariants: ["Completion follows persistence."],
      evidence: ["src/Operation.cs:42"],
      uncertainties: [],
    },
  ],
};

test("sanitizes knowledge graph directory segments", () => {
  assert.equal(safeKnowledgeSegment(' Project<>:"/\\|?* ', "fallback"), "Project");
  assert.equal(safeKnowledgeSegment("...", "fallback"), "fallback");
});

test("renders escaped deterministic knowledge graph HTML", () => {
  const options = {
    projectName: "Project & Service",
    repositoryCommit: "abc123",
    generatedAt: "2026-09-15T00:00:00.000Z",
    gapType: output.gapType,
    summary: output.summary,
    symbol: output.symbols[0],
  };
  const first = renderCodeReadingKnowledgeHtml(options);
  const second = renderCodeReadingKnowledgeHtml(options);
  assert.equal(first, second);
  assert.match(first, /Project &amp; Service/);
  assert.match(first, /Finalize&lt;Operation&gt;:&quot;/);
  assert.doesNotMatch(first, /<summary>/);
});

test("writes nested graphs and backs up refreshed content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-graph-"));
  const skillRoot = path.join(root, "skill");
  const backupRoot = path.join(root, "backup");
  try {
    const files = await writeCodeReadingKnowledge({
      skillRoot,
      backupRoot,
      projectName: "Project/Service",
      repositoryCommit: "first",
      generatedAt: "2026-09-15T00:00:00.000Z",
      output,
    });
    assert.deepEqual(files, [
      "Reviewers/CodeReading/Project-Service/Finalize-Operation/knowledge-graph.html",
    ]);
    const target = path.join(skillRoot, ...files[0].split("/"));
    const first = await fs.readFile(target, "utf8");
    await writeCodeReadingKnowledge({
      skillRoot,
      backupRoot,
      projectName: "Project/Service",
      repositoryCommit: "second",
      generatedAt: "2026-09-15T01:00:00.000Z",
      output,
    });
    const backup = path.join(backupRoot, ...files[0].split("/"));
    assert.equal(await fs.readFile(backup, "utf8"), first);
    assert.match(await fs.readFile(target, "utf8"), /second/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
