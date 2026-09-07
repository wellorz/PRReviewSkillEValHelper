import fs from "node:fs/promises";
import path from "node:path";
import {
  runCopilotSkillAnalysis,
  validateSkillPath,
} from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { loadGroundTruth } from "@/lib/ground-truth";
import { DATA_DIR } from "@/lib/paths";
import { matchFindings } from "@/lib/scoring";
import type {
  HumanFinding,
  ModelFinding,
  PersonalReviewSkillRecord,
  RepositoryRecord,
  SkillAnalysisOutput,
  SkillMitigationEdit,
} from "@/lib/types";

type SkillAnalysisJob = {
  id: number;
  repository_id: number;
  skill_id: number;
  mode: "analyze" | "analyze_apply";
  model: string;
  model_secondary: string;
  context_tier: string;
  pr_ids_json: string;
};

type AnalysisPr = {
  id: number;
  number: number;
  title: string;
  url: string;
  dataset_path: string;
  defect_description: string | null;
};

function analysisRoot(jobId: number, prNumber: number) {
  return path.join(
    DATA_DIR,
    "skill-analysis",
    `job-${jobId}`,
    `pr-${prNumber}`,
  );
}

function findings(value: string | null): ModelFinding[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelFinding[]) : [];
  } catch {
    return [];
  }
}

function scoredFindings(truth: HumanFinding[]) {
  return truth.filter((finding) => (finding.scorePoint ?? 1) === 1);
}

async function stageSkill(skillPath: string, workspace: string) {
  const validated = await validateSkillPath(skillPath);
  const destination = path.join(workspace, "skill");
  await fs.rm(destination, { recursive: true, force: true });
  if (validated.kind === "skill") {
    await fs.cp(validated.resolved, destination, { recursive: true });
    return;
  }
  await fs.mkdir(path.join(destination, ".github"), { recursive: true });
  await fs.cp(
    path.join(validated.resolved, ".github", "skills"),
    path.join(destination, ".github", "skills"),
    { recursive: true },
  );
}

async function listSkillImplementationFiles(
  root: string,
  current = root,
): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSkillImplementationFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function keepImplementationGroundedEdits(
  output: SkillAnalysisOutput,
  skillFiles: string[],
): SkillAnalysisOutput {
  const available = new Set(skillFiles.map((file) => file.toLowerCase()));
  const edits = output.edits.filter((edit) => {
    const target = edit.file.toLowerCase();
    const route = edit.implementationPath.map((file) => file.toLowerCase());
    if (
      !available.has(target) ||
      route.at(-1) !== target ||
      route.some((file) => !available.has(file))
    ) {
      return false;
    }
    const isSkillEntryPoint = /(^|\/)skill\.md$/i.test(edit.file);
    return !isSkillEntryPoint || edit.targetKind === "orchestration";
  });
  return { ...output, edits };
}

