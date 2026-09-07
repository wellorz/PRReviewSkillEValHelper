import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { restoreLegacyCappedCredits } from "@/lib/ground-truth";
import type { HumanFinding, ReviewSnapshotManifest } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  defects: z
    .array(
      z.object({
        id: z.string().min(1),
        normalizedBody: z.string().trim().min(1).max(10_000),
      }),
    )
    .min(1),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid defect update" },
      { status: 400 },
    );
  }
  const db = getDb();
  const pr = db
    .prepare(`
      SELECT id, dataset_path, defect_description
      FROM pull_requests
      WHERE id = ? AND active = 1
    `)
    .get(id) as
    | {
        id: number;
        dataset_path: string;
        defect_description: string | null;
      }
    | undefined;
  if (!pr) {
    return NextResponse.json({ error: "PR not found" }, { status: 404 });
  }
  const manualId = `manual-defect-${pr.id}`;
  const requested = new Map(
    parsed.data.defects.map((defect) => [defect.id, defect.normalizedBody]),
  );
  const findingsPath = path.join(pr.dataset_path, "human-findings.json");
  let findings: HumanFinding[] = [];
  try {
    findings = JSON.parse(await fs.readFile(findingsPath, "utf8")) as HumanFinding[];
  } catch {
    findings = [];
  }
  findings = restoreLegacyCappedCredits(findings);
  const knownIds = new Set(findings.map((finding) => finding.id));
  knownIds.add(manualId);
  const unknown = [...requested.keys()].filter((defectId) => !knownIds.has(defectId));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown defect: ${unknown[0]}` },
      { status: 400 },
    );
  }
  const updatedFindings = findings.map((finding) => {
    const normalizedBody = requested.get(finding.id);
    return normalizedBody ? { ...finding, normalizedBody } : finding;
  });
  const manualDescription = requested.get(manualId);
  const writes: Array<{ target: string; findings: HumanFinding[] }> = [];
  if (findings.length > 0) {
    writes.push({ target: findingsPath, findings: updatedFindings });
  }
  try {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(pr.dataset_path, "review-snapshots.json"),
        "utf8",
      ),
    ) as ReviewSnapshotManifest;
    for (const snapshot of manifest.snapshots) {
      const target = path.resolve(
        pr.dataset_path,
        snapshot.relativePath,
        "human-findings.json",
      );
      const snapshotFindings = restoreLegacyCappedCredits(
        JSON.parse(await fs.readFile(target, "utf8")) as HumanFinding[],
      );
      const updated = snapshotFindings.map((finding) => {
        const normalizedBody = requested.get(finding.id);
        return normalizedBody ? { ...finding, normalizedBody } : finding;
      });
      writes.push({ target, findings: updated });
    }
  } catch {
    // Legacy snapshots have only the aggregate human-findings.json file.
  }
  for (const write of writes) {
    const temporaryPath = `${write.target}.tmp`;
    await fs.writeFile(
      temporaryPath,
      JSON.stringify(write.findings, null, 2),
    );
    await fs.rename(temporaryPath, write.target);
  }
  const transaction = db.transaction(() => {
    if (manualDescription !== undefined) {
      db.prepare(
        "UPDATE pull_requests SET defect_description = ? WHERE id = ?",
      ).run(manualDescription, pr.id);
    }
    const creditedHumanFindings = updatedFindings.filter(
      (finding) =>
        (finding.scorePoint ?? 1) === 1 &&
        (!finding.id.startsWith("azure-thread-") ||
          finding.valueReasons.includes("pr-owner-confirmed")),
    ).length;
    const effectiveManualDescription =
      manualDescription ?? pr.defect_description;
    db.prepare(`
      UPDATE pull_requests SET
        valued_comment_count = ?,
        baseline_metrics_json = NULL,
        skill_metrics_json = NULL
      WHERE id = ?
    `).run(
      creditedHumanFindings + (effectiveManualDescription ? 1 : 0),
      pr.id,
    );
    db.prepare(`
      UPDATE baseline_profile_results SET
        metrics_json = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE pull_request_id = ?
    `).run(pr.id);
    db.prepare(`
      UPDATE personal_skill_results SET
        metrics_json = NULL,
        report_path = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE pull_request_id = ?
    `).run(pr.id);
  });
  transaction();
  return NextResponse.json({ ok: true });
}
