import fs from "node:fs/promises";
import path from "node:path";
import {
  prepareSkillRoot,
  runCopilotOrchestration,
  runCopilotReview,
} from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { runDir } from "@/lib/paths";
import { writePrReport, writeSummaryReport } from "@/lib/reports";
import { scoreReviewPair } from "@/lib/scoring";
import type {
  HumanFinding,
  MultiModelPrMetrics,
  RepositoryRecord,
  ReviewOutput,
  RunRecord,
} from "@/lib/types";

type PullRequestRow = {
  id: number;
  number: number;
  title: string;
  url: string;
  dataset_path: string;
};

type ModelKey = "model1" | "model2";
type Variant = "skilled" | "baseline";
type ReviewKey = `${ModelKey}-${Variant}`;
type ReviewResult = Awaited<ReturnType<typeof runCopilotReview>>;

async function prepareWorkspace(datasetPath: string, workspace: string) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  await Promise.all(
    ["pr.json", "files.json", "diff.patch"].map((name) =>
      fs.copyFile(path.join(datasetPath, name), path.join(workspace, name)),
    ),
  );
}

function shuffledReviewJobs(includeModel2: boolean) {
  const jobs: Array<{ modelKey: ModelKey; variant: Variant }> = [
    { modelKey: "model1", variant: "skilled" },
    { modelKey: "model1", variant: "baseline" },
  ];
  if (includeModel2) {
    jobs.push(
      { modelKey: "model2", variant: "skilled" },
      { modelKey: "model2", variant: "baseline" },
    );
  }
  return jobs.sort(() => Math.random() - 0.5);
}