async function analyzePullRequest(
  job: SkillAnalysisJob,
  skill: PersonalReviewSkillRecord,
  pr: AnalysisPr,
) {
  const db = getDb();
  const skillResult = db
    .prepare(`
      SELECT findings_json
      FROM personal_skill_results
      WHERE skill_id = ? AND pull_request_id = ?
        AND model = ? AND model_secondary = ? AND context_tier = ?
        AND status = 'completed'
    `)
    .get(
      skill.id,
      pr.id,
      job.model,
      job.model_secondary,
      job.context_tier,
    ) as { findings_json: string | null } | undefined;
  if (!skillResult) {
    throw new Error("A completed skill review is required before analysis");
  }
  const truth = scoredFindings(await loadGroundTruth(pr));
  const skillFindings = findings(skillResult.findings_json);
  const matchedIds = new Set(
    matchFindings(truth, skillFindings).map((match) => match.humanFindingId),
  );
  const missedFindings = truth.filter((finding) => !matchedIds.has(finding.id));
  const analysisResult = db
    .prepare(`
      SELECT id FROM skill_analysis_results
      WHERE skill_id = ? AND pull_request_id = ?
        AND model = ? AND model_secondary = ? AND context_tier = ?
    `)
    .get(
      skill.id,
      pr.id,
      job.model,
      job.model_secondary,
      job.context_tier,
    ) as { id: number };
  if (missedFindings.length === 0) {
    const output: SkillAnalysisOutput = {
      summary: "The skill received full credit for this PR.",
      whyMissed: "No scored human findings were missed.",
      mitigation: "No mitigation is required.",
      edits: [],
    };
    db.prepare(`
      UPDATE skill_analysis_results SET
        status = 'completed', duration_ms = 0, analysis_json = ?,
        proposal_json = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(output), JSON.stringify(output.edits), analysisResult.id);
    return { resultId: analysisResult.id, shouldApply: false };
  }

  const workspace = analysisRoot(job.id, pr.number);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  await Promise.all(
    ["pr.json", "files.json", "diff.patch"].map((file) =>
      fs.copyFile(path.join(pr.dataset_path, file), path.join(workspace, file)),
    ),
  );
  await stageSkill(skill.path, workspace);
  const skillFiles = await listSkillImplementationFiles(
    path.join(workspace, "skill"),
  );
  await Promise.all([
    fs.writeFile(
      path.join(workspace, "skill-implementation.json"),
      JSON.stringify(
        {
          configuredPath: skill.path,
          files: skillFiles,
          instruction:
            "Trace the actual review execution path before proposing edits.",
        },
        null,
        2,
      ),
    ),
    fs.writeFile(
      path.join(workspace, "missed-findings.json"),
      JSON.stringify(missedFindings, null, 2),
    ),
    fs.writeFile(
      path.join(workspace, "skill-review.json"),
      JSON.stringify({ findings: skillFindings }, null, 2),
    ),
  ]);
  const run = await runCopilotSkillAnalysis({
    workspace,
    model: job.model,
    contextTier: job.context_tier,
    usagePath: path.join(workspace, "analysis-usage.json"),
  });
  const groundedOutput = keepImplementationGroundedEdits(
    run.output,
    skillFiles,
  );
  db.prepare(`
    UPDATE skill_analysis_results SET
      status = 'completed', duration_ms = ?, analysis_json = ?,
      proposal_json = ?, usage_json = ?, raw_output = ?, error = NULL,
      applied_at = NULL, application_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    run.durationMs,
    JSON.stringify(groundedOutput),
    JSON.stringify(groundedOutput.edits),
    JSON.stringify(run.usage),
    run.rawOutput,
    analysisResult.id,
  );
  return {
    resultId: analysisResult.id,
    shouldApply: groundedOutput.edits.length > 0,
  };
}

function safeTarget(root: string, relativeFile: string) {
  if (
    !relativeFile ||
    path.isAbsolute(relativeFile) ||
    relativeFile.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Unsafe skill edit path: ${relativeFile}`);
  }
  const target = path.resolve(root, relativeFile);
  const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
  if (!target.toLowerCase().startsWith(prefix)) {
    throw new Error(`Skill edit escapes the configured path: ${relativeFile}`);
  }
  return target;
}

export async function applySkillMitigationEdits(
  configuredRoot: string,
  proposal: SkillMitigationEdit[],
  backupRoot: string,
) {
  const root = await fs.realpath(configuredRoot);
  const originals = new Map<string, string>();
  const updated = new Map<string, string>();
  for (const edit of proposal) {
    const target = safeTarget(root, edit.file);
    const realTarget = await fs.realpath(target);
    if (!realTarget.toLowerCase().startsWith(`${root}${path.sep}`.toLowerCase())) {
      throw new Error(`Skill edit resolves outside the configured path: ${edit.file}`);
    }
    const current =
      updated.get(realTarget) ?? (await fs.readFile(realTarget, "utf8"));
    if (!originals.has(realTarget)) originals.set(realTarget, current);
    const first = current.indexOf(edit.search);
    const second =
      first < 0 ? -1 : current.indexOf(edit.search, first + edit.search.length);
    if (first < 0 || second >= 0) {
      throw new Error(
        `Apply stopped: ${edit.file} changed after this analysis, or the proposed target text is not unique. This is not caused by another Analyze job. Run Analyze again to create a proposal for the current file.`,
      );
    }
    updated.set(
      realTarget,
      `${current.slice(0, first)}${edit.replacement}${current.slice(first + edit.search.length)}`,
    );
  }
  await fs.rm(backupRoot, { recursive: true, force: true });
  for (const [target, content] of originals) {
    const relative = path.relative(root, target);
    const backup = path.join(backupRoot, relative);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, content);
  }
  const written: string[] = [];
  try {
    for (const [target, content] of updated) {
      await fs.writeFile(target, content);
      written.push(target);
    }
  } catch (error) {
    await Promise.all(
      written.map((target) => fs.writeFile(target, originals.get(target)!)),
    );
    throw error;
  }
}

export async function applySkillAnalysisResult(resultId: number) {
  const db = getDb();
  const result = db
    .prepare(`
      SELECT result.id, result.status, result.proposal_json, skill.path
      FROM skill_analysis_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      WHERE result.id = ?
    `)
    .get(resultId) as
    | {
        id: number;
        status: string;
        proposal_json: string | null;
        path: string;
      }
    | undefined;
  if (!result) throw new Error("Skill analysis result was not found");
  if (result.status !== "completed") {
    throw new Error("Skill analysis must complete before it can be applied");
  }
  const proposal = JSON.parse(
    result.proposal_json ?? "[]",
  ) as SkillMitigationEdit[];
  if (proposal.length === 0) {
    throw new Error("The analysis did not contain any safe automated edits");
  }
  const validated = await validateSkillPath(result.path);
  try {
    const backupRoot = path.join(
      DATA_DIR,
      "skill-analysis",
      "backups",
      `result-${result.id}`,
    );
    await applySkillMitigationEdits(validated.resolved, proposal, backupRoot);
    db.prepare(`
      UPDATE skill_analysis_results SET
        applied_at = ?, application_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(new Date().toISOString(), result.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE skill_analysis_results SET
        application_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(message, result.id);
    throw error;
  }
}

export async function executeSkillAnalysisJob(job: SkillAnalysisJob) {
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(job.repository_id) as RepositoryRecord | undefined;
  const skill = db
    .prepare(`
      SELECT * FROM personal_review_skills
      WHERE id = ? AND repository_id = ? AND active = 1
    `)
    .get(job.skill_id, job.repository_id) as
    | PersonalReviewSkillRecord
    | undefined;
  if (!repository || !skill) {
    throw new Error("Repository or personal skill configuration was not found");
  }
  const prIds = JSON.parse(job.pr_ids_json) as number[];
  db.prepare(`
    UPDATE skill_analysis_jobs SET
      status = 'running', started_at = ?, error = NULL,
      status_message = 'Analyzing missed findings'
    WHERE id = ?
  `).run(new Date().toISOString(), job.id);
  const errors: string[] = [];
  let completed = 0;
  for (const prId of prIds) {
    const pr = db
      .prepare(`
        SELECT id, number, title, url, dataset_path, defect_description
        FROM pull_requests
        WHERE id = ? AND repository_id = ? AND active = 1
      `)
      .get(prId, repository.id) as AnalysisPr | undefined;
    try {
      if (!pr) throw new Error("Pull request was not found");
      db.prepare(`
        UPDATE skill_analysis_results SET
          status = 'running', error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ? AND pull_request_id = ?
          AND model = ? AND model_secondary = ? AND context_tier = ?
      `).run(
        skill.id,
        pr.id,
        job.model,
        job.model_secondary,
        job.context_tier,
      );
      const analysis = await analyzePullRequest(job, skill, pr);
      if (job.mode === "analyze_apply" && analysis.shouldApply) {
        await applySkillAnalysisResult(analysis.resultId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`PR ${pr ? `#${pr.number}` : prId}: ${message}`);
      db.prepare(`
        UPDATE skill_analysis_results SET
          status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE skill_id = ? AND pull_request_id = ?
          AND model = ? AND model_secondary = ? AND context_tier = ?
      `).run(
        message,
        skill.id,
        prId,
        job.model,
        job.model_secondary,
        job.context_tier,
      );
    } finally {
      completed += 1;
      db.prepare(`
        UPDATE skill_analysis_jobs SET
          current_item = ?, status_message = ?
        WHERE id = ?
      `).run(
        completed,
        `${job.mode === "analyze_apply" ? "Analyzing and applying" : "Analyzing"} · ${completed}/${prIds.length}`,
        job.id,
      );
    }
  }
  db.prepare(`
    UPDATE skill_analysis_jobs SET
      status = 'completed', status_message = ?, error = ?, completed_at = ?
    WHERE id = ?
  `).run(
    errors.length > 0
      ? `Complete with ${errors.length} failure${errors.length === 1 ? "" : "s"}`
      : "Complete",
    errors.length > 0 ? errors.join("\n") : null,
    new Date().toISOString(),
    job.id,
  );
}
