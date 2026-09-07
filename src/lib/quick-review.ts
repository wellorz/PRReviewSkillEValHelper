import fs from "node:fs/promises";
import path from "node:path";
import {
  prepareSkillRoot,
  runCopilotReview,
  runQuickOrchestration,
} from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { collectPullRequestSnapshot } from "@/lib/github";
import { quickReviewDir } from "@/lib/paths";
import { writeQuickReviewReport } from "@/lib/reports";
import type { RepositoryRecord } from "@/lib/types";

type QuickReviewRow = {
  id: number;
  repository_id: number;
  pr_number: number;
};

async function copySnapshot(dataset: string, workspace: string) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  await Promise.all(
    ["pr.json", "files.json", "diff.patch"].map((name) =>
      fs.copyFile(path.join(dataset, name), path.join(workspace, name)),
    ),
  );
}

export async function executeQuickReview(review: QuickReviewRow) {
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(review.repository_id) as RepositoryRecord | undefined;
  if (!repository) throw new Error("Configured repository not found");

  const root = quickReviewDir(review.id);
  const dataset = path.join(root, "dataset");
  await fs.mkdir(root, { recursive: true });
  db.prepare(
    "UPDATE quick_reviews SET status = 'running', stage = 'collecting PR snapshot', started_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), review.id);
  const pr = await collectPullRequestSnapshot(
    repository,
    review.pr_number,
    dataset,
  );
  db.prepare(
    "UPDATE quick_reviews SET title = ?, url = ?, stage = 'running two skilled reviews' WHERE id = ?",
  ).run(pr.title, pr.url, review.id);

  const skillRoot = await prepareSkillRoot(repository.skill_path, root);
  const model1Workspace = path.join(root, "model1-workspace");
  await copySnapshot(dataset, model1Workspace);
  const hasModel2 = repository.model_secondary !== "none";
  const model2Workspace = path.join(root, "model2-workspace");
  if (hasModel2) await copySnapshot(dataset, model2Workspace);
  const order = hasModel2
    ? Math.random() < 0.5
      ? ["model1", "model2"]
      : ["model2", "model1"]
    : ["model1"];
  const results = new Map<
    string,
    Awaited<ReturnType<typeof runCopilotReview>>
  >();
  for (const modelKey of order) {
    const isModel1 = modelKey === "model1";
    const result = await runCopilotReview({
      workspace: isModel1 ? model1Workspace : model2Workspace,
      model: isModel1 ? repository.model : repository.model_secondary,
      contextTier: repository.context_tier,
      skillRoot,
      usagePath: path.join(root, `${modelKey}-usage.json`),
    });
    results.set(modelKey, result);
    await fs.writeFile(
      path.join(root, `${modelKey}-review.json`),
      JSON.stringify(result.output, null, 2),
    );
  }

  const model1 = results.get("model1");
  const model2 = results.get("model2");
  if (!model1) throw new Error("Model 1 review is incomplete");
  let finalReview = model1.output;
  let orchestrationDurationMs = 0;
  if (hasModel2) {
    if (!model2) throw new Error("Model 2 review is incomplete");
    db.prepare(
      "UPDATE quick_reviews SET stage = 'model 1 orchestration' WHERE id = ?",
    ).run(review.id);
    const orchestrationWorkspace = path.join(root, "orchestration-workspace");
    await copySnapshot(dataset, orchestrationWorkspace);
    await Promise.all([
      fs.writeFile(
        path.join(orchestrationWorkspace, "model1-review.json"),
        JSON.stringify(model1.output, null, 2),
      ),
      fs.writeFile(
        path.join(orchestrationWorkspace, "model2-review.json"),
        JSON.stringify(model2.output, null, 2),
      ),
    ]);
    const orchestration = await runQuickOrchestration({
      workspace: orchestrationWorkspace,
      model: repository.model,
      contextTier: repository.context_tier,
      usagePath: path.join(root, "orchestration-usage.json"),
    });
    finalReview = orchestration.output;
    orchestrationDurationMs = orchestration.durationMs;
  }
  const resultPath = path.join(root, "report.md");
  await Promise.all([
    fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(finalReview, null, 2),
    ),
    writeQuickReviewReport({
      outputPath: resultPath,
      repository: repository.slug,
      pr,
      models: {
        model1: repository.model,
        model2: hasModel2 ? repository.model_secondary : null,
      },
      review: finalReview,
      durationMs:
        model1.durationMs + (model2?.durationMs ?? 0) + orchestrationDurationMs,
    }),
  ]);
  db.prepare(
    "UPDATE quick_reviews SET status = 'completed', stage = 'complete', completed_at = ?, result_path = ? WHERE id = ?",
  ).run(new Date().toISOString(), resultPath, review.id);
}
