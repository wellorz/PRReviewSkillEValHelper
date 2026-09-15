import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySkillMitigationEdits,
  keepImplementationGroundedEdits,
  mapSkillMitigationEditsToConfiguredRoot,
  selectMissedReviewSnapshots,
  shouldBuildKnowledgeGraph,
} from "@/lib/skill-analysis";
import type {
  HumanFinding,
  SkillAnalysisOutput,
  SkillMitigationEdit,
} from "@/lib/types";

function finding(id: string): HumanFinding {
  return {
    id,
    source: "review_comment",
    author: "reviewer",
    authorAssociation: "MEMBER",
    body: id,
    path: "src/file.ts",
    line: 1,
    originalLine: null,
    url: "https://example.test",
    createdAt: "2026-09-01T00:00:00Z",
    valueScore: 10,
    valueReasons: [],
    scorePoint: 1,
  };
}

test("builds knowledge only for opted-in unsupported or ambiguous findings", () => {
  assert.equal(shouldBuildKnowledgeGraph(false, "unsupported"), false);
  assert.equal(shouldBuildKnowledgeGraph(true, "supported"), false);
  assert.equal(shouldBuildKnowledgeGraph(true, "unsupported"), true);
  assert.equal(shouldBuildKnowledgeGraph(true, "ambiguous"), true);
});

test("selects the iteration that owns a missed finding instead of the final iteration", () => {
  const iterationFinding = finding("iteration-8-finding");
  const selected = selectMissedReviewSnapshots(
    [
      {
        key: "iteration-8",
        iterationId: 8,
        sourceCommit: "source-8",
        targetCommit: "target",
        isFinal: false,
        relativePath: "iterations/iteration-8",
        findingIds: [iterationFinding.id],
        datasetPath: "iteration-8",
        truth: [iterationFinding],
      },
      {
        key: "iteration-10",
        iterationId: 10,
        sourceCommit: "source-10",
        targetCommit: "target",
        isFinal: true,
        relativePath: "iterations/iteration-10",
        findingIds: [],
        datasetPath: "iteration-10",
        truth: [],
      },
    ],
    [iterationFinding],
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].iterationId, 8);
  assert.equal(selected[0].sourceCommit, "source-8");
});

test("keeps every relevant snapshot when findings span iterations", () => {
  const first = finding("first");
  const second = finding("second");
  const selected = selectMissedReviewSnapshots(
    [
      {
        key: "iteration-2",
        iterationId: 2,
        sourceCommit: "source-2",
        targetCommit: "target",
        isFinal: false,
        relativePath: "iterations/iteration-2",
        findingIds: [first.id],
        datasetPath: "iteration-2",
        truth: [first],
      },
      {
        key: "iteration-4",
        iterationId: 4,
        sourceCommit: "source-4",
        targetCommit: "target",
        isFinal: true,
        relativePath: "iterations/iteration-4",
        findingIds: [second.id],
        datasetPath: "iteration-4",
        truth: [second],
      },
    ],
    [first, second],
  );
  assert.deepEqual(
    selected.map((snapshot) => snapshot.iterationId),
    [2, 4],
  );
});

