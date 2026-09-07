import fs from "node:fs/promises";
import path from "node:path";
import { runCopilotGroundTruthNormalization } from "@/lib/copilot";
import { DATA_DIR } from "@/lib/paths";
import type { HumanFinding, RepositoryRecord } from "@/lib/types";

export async function normalizeHumanFindings(options: {
  repository: RepositoryRecord;
  prNumber: number;
  prMetadata: unknown;
  diff: string;
  findings: HumanFinding[];
}) {
  const credited = options.findings.filter(
    (finding) =>
      (finding.scorePoint ?? 1) === 1 &&
      !finding.normalizedBody?.trim(),
  );
  if (credited.length === 0) return options.findings;
  const workspace = path.join(
    DATA_DIR,
    "ground-truth-analysis",
    `repository-${options.repository.id}`,
    `pr-${options.prNumber}`,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await fs.mkdir(workspace, { recursive: true });
  const commentsPath = path.join(workspace, "human-comments.json");
  const writeComments = (comments: HumanFinding[]) =>
    fs.writeFile(
      commentsPath,
      JSON.stringify(
        comments.map((finding) => ({
          id: finding.id,
          originalComment: finding.body,
          path: finding.path,
          line: finding.line ?? finding.originalLine,
        })),
        null,
        2,
      ),
    );
  await Promise.all([
    fs.writeFile(
      path.join(workspace, "pr.json"),
      JSON.stringify(options.prMetadata, null, 2),
    ),
    fs.writeFile(path.join(workspace, "diff.patch"), options.diff),
    writeComments(credited),
  ]);
  const normalizedById = new Map<string, string>();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const missing = credited.filter(
      (finding) => !normalizedById.has(finding.id),
    );
    if (missing.length === 0) break;
    if (attempt > 1) await writeComments(missing);
    const result = await runCopilotGroundTruthNormalization({
      workspace,
      model: options.repository.model,
      contextTier: options.repository.context_tier,
      usagePath: path.join(
        workspace,
        `normalization-usage-${attempt}.json`,
      ),
    });
    for (const defect of result.output) {
      normalizedById.set(defect.id, defect.normalizedBody);
    }
  }
  for (const finding of credited) {
    if (!normalizedById.has(finding.id)) {
      normalizedById.set(
        finding.id,
        finding.normalizedBody?.trim() || finding.body.trim(),
      );
    }
  }
  return options.findings.map((finding) => ({
    ...finding,
    normalizedBody:
      normalizedById.get(finding.id) ?? finding.normalizedBody,
  }));
}