export async function executeEvaluationRun(run: RunRecord) {
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(run.repository_id) as RepositoryRecord | undefined;
  if (!repository) throw new Error(`Repository ${run.repository_id} not found`);
  const prs = db
    .prepare(
      "SELECT id, number, title, url, dataset_path FROM pull_requests WHERE repository_id = ? AND active = 1 AND valued_comment_count > 0 ORDER BY updated_at DESC LIMIT ?",
    )
    .all(repository.id, repository.target_prs) as PullRequestRow[];
  if (prs.length === 0) throw new Error("No benchmark-eligible PRs are available");

  const outputRoot = runDir(run.id);
  await fs.mkdir(outputRoot, { recursive: true });
  const skillRoot = await prepareSkillRoot(run.skill_path, outputRoot);
  db.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, total_prs = ? WHERE id = ?",
  ).run(new Date().toISOString(), prs.length, run.id);

  const summaryRows: Array<{
    number: number;
    title: string;
    metrics: MultiModelPrMetrics;
    reportPath: string;
  }> = [];
  const models: Record<ModelKey, string> = {
    model1: run.model,
    model2: run.model_secondary,
  };
  const hasModel2 = run.model_secondary !== "none";

  for (const [index, pr] of prs.entries()) {
    db.prepare("UPDATE runs SET current_pr = ? WHERE id = ?").run(index + 1, run.id);
    const prRoot = path.join(outputRoot, `pr-${pr.number}`);
    await fs.mkdir(prRoot, { recursive: true });
    const humanFindings = JSON.parse(
      await fs.readFile(path.join(pr.dataset_path, "human-findings.json"), "utf8"),
    ) as HumanFinding[];
    const results = new Map<ReviewKey, ReviewResult>();

    for (const { modelKey, variant } of shuffledReviewJobs(hasModel2)) {
      const key: ReviewKey = `${modelKey}-${variant}`;
      const workspace = path.join(prRoot, `${key}-workspace`);
      await prepareWorkspace(pr.dataset_path, workspace);
      const usagePath = path.join(prRoot, `${key}-usage.json`);
      try {
        const result = await runCopilotReview({
          workspace,
          model: models[modelKey],
          contextTier: repository.context_tier,
          skillRoot: variant === "skilled" ? skillRoot : undefined,
          usagePath,
        });
        results.set(key, result);
        await fs.writeFile(
          path.join(prRoot, `${key}.json`),
          JSON.stringify(result.output, null, 2),
        );
        db.prepare(`
          INSERT INTO review_results (
            run_id, pull_request_id, model_key, variant, status, duration_ms,
            usage_json, findings_json, raw_output
          ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)
          ON CONFLICT(run_id, pull_request_id, model_key, variant) DO UPDATE SET
            status = excluded.status,
            duration_ms = excluded.duration_ms,
            usage_json = excluded.usage_json,
            findings_json = excluded.findings_json,
            raw_output = excluded.raw_output,
            error = NULL
        `).run(
          run.id,
          pr.id,
          modelKey,
          variant,
          result.durationMs,
          JSON.stringify(result.usage),
          JSON.stringify(result.output.findings),
          result.rawOutput,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`
          INSERT INTO review_results (
            run_id, pull_request_id, model_key, variant, status, error
          ) VALUES (?, ?, ?, ?, 'failed', ?)
          ON CONFLICT(run_id, pull_request_id, model_key, variant) DO UPDATE SET
            status = excluded.status,
            error = excluded.error
        `).run(run.id, pr.id, modelKey, variant, message);
        throw new Error(`${key} review failed for PR #${pr.number}: ${message}`);
      }
    }

    const model1Skilled = results.get("model1-skilled");
    const model1Baseline = results.get("model1-baseline");
    const model2Skilled = results.get("model2-skilled");
    const model2Baseline = results.get("model2-baseline");
    if (!model1Skilled || !model1Baseline) {
      throw new Error(`Model 1 review result is incomplete for PR #${pr.number}`);
    }
    if (hasModel2 && (!model2Skilled || !model2Baseline)) {
      throw new Error(`Model 2 review result is incomplete for PR #${pr.number}`);
    }

    let finalSkilled = model1Skilled.output;
    let finalBaseline = model1Baseline.output;
    let orchestrationSummary =
      "Model 2 was disabled; Model 1 results were scored directly.";
    let orchestrationDurationMs = 0;
    if (hasModel2 && model2Skilled && model2Baseline) {
      const orchestrationWorkspace = path.join(prRoot, "orchestration-workspace");
      await prepareWorkspace(pr.dataset_path, orchestrationWorkspace);
      await Promise.all(
        [...results.entries()].map(([key, result]) =>
          fs.writeFile(
            path.join(orchestrationWorkspace, `${key}.json`),
            JSON.stringify(result.output, null, 2),
          ),
        ),
      );
      const orchestration = await runCopilotOrchestration({
        workspace: orchestrationWorkspace,
        model: run.model,
        contextTier: repository.context_tier,
        usagePath: path.join(prRoot, "orchestration-usage.json"),
      });
      finalSkilled = orchestration.output.skilled;
      finalBaseline = orchestration.output.baseline;
      orchestrationSummary = orchestration.output.summary;
      orchestrationDurationMs = orchestration.durationMs;
      await fs.writeFile(
        path.join(prRoot, "orchestration.json"),
        JSON.stringify(orchestration.output, null, 2),
      );
    }

    const model1Metrics = scoreReviewPair(
      humanFindings,
      model1Skilled.output.findings,
      model1Baseline.output.findings,
      model1Skilled.durationMs,
      model1Baseline.durationMs,
    );
    const model2Metrics =
      model2Skilled && model2Baseline
        ? scoreReviewPair(
            humanFindings,
            model2Skilled.output.findings,
            model2Baseline.output.findings,
            model2Skilled.durationMs,
            model2Baseline.durationMs,
          )
        : null;
    const metrics: MultiModelPrMetrics = {
      model1: model1Metrics,
      model2: model2Metrics,
      orchestrated: scoreReviewPair(
        humanFindings,
        finalSkilled.findings,
        finalBaseline.findings,
        model1Skilled.durationMs + (model2Skilled?.durationMs ?? 0),
        model1Baseline.durationMs + (model2Baseline?.durationMs ?? 0),
      ),
      orchestrationDurationMs,
    };
    const modelReviews: Partial<Record<ReviewKey, ReviewOutput>> = {
      "model1-skilled": model1Skilled.output,
      "model1-baseline": model1Baseline.output,
    };
    if (model2Skilled) modelReviews["model2-skilled"] = model2Skilled.output;
    if (model2Baseline) modelReviews["model2-baseline"] = model2Baseline.output;
    const reportPath = path.join(prRoot, "report.md");
    await Promise.all([
      fs.writeFile(path.join(prRoot, "metrics.json"), JSON.stringify(metrics, null, 2)),
      writePrReport({
        outputPath: reportPath,
        repository: repository.slug,
        pr,
        humanFindings,
        skilled: finalSkilled,
        baseline: finalBaseline,
        modelReviews,
        models: {
          model1: models.model1,
          model2: hasModel2 ? models.model2 : null,
        },
        orchestrationSummary,
        metrics,
      }),
    ]);
    db.prepare(`
      INSERT INTO metrics (run_id, pull_request_id, metrics_json, report_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, pull_request_id) DO UPDATE SET
        metrics_json = excluded.metrics_json,
        report_path = excluded.report_path
    `).run(run.id, pr.id, JSON.stringify(metrics), reportPath);
    summaryRows.push({ number: pr.number, title: pr.title, metrics, reportPath });
  }

  const summary = await writeSummaryReport({
    outputDirectory: outputRoot,
    repository: repository.slug,
    models: {
      model1: models.model1,
      model2: hasModel2 ? models.model2 : null,
    },
    skillPath: run.skill_path,
    rows: summaryRows,
  });
  db.prepare(
    "UPDATE runs SET status = 'completed', completed_at = ?, summary_path = ?, current_pr = total_prs WHERE id = ?",
  ).run(new Date().toISOString(), summary.markdownPath, run.id);
}