test("applies exact skill edits and creates a backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "..", `${path.basename(root)}-backup`);
  try {
    await fs.writeFile(path.join(root, "SKILL.md"), "Review carefully.\n");
    await applySkillMitigationEdits(
      root,
      [
        {
          file: "SKILL.md",
          search: "Review carefully.",
          replacement: "Review carefully.\nTrace feature flags.",
          rationale: "Add a reusable review check.",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
      backup,
    );
    assert.equal(
      await fs.readFile(path.join(root, "SKILL.md"), "utf8"),
      "Review carefully.\nTrace feature flags.\n",
    );
    assert.equal(
      await fs.readFile(path.join(backup, "SKILL.md"), "utf8"),
      "Review carefully.\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
  }
});

test("merges an additive mitigation when the original anchor changed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "..", `${path.basename(root)}-backup`);
  try {
    await fs.writeFile(
      path.join(root, "SKILL.md"),
      "Review carefully and preserve another author's update.\n",
    );
    await applySkillMitigationEdits(
      root,
      [
        {
          file: "SKILL.md",
          search: "Review carefully.",
          replacement:
            "Review carefully.\nTrace encoded values through every comparison branch.",
          rationale: "Add a reusable representation check.",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
      backup,
    );
    assert.equal(
      await fs.readFile(path.join(root, "SKILL.md"), "utf8"),
      "Review carefully and preserve another author's update.\n\n" +
        "Trace encoded values through every comparison branch.\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
  }
});

test("does not append a mitigation that is already present", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "..", `${path.basename(root)}-backup`);
  try {
    await fs.writeFile(
      path.join(root, "SKILL.md"),
      "Changed introduction.\n\nTrace encoded values through every comparison branch.\n",
    );
    await applySkillMitigationEdits(
      root,
      [
        {
          file: "SKILL.md",
          search: "Review carefully.",
          replacement:
            "Review carefully.\nTrace encoded values through every comparison branch.",
          rationale: "Add a reusable representation check.",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
      backup,
    );
    assert.equal(
      await fs.readFile(path.join(root, "SKILL.md"), "utf8"),
      "Changed introduction.\n\nTrace encoded values through every comparison branch.\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
  }
});

test("rejects proposals that replace or remove existing text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "..", `${path.basename(root)}-backup`);
  try {
    await fs.writeFile(path.join(root, "SKILL.md"), "Review carefully.\n");
    await assert.rejects(
      applySkillMitigationEdits(
        root,
        [
          {
            file: "SKILL.md",
            search: "Review carefully.",
            replacement: "Use a different review process.",
            rationale: "Unsafe rewrite.",
            targetKind: "orchestration",
            implementationPath: ["SKILL.md"],
          },
        ],
        backup,
      ),
      /only permits append-only mitigations/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
  }
});

test("maps staged Copilot paths back to a directly configured skill", () => {
  const proposal = [
    {
      file: ".github/skills/wz-review/Reviewers/Grok/Architect.md",
      search: "old",
      replacement: "new",
      rationale: "Update reviewer guidance.",
      targetKind: "reviewer" as const,
      implementationPath: [
        ".github/skills/wz-review/SKILL.md",
        ".github/skills/wz-review/Reviewers/Grok/Architect.md",
      ],
    },
  ];
  const direct = mapSkillMitigationEditsToConfiguredRoot(
    "Q:\\src\\PRReviewSkill\\skills\\wz-review",
    "skill",
    proposal,
  );
  assert.equal(direct[0].file, "Reviewers/Grok/Architect.md");
  assert.deepEqual(direct[0].implementationPath, [
    "SKILL.md",
    "Reviewers/Grok/Architect.md",
  ]);
  assert.deepEqual(
    mapSkillMitigationEditsToConfiguredRoot(
      "Q:\\src\\repository",
      "repository",
      proposal,
    ),
    proposal,
  );
});

test("grounds direct edit paths against a staged repository skill layout", () => {
  const edit: SkillMitigationEdit = {
    file: "Reviewers/Sol/Peer.md",
    search: "existing",
    replacement: "existing\nadded",
    rationale: "Add guidance.",
    targetKind: "reviewer",
    implementationPath: [
      "SKILL.md",
      "Reviewers/Sol/Peer.md",
      "Reviewers/Sol/Peer.md",
    ],
  };
  const output: SkillAnalysisOutput = {
    summary: "summary",
    commentAssessmentStatus: "supported",
    changeAndCommentAssessment: "The comment is supported by the change.",
    assessmentEvidence: ["The changed helper broadens the classifier."],
    escalation: "",
    reviewAspect: "compatibility",
    prevention: "Compare old and new classifier contracts.",
    skillGap: "The responsible reviewer lacks contract-comparison guidance.",
    whyMissed: "reason",
    mitigation: "mitigation",
    edits: [edit],
  };
  const grounded = keepImplementationGroundedEdits(output, [
    ".github/skills/wz-review/SKILL.md",
    ".github/skills/wz-review/Reviewers/Sol/Peer.md",
  ]);

  assert.equal(grounded.edits.length, 1);
  assert.equal(
    grounded.edits[0]?.file,
    ".github/skills/wz-review/Reviewers/Sol/Peer.md",
  );
  assert.deepEqual(grounded.edits[0]?.implementationPath, [
    ".github/skills/wz-review/SKILL.md",
    ".github/skills/wz-review/Reviewers/Sol/Peer.md",
    ".github/skills/wz-review/Reviewers/Sol/Peer.md",
  ]);
});

test("does not treat generated code-reading graphs as mitigation targets", () => {
  const graph =
    ".github/skills/wz-review/Reviewers/CodeReading/Project/Symbol/knowledge-graph.html";
  const output: SkillAnalysisOutput = {
    summary: "summary",
    commentAssessmentStatus: "supported",
    changeAndCommentAssessment: "Supported after code reading.",
    assessmentEvidence: ["The historical implementation confirms the issue."],
    escalation: "",
    reviewAspect: "correctness",
    prevention: "Preserve the contract.",
    skillGap: "The reviewer needs contract guidance.",
    whyMissed: "The graph did not exist.",
    mitigation: "Update ordinary reviewer guidance.",
    edits: [
      {
        file: graph,
        search: "old",
        replacement: "old\nnew",
        rationale: "Do not edit generated evidence.",
        targetKind: "reviewer",
        implementationPath: [graph],
      },
    ],
  };

  assert.deepEqual(keepImplementationGroundedEdits(output, [graph]).edits, []);
});

test("appends safely for ambiguous anchors and rejects escaping edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "backup");
  try {
    await fs.writeFile(path.join(root, "SKILL.md"), "repeat repeat");
    await applySkillMitigationEdits(
      root,
      [
        {
          file: "SKILL.md",
          search: "repeat",
          replacement: "repeat additional guidance",
          rationale: "",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
      backup,
    );
    assert.equal(
      await fs.readFile(path.join(root, "SKILL.md"), "utf8"),
      "repeat repeat\n\nadditional guidance\n",
    );
    await assert.rejects(
      applySkillMitigationEdits(
        root,
        [
          {
            file: "..\\outside.md",
            search: "x",
            replacement: "y",
            rationale: "",
            targetKind: "other",
            implementationPath: ["outside.md"],
          },
        ],
        backup,
      ),
      /Unsafe skill edit path/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
