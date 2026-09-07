import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applySkillMitigationEdits } from "@/lib/skill-analysis";

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
          replacement: "Review carefully and trace feature flags.",
          rationale: "Add a reusable review check.",
          targetKind: "orchestration",
          implementationPath: ["SKILL.md"],
        },
      ],
      backup,
    );
    assert.equal(
      await fs.readFile(path.join(root, "SKILL.md"), "utf8"),
      "Review carefully and trace feature flags.\n",
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

test("rejects ambiguous and escaping skill edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-analysis-"));
  const backup = path.join(root, "backup");
  try {
    await fs.writeFile(path.join(root, "SKILL.md"), "repeat repeat");
    await assert.rejects(
      applySkillMitigationEdits(
        root,
        [
          {
            file: "SKILL.md",
            search: "repeat",
            replacement: "changed",
            rationale: "",
            targetKind: "orchestration",
            implementationPath: ["SKILL.md"],
          },
        ],
        backup,
      ),
      /Apply stopped: .* changed after this analysis/,
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
