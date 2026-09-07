import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseReviewOutput,
  prepareSkillRoot,
  runNativeWzReview,
  runCopilotReview,
  runQuickOrchestration,
} from "@/lib/copilot";
import { getDb } from "@/lib/db";
import { collectPullRequestSnapshot } from "@/lib/github";
import {
  loadGroundTruth,
  loadReviewSnapshots,
  type ReviewSnapshot,
} from "@/lib/ground-truth";
import { DATA_DIR } from "@/lib/paths";
import { createHistoricalRepositoryContext } from "@/lib/repository-context";
import { jaccard, scoreReview, scoreReviewPair } from "@/lib/scoring";
import type {
  BaselineProfileRecord,
  HumanFinding,
  ModelFinding,
  PersonalReviewSkillRecord,
  RepositoryRecord,
  ReviewOutput,
} from "@/lib/types";
import {
  runWithWorkflowCancellation,
  throwIfWorkflowCancelled,
  WorkflowCancellationError,
} from "@/lib/workflow-cancellation";

type WorkflowTask = {
  id: number;
  repository_id: number;
  kind: "manual_pr" | "baseline" | "skill_eval";
  pr_ids_json: string;
  payload_json: string | null;
};

type WorkflowPr = {
  id: number;
  number: number;
  title: string;
  url: string;
  dataset_path: string;
  defect_description: string | null;
  baseline_status: string;
  baseline_duration_ms: number | null;
  baseline_findings_json: string | null;
};

function taskRoot(taskId: number) {
  return path.join(DATA_DIR, "workflow", `task-${taskId}`);
}

function workflowCancellationRequested(taskId: number) {
  const task = getDb()
    .prepare("SELECT status FROM workflow_tasks WHERE id = ?")
    .get(taskId) as { status: string } | undefined;
  return task?.status === "cancelling" || task?.status === "cancelled";
}

function resetCancelledTaskResults(task: WorkflowTask) {
  const db = getDb();
  const pullRequestIds = JSON.parse(task.pr_ids_json || "[]") as number[];
  if (pullRequestIds.length === 0) return;
  const prPlaceholders = pullRequestIds.map(() => "?").join(",");
  const payload = JSON.parse(task.payload_json ?? "{}") as {
    profileIds?: number[];
    skillIds?: number[];
    model?: string;
    modelSecondary?: string;
    contextTier?: string;
  };
  if (task.kind === "baseline" && payload.profileIds?.length) {
    const profileIds = [...new Set(payload.profileIds)];
    const profilePlaceholders = profileIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE baseline_profile_results
      SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE pull_request_id IN (${prPlaceholders})
        AND profile_id IN (${profilePlaceholders})
        AND status = 'running'
    `).run(...pullRequestIds, ...profileIds);
    return;
  }
  if (
    task.kind === "skill_eval" &&
    payload.skillIds?.length &&
    payload.model &&
    payload.modelSecondary &&
    payload.contextTier
  ) {
    const skillIds = [...new Set(payload.skillIds)];
    const skillPlaceholders = skillIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE personal_skill_results
      SET status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE pull_request_id IN (${prPlaceholders})
        AND skill_id IN (${skillPlaceholders})
        AND model = ? AND model_secondary = ? AND context_tier = ?
        AND status = 'running'
    `).run(
      ...pullRequestIds,
      ...skillIds,
      payload.model,
      payload.modelSecondary,
      payload.contextTier,
    );
    return;
  }
  if (task.kind === "baseline") {
    db.prepare(`
      UPDATE pull_requests
      SET baseline_status = 'pending', baseline_error = NULL
      WHERE id IN (${prPlaceholders}) AND baseline_status = 'running'
    `).run(...pullRequestIds);
  } else if (task.kind === "skill_eval") {
    db.prepare(`
      UPDATE pull_requests
      SET skill_status = 'pending', skill_error = NULL
      WHERE id IN (${prPlaceholders}) AND skill_status = 'running'
    `).run(...pullRequestIds);
  }
}

async function waitForPersonalSkillPriority(
  taskId: number,
  repositoryId: number,
) {
  const db = getDb();
  let paused = false;
  while (
    db
      .prepare(`
        SELECT 1
        FROM workflow_tasks
        WHERE repository_id = ?
          AND kind = 'skill_eval'
          AND status IN ('queued', 'running')
        LIMIT 1
      `)
      .get(repositoryId)
  ) {
    throwIfWorkflowCancelled();
    if (!paused) {
      db.prepare(`
        UPDATE workflow_tasks
        SET status_message = 'Paused while personal skill reviews have priority'
        WHERE id = ? AND status = 'running'
      `).run(taskId);
      paused = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

type HistoricalRepositoryContext = Exclude<
  Awaited<ReturnType<typeof createHistoricalRepositoryContext>>,
  null
>;

async function copySnapshot(
  datasetPath: string,
  workspace: string,
  repositoryContext?: HistoricalRepositoryContext | null,
) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  await Promise.all(
    ["pr.json", "files.json", "diff.patch"].map((name) =>
      fs.copyFile(path.join(datasetPath, name), path.join(workspace, name)),
    ),
  );
  if (repositoryContext) {
    await fs.writeFile(
      path.join(workspace, "repository-context.json"),
      JSON.stringify(
        {
          path: repositoryContext.path,
          commit: repositoryContext.commit,
          warning: repositoryContext.warning,
        },
        null,
        2,
      ),
    );
  }
}

async function withHistoricalRepositoryContext<T>(options: {
  repository: RepositoryRecord;
  datasetPath: string;
  worktreePath: string;
  forceDiffOnly?: boolean;
  action: (
    repositoryContext: HistoricalRepositoryContext | null,
  ) => Promise<T>;
}) {
  if (options.forceDiffOnly) {
    return options.action(null);
  }
  let repositoryContext: HistoricalRepositoryContext | null = null;
  try {
    repositoryContext = await createHistoricalRepositoryContext({
      repository: options.repository,
      datasetPath: options.datasetPath,
      worktreePath: options.worktreePath,
      shareReadOnly: true,
    });
  } catch (error) {
    throwIfWorkflowCancelled(error);
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/PR head commit .* (?:is unavailable|is not available)|no local ref contains a verified/i.test(
        message,
      )
    ) {
      throw error;
    }
    await fs.access(path.join(options.datasetPath, "diff.patch"));
  }
  try {
    return await options.action(repositoryContext);
  } finally {
    await repositoryContext?.cleanup();
  }
}

type SnapshotReviewExecution = {
  snapshot: ReviewSnapshot;
  review: ReviewOutput;
  durationMs: number;
  usage: Record<string, unknown>;
  rawOutput: Record<string, unknown>;
  repositoryContextMode: "local_repo" | "diff";
  repositoryCommit: string | null;
};

function tagSnapshotReview(
  review: ReviewOutput,
  snapshot: ReviewSnapshot,
): ReviewOutput {
  return {
    summary: review.summary,
    findings: review.findings.map((finding) => ({
      ...finding,
      iterationId: snapshot.iterationId,
      iterationSourceCommit: snapshot.sourceCommit,
    })),
  };
}

function addExecutionProvenance(
  review: ReviewOutput,
  model: string,
  contextTier: string,
  usesSkill: boolean,
): ReviewOutput {
  return {
    summary: review.summary,
    findings: review.findings.map((finding) => {
      const reviewers = [
        ...(finding.reviewers ?? []),
        ...(finding.reviewer ? [finding.reviewer] : []),
      ];
      if (reviewers.length === 0) {
        reviewers.push(usesSkill ? `${model}/unattributed-role` : "raw-model");
      }
      return {
        ...finding,
        reviewer: finding.reviewer ?? reviewers[0],
        reviewers: [...new Set(reviewers)],
        sourceModels: [...new Set([...(finding.sourceModels ?? []), model])],
        contextTier: finding.contextTier ?? contextTier,
      };
    }),
  };
}

function sameFindingLocation(left: ModelFinding, right: ModelFinding) {
  if (!left.file || !right.file) return false;
  if (
    left.file.replaceAll("\\", "/").toLowerCase() !==
    right.file.replaceAll("\\", "/").toLowerCase()
  ) {
    return false;
  }
  if (left.lineStart == null || right.lineStart == null) return true;
  const leftEnd = left.lineEnd ?? left.lineStart;
  const rightEnd = right.lineEnd ?? right.lineStart;
  return left.lineStart <= rightEnd + 3 && right.lineStart <= leftEnd + 3;
}

function mergeFindingProvenance(
  finalReview: ReviewOutput,
  sourceReviews: ReviewOutput[],
  orchestrationModel: string,
  contextTier: string,
) {
  const sourceFindings = sourceReviews.flatMap((review) => review.findings);
  return {
    summary: finalReview.summary,
    findings: finalReview.findings.map((finding) => {
      const finalText = `${finding.title} ${finding.description} ${finding.evidence}`;
      const matchingSources = sourceFindings.filter((source) => {
        const sourceText = `${source.title} ${source.description} ${source.evidence}`;
        return (
          sameFindingLocation(finding, source) ||
          jaccard(finalText, sourceText) >= 0.18
        );
      });
      const reviewers = [
        ...(finding.reviewers ?? []),
        ...(finding.reviewer ? [finding.reviewer] : []),
        ...matchingSources.flatMap((source) => [
          ...(source.reviewers ?? []),
          ...(source.reviewer ? [source.reviewer] : []),
        ]),
      ];
      const sourceModels = [
        ...(finding.sourceModels ?? []),
        ...matchingSources.flatMap((source) => source.sourceModels ?? []),
      ];
      return {
        ...finding,
        reviewer: finding.reviewer ?? reviewers[0] ?? null,
        reviewers:
          reviewers.length > 0
            ? [...new Set(reviewers)]
            : [`${orchestrationModel}/unattributed-role`],
        sourceModels:
          sourceModels.length > 0
            ? [...new Set(sourceModels)]
            : [orchestrationModel],
        contextTier: finding.contextTier ?? contextTier,
        agreedBy: [
          ...new Set([
            ...(finding.agreedBy ?? []),
            ...matchingSources.flatMap((source) => source.agreedBy ?? []),
          ]),
        ],
      };
    }),
  } satisfies ReviewOutput;
}

function combineSnapshotReviews(executions: SnapshotReviewExecution[]) {
  return {
    summary: executions
      .map(
        ({ snapshot, review }) =>
          `${snapshot.key}: ${review.summary || "No summary provided."}`,
      )
      .join("\n"),
    findings: executions.flatMap(({ review }) => review.findings),
  } satisfies ReviewOutput;
}

function snapshotContextSignature(executions: SnapshotReviewExecution[]) {
  if (executions.length === 1) {
    return executions[0].repositoryCommit;
  }
  return JSON.stringify(
    executions.map(({ snapshot, repositoryContextMode, repositoryCommit }) => ({
      key: snapshot.key,
      iterationId: snapshot.iterationId,
      mode: repositoryContextMode,
      commit: repositoryCommit,
    })),
  );
}

async function skillExecutionEvidence(
  skillRoot: string | undefined,
  skillName: string | undefined,
) {
  if (!skillRoot || !skillName) {
    return {
      mode: "raw-model-baseline" as const,
      requestedSkill: null,
      loadedSkillDirectory: null,
      skillManifestSha256: null,
    };
  }
  const skillsRoot = path.join(skillRoot, ".github", "skills");
  const directories = await fs.readdir(skillsRoot, { withFileTypes: true });
  const directory =
    directories.find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.toLowerCase() === skillName.toLowerCase(),
    ) ?? directories.find((entry) => entry.isDirectory());
  if (!directory) {
    throw new Error(`No copied skill directory exists under ${skillsRoot}`);
  }
  const manifestPath = path.join(skillsRoot, directory.name, "SKILL.md");
  const manifest = await fs.readFile(manifestPath);
  return {
    mode: "personal-skill" as const,
    requestedSkill: skillName,
    loadedSkillDirectory: path.join(skillsRoot, directory.name),
    skillManifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

async function runSnapshotReviews(options: {
  repository: RepositoryRecord;
  pr: WorkflowPr;
  root: string;
  workspacePrefix: string;
  model: string;
  modelSecondary: string;
  contextTier: string;
  skillRoot?: string;
  skillName?: string;
  repositoryContextMode?: "local_repo" | "diff";
}) {
  const snapshots = await loadReviewSnapshots(options.pr);
  if (snapshots.length === 0) {
    throw new Error("The PR has no review snapshot with scored ground truth");
  }
  const executionEvidence = await skillExecutionEvidence(
    options.skillRoot,
    options.skillName,
  );
  const executions: SnapshotReviewExecution[] = [];
  for (const snapshot of snapshots) {
    const snapshotRoot = path.join(
      options.root,
      `${options.workspacePrefix}-${snapshot.key}`,
    );
    const execution = await withHistoricalRepositoryContext({
      repository: options.repository,
      datasetPath: snapshot.datasetPath,
      worktreePath: path.join(snapshotRoot, "repository"),
      forceDiffOnly: options.repositoryContextMode === "diff",
      action: async (repositoryContext) => {
        if (options.skillName?.toLowerCase() === "wz-review") {
          if (repositoryContext && !snapshot.targetCommit) {
            throw new Error(
              `Snapshot ${snapshot.key} does not contain a target commit`,
            );
          }
          const outputFolder = path.join(snapshotRoot, "wz-review-output");
          const invocationRoot =
            repositoryContext?.path ??
            path.join(snapshotRoot, "wz-review-snapshot");
          if (!repositoryContext) {
            await copySnapshot(snapshot.datasetPath, invocationRoot, null);
          }
          const native = await runNativeWzReview({
            repositoryRoot: invocationRoot,
            outputFolder,
            sourceCommit: repositoryContext?.commit,
            targetCommit: snapshot.targetCommit,
            diffOnly: !repositoryContext,
            model: options.model,
            contextTier: options.contextTier,
            skillRoot: options.skillRoot!,
            usagePath: path.join(snapshotRoot, "wz-review-usage.json"),
          });
          const nativeReview = addExecutionProvenance(
            native.output,
            options.model,
            options.contextTier,
            true,
          );
          return {
            snapshot,
            review: tagSnapshotReview(nativeReview, snapshot),
            durationMs: native.durationMs,
            usage: { native: native.usage },
            rawOutput: {
              native: native.rawOutput,
              nativeArtifacts: native.nativeArtifacts,
            },
            repositoryContextMode: repositoryContext ? "local_repo" : "diff",
            repositoryCommit: repositoryContext?.commit ?? null,
          } satisfies SnapshotReviewExecution;
        }
        const model1Workspace = path.join(snapshotRoot, "model1");
        await copySnapshot(
          snapshot.datasetPath,
          model1Workspace,
          repositoryContext,
        );
        const model1Promise = runCopilotReview({
          workspace: model1Workspace,
          model: options.model,
          contextTier: options.contextTier,
          skillRoot: options.skillRoot,
          skillName: options.skillName,
          repositoryRoot: repositoryContext?.path,
          usagePath: path.join(snapshotRoot, "model1-usage.json"),
        });
        const model2Promise =
          options.modelSecondary === "none"
            ? Promise.resolve(null)
            : (async () => {
                const model2Workspace = path.join(snapshotRoot, "model2");
                await copySnapshot(
                  snapshot.datasetPath,
                  model2Workspace,
                  repositoryContext,
                );
                return runCopilotReview({
                  workspace: model2Workspace,
                  model: options.modelSecondary,
                  contextTier: options.contextTier,
                  skillRoot: options.skillRoot,
                  skillName: options.skillName,
                  repositoryRoot: repositoryContext?.path,
                  usagePath: path.join(snapshotRoot, "model2-usage.json"),
                });
              })();
        const [model1, model2] = await Promise.all([
          model1Promise,
          model2Promise,
        ]);
        const model1Review = addExecutionProvenance(
          model1.output,
          options.model,
          options.contextTier,
          Boolean(options.skillRoot),
        );
        const model2Review = model2
          ? addExecutionProvenance(
              model2.output,
              options.modelSecondary,
              options.contextTier,
              Boolean(options.skillRoot),
            )
          : null;
        let finalReview = model1Review;
        let orchestration:
          | Awaited<ReturnType<typeof runQuickOrchestration>>
          | null = null;
        if (model2) {
          const orchestrationWorkspace = path.join(
            snapshotRoot,
            "orchestration",
          );
          await copySnapshot(
            snapshot.datasetPath,
            orchestrationWorkspace,
            repositoryContext,
          );
          await Promise.all([
            fs.writeFile(
              path.join(orchestrationWorkspace, "model1-review.json"),
              JSON.stringify(model1Review, null, 2),
            ),
            fs.writeFile(
              path.join(orchestrationWorkspace, "model2-review.json"),
              JSON.stringify(model2Review, null, 2),
            ),
          ]);
          orchestration = await runQuickOrchestration({
            workspace: orchestrationWorkspace,
            model: options.model,
            contextTier: options.contextTier,
            repositoryRoot: repositoryContext?.path,
            usagePath: path.join(snapshotRoot, "orchestration-usage.json"),
          });
          finalReview = mergeFindingProvenance(
            orchestration.output,
            [model1Review, model2Review!],
            options.model,
            options.contextTier,
          );
        }
        return {
          snapshot,
          review: tagSnapshotReview(finalReview, snapshot),
          durationMs:
            model1.durationMs +
            (model2?.durationMs ?? 0) +
            (orchestration?.durationMs ?? 0),
          usage: {
            model1: model1.usage,
            model2: model2?.usage ?? null,
            orchestration: orchestration?.usage ?? null,
          },
          rawOutput: {
            model1: model1.rawOutput,
            model2: model2?.rawOutput ?? null,
            orchestration: orchestration?.rawOutput ?? null,
          },
          repositoryContextMode: repositoryContext ? "local_repo" : "diff",
          repositoryCommit: repositoryContext?.commit ?? null,
        } satisfies SnapshotReviewExecution;
      },
    });
    executions.push(execution);
  }
  return {
    executions,
    review: combineSnapshotReviews(executions),
    durationMs: executions.reduce(
      (sum, execution) => sum + execution.durationMs,
      0,
    ),
    repositoryContextMode: executions.every(
      (execution) => execution.repositoryContextMode === "local_repo",
    )
      ? ("local_repo" as const)
      : ("diff" as const),
    repositoryCommit: snapshotContextSignature(executions),
    usage: {
      iterations: executions.map(({ snapshot, usage }) => ({
        key: snapshot.key,
        iterationId: snapshot.iterationId,
        ...usage,
      })),
    },
    rawOutput: {
      execution: {
        ...executionEvidence,
        nativeWorkflow:
          options.skillName?.toLowerCase() === "wz-review",
        model: options.model,
        modelSecondary: options.modelSecondary,
        contextTier: options.contextTier,
      },
      iterations: executions.map(({ snapshot, rawOutput }) => ({
        key: snapshot.key,
        iterationId: snapshot.iterationId,
        sourceCommit: snapshot.sourceCommit,
        ...rawOutput,
      })),
    },
  };
}

function parseFindings(value: string | null): ModelFinding[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelFinding[]) : [];
  } catch {
    return [];
  }
}

function highestReviewSeverity(review: ReviewOutput) {
  return (
    ["critical", "high", "medium", "low"].find((severity) =>
      review.findings.some((finding) => finding.severity === severity),
    ) ?? "none"
  ).toUpperCase();
}

async function processManualPr(
  task: WorkflowTask,
  repository: RepositoryRecord,
) {
  const db = getDb();
  const payload = JSON.parse(task.payload_json ?? "{}") as { prNumber?: number };
  if (!payload.prNumber) throw new Error("Manual PR task is missing a PR number");
  const existing = db
    .prepare(
      "SELECT dataset_path FROM pull_requests WHERE repository_id = ? AND number = ?",
    )
    .get(repository.id, payload.prNumber) as
    | { dataset_path: string }
    | undefined;
  const destination =
    existing?.dataset_path ??
    path.join(
      DATA_DIR,
      "datasets",
      repository.slug.replaceAll("/", "__"),
      `pr-${payload.prNumber}`,
    );
  db.prepare(
    "UPDATE workflow_tasks SET status_message = 'Downloading PR metadata and filtered diff', total_items = 1 WHERE id = ?",
  ).run(task.id);
  const metadata = await collectPullRequestSnapshot(
    repository,
    payload.prNumber,
    destination,
  );
  db.prepare(`
    INSERT INTO pull_requests (
      repository_id, number, title, url, author, base_ref, head_ref,
      merged_at, updated_at, additions, deletions, changed_files,
      valued_comment_count, dataset_path, raw_json, active, selected, manual
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 1, 1)
    ON CONFLICT(repository_id, number) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      author = excluded.author,
      base_ref = excluded.base_ref,
      head_ref = excluded.head_ref,
      merged_at = excluded.merged_at,
      updated_at = excluded.updated_at,
      changed_files = excluded.changed_files,
      dataset_path = excluded.dataset_path,
      raw_json = excluded.raw_json,
      active = 1,
      selected = 1,
      manual = 1,
      excluded_by_user = 0
  `).run(
    repository.id,
    metadata.number,
    metadata.title,
    metadata.url,
    metadata.author,
    metadata.base.ref,
    metadata.head.ref,
    metadata.mergedAt,
    metadata.updatedAt,
    metadata.additions,
    metadata.deletions,
    metadata.changedFiles,
    destination,
    JSON.stringify(metadata),
  );
  db.prepare(
    "UPDATE workflow_tasks SET current_item = 1, status_message = 'PR added to workspace' WHERE id = ?",
  ).run(task.id);
}

async function processLegacyBaseline(
  task: WorkflowTask,
  repository: RepositoryRecord,
) {
  const db = getDb();
  const ids = JSON.parse(task.pr_ids_json) as number[];
  const payload = JSON.parse(task.payload_json ?? "{}") as {
    concurrency?: number;
  };
  const concurrency = Math.max(
    1,
    Math.min(20, payload.concurrency ?? repository.baseline_concurrency ?? 5),
  );
  db.prepare(
    "UPDATE workflow_tasks SET total_items = ?, status_message = ? WHERE id = ?",
  ).run(
    ids.length,
    `Starting ${concurrency} parallel baseline reviews`,
    task.id,
  );
  const root = taskRoot(task.id);
  await fs.mkdir(root, { recursive: true });
  let nextIndex = 0;
  let completed = 0;
  const errors: string[] = [];

  async function reviewNextPr() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= ids.length) return;
      const id = ids[index];
    const pr = db
      .prepare(
        "SELECT id, number, title, url, dataset_path, defect_description, baseline_status, baseline_duration_ms, baseline_findings_json FROM pull_requests WHERE id = ? AND repository_id = ? AND active = 1",
      )
      .get(id, repository.id) as WorkflowPr | undefined;
      if (!pr) {
        completed += 1;
        continue;
      }
    db.prepare(
      "UPDATE pull_requests SET baseline_status = 'running', baseline_error = NULL WHERE id = ?",
    ).run(pr.id);
    const workspace = path.join(root, `pr-${pr.number}-baseline`);
    try {
      await withHistoricalRepositoryContext({
        repository,
        datasetPath: pr.dataset_path,
        worktreePath: path.join(root, `pr-${pr.number}-baseline-repository`),
        action: async (repositoryContext) => {
          await copySnapshot(pr.dataset_path, workspace, repositoryContext);
          const result = await runCopilotReview({
            workspace,
            model: repository.model,
            contextTier: repository.context_tier,
            repositoryRoot: repositoryContext?.path,
            usagePath: path.join(root, `pr-${pr.number}-baseline-usage.json`),
          });
          const truth = await loadGroundTruth(pr);
          const score = scoreReviewPair(
            truth,
            [],
            result.output.findings,
            0,
            result.durationMs,
          ).baseline;
          db.prepare(`
            UPDATE pull_requests SET
              baseline_status = 'completed',
              baseline_duration_ms = ?,
              baseline_findings_json = ?,
              baseline_usage_json = ?,
              baseline_metrics_json = ?,
              baseline_error = NULL,
              baseline_completed_at = ?,
              skill_status = 'pending'
            WHERE id = ?
          `).run(
            result.durationMs,
            JSON.stringify(result.output.findings),
            JSON.stringify(result.usage),
            JSON.stringify(score),
            new Date().toISOString(),
            pr.id,
          );
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        "UPDATE pull_requests SET baseline_status = 'failed', baseline_error = ? WHERE id = ?",
      ).run(message, pr.id);
        errors.push(
          `PR #${pr.number}: ${message}`,
        );
      } finally {
        completed += 1;
        db.prepare(
          "UPDATE workflow_tasks SET current_item = ?, status_message = ? WHERE id = ?",
        ).run(
          completed,
          `Running ${concurrency} parallel baseline reviews · ${completed}/${ids.length} complete`,
          task.id,
        );
      }
    }
  }

  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, ids.length) },
      () => reviewNextPr(),
    ),
  );
  throwIfWorkflowCancelled();
  const rejectedWorker = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejectedWorker) throw rejectedWorker.reason;
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${ids.length} baseline reviews failed:\n${errors.join("\n")}`,
    );
  }
}

async function writeEvaluationReport(options: {
  outputPath: string;
  repository: RepositoryRecord;
  pr: WorkflowPr;
  baseline: ReviewOutput;
  skilled: ReviewOutput;
  metrics: ReturnType<typeof scoreReviewPair>;
  truth: HumanFinding[];
  baselineDurationMs: number;
  skillName?: string;
  baselineName?: string;
}) {
  const markdown = `# Skill Evaluation: ${options.repository.display_name}#${options.pr.number}

**${options.pr.title}**

- Result: **${options.metrics.winner}**
- Point score: **Skill ${options.metrics.skilled.earnedPoints}/${options.metrics.skilled.availablePoints} / Baseline ${options.metrics.baseline.earnedPoints}/${options.metrics.baseline.availablePoints}**
- Valued-comment coverage: **Skill ${(options.metrics.skilled.recall * 100).toFixed(1)}% / Baseline ${(options.metrics.baseline.recall * 100).toFixed(1)}%**
- Skill: **${options.skillName ?? "Legacy configured skill"}**
- Baseline: **${options.baselineName ?? "Legacy configured baseline"}**
- Baseline time: **${(options.baselineDurationMs / 1000).toFixed(1)}s**
- Skill time: **${(options.metrics.skilledDurationMs / 1000).toFixed(1)}s**
- Scored valued comments: **${options.metrics.skilled.availablePoints}**
- Ignored minor comments: **${options.metrics.skilled.ignoredHumanFindings}**

| Metric | Skill | Baseline |
|---|---:|---:|
| Precision | ${(options.metrics.skilled.precision * 100).toFixed(1)}% | ${(options.metrics.baseline.precision * 100).toFixed(1)}% |
| Recall | ${(options.metrics.skilled.recall * 100).toFixed(1)}% | ${(options.metrics.baseline.recall * 100).toFixed(1)}% |
| F1 | ${(options.metrics.skilled.f1 * 100).toFixed(1)}% | ${(options.metrics.baseline.f1 * 100).toFixed(1)}% |
| Findings | ${options.skilled.findings.length} | ${options.baseline.findings.length} |

## Skill review summary

${options.skilled.summary || "_No summary provided._"}

**Severity:** ${highestReviewSeverity(options.skilled)}

## Skill findings

${options.skilled.findings.map((finding) => `- **${finding.severity.toUpperCase()} — ${finding.title}**: ${finding.description}`).join("\n") || "_No findings._"}

## Baseline review summary

${options.baseline.summary || "_No summary provided._"}

**Severity:** ${highestReviewSeverity(options.baseline)}

## Baseline findings

${options.baseline.findings.map((finding) => `- **${finding.severity.toUpperCase()} — ${finding.title}**: ${finding.description}`).join("\n") || "_No findings._"}

## Expected defects

${options.truth.map((finding) => `- **${(finding.scorePoint ?? 1) === 1 ? "1 point" : "0 points (minor)"}** — ${finding.normalizedBody ?? finding.body}`).join("\n") || "_No ground truth. This result is unscored._"}
`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, markdown);
}

async function writePersonalSkillReport(options: {
  outputPath: string;
  repository: RepositoryRecord;
  pr: WorkflowPr;
  review: ReviewOutput;
  metrics: ReturnType<typeof scoreReview>;
  truth: HumanFinding[];
  durationMs: number;
  skillName: string;
}) {
  const markdown = `# Personal Skill Review: ${options.repository.display_name}#${options.pr.number}

**${options.pr.title}**

- Skill: **${options.skillName}**
- Point score: **${options.metrics.earnedPoints}/${options.metrics.availablePoints}**
- Valued-comment coverage: **${(options.metrics.recall * 100).toFixed(1)}%**
- Review time: **${(options.durationMs / 1000).toFixed(1)}s**
- Scored valued comments: **${options.metrics.availablePoints}**
- Ignored minor comments: **${options.metrics.ignoredHumanFindings}**

| Metric | Skill |
|---|---:|
| Precision | ${(options.metrics.precision * 100).toFixed(1)}% |
| Recall | ${(options.metrics.recall * 100).toFixed(1)}% |
| F1 | ${(options.metrics.f1 * 100).toFixed(1)}% |
| Findings | ${options.review.findings.length} |

## Skill review summary

${options.review.summary || "_No summary provided._"}

**Severity:** ${highestReviewSeverity(options.review)}

## Skill findings

${options.review.findings.map((finding) => `- **${finding.severity.toUpperCase()} — ${finding.title}** (${finding.sourceModels?.join(", ") || "unknown model"} · ${finding.contextTier ?? "unknown context"}): ${finding.description}`).join("\n") || "_No findings._"}

## Expected defects

${options.truth.map((finding) => `- **${(finding.scorePoint ?? 1) === 1 ? "1 point" : "0 points (minor)"}** — ${finding.normalizedBody ?? finding.body}`).join("\n") || "_No ground truth. This result is unscored._"}
`;
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, markdown);
}

async function processLegacySkillEval(
  task: WorkflowTask,
  repository: RepositoryRecord,
) {
  const db = getDb();
  const ids = JSON.parse(task.pr_ids_json) as number[];
  const payload = JSON.parse(task.payload_json ?? "{}") as {
    concurrency?: number;
  };
  const concurrency = Math.max(
    1,
    Math.min(20, payload.concurrency ?? repository.baseline_concurrency ?? 5),
  );
  db.prepare(
    "UPDATE workflow_tasks SET total_items = ?, status_message = ? WHERE id = ?",
  ).run(
    ids.length,
    `Starting ${concurrency} parallel skill review agents`,
    task.id,
  );
  const root = taskRoot(task.id);
  await fs.mkdir(root, { recursive: true });
  const skillRoot = await prepareSkillRoot(repository.skill_path, root);
  const skillName = path.basename(repository.skill_path);
  const hasModel2 = repository.model_secondary !== "none";
  let nextIndex = 0;
  let completed = 0;
  const errors: string[] = [];

  async function reviewNextPr() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= ids.length) return;
      const id = ids[index];
      const pr = db
        .prepare(
          "SELECT id, number, title, url, dataset_path, defect_description, baseline_status, baseline_duration_ms, baseline_findings_json FROM pull_requests WHERE id = ? AND repository_id = ? AND active = 1",
        )
        .get(id, repository.id) as WorkflowPr | undefined;
      if (!pr) {
        completed += 1;
        continue;
      }
      db.prepare(
        "UPDATE pull_requests SET skill_status = 'running', skill_error = NULL WHERE id = ?",
      ).run(pr.id);
      try {
        if (pr.baseline_status !== "completed") {
          throw new Error("Baseline review is not complete");
        }
        await withHistoricalRepositoryContext({
          repository,
          datasetPath: pr.dataset_path,
          worktreePath: path.join(root, `pr-${pr.number}-skill-repository`),
          action: async (repositoryContext) => {
            const model1Workspace = path.join(
              root,
              `pr-${pr.number}-model1-skill`,
            );
            await copySnapshot(
              pr.dataset_path,
              model1Workspace,
              repositoryContext,
            );
            const model1 = await runCopilotReview({
              workspace: model1Workspace,
              model: repository.model,
              contextTier: repository.context_tier,
              skillRoot,
              skillName,
              repositoryRoot: repositoryContext?.path,
              usagePath: path.join(
                root,
                `pr-${pr.number}-model1-skill-usage.json`,
              ),
            });
            let skilled = model1.output;
            let skillDuration = model1.durationMs;

            if (hasModel2) {
              const model2Workspace = path.join(
                root,
                `pr-${pr.number}-model2-skill`,
              );
              await copySnapshot(
                pr.dataset_path,
                model2Workspace,
                repositoryContext,
              );
              const model2 = await runCopilotReview({
                workspace: model2Workspace,
                model: repository.model_secondary,
                contextTier: repository.context_tier,
                skillRoot,
                skillName,
                repositoryRoot: repositoryContext?.path,
                usagePath: path.join(
                  root,
                  `pr-${pr.number}-model2-skill-usage.json`,
                ),
              });
              const orchestrationWorkspace = path.join(
                root,
                `pr-${pr.number}-orchestration`,
              );
              await copySnapshot(
                pr.dataset_path,
                orchestrationWorkspace,
                repositoryContext,
              );
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
                repositoryRoot: repositoryContext?.path,
                usagePath: path.join(
                  root,
                  `pr-${pr.number}-orchestration-usage.json`,
                ),
              });
              skilled = orchestration.output;
              skillDuration += model2.durationMs + orchestration.durationMs;
            }

            const baseline: ReviewOutput = {
              summary: "",
              findings: parseFindings(pr.baseline_findings_json),
            };
            const truth = await loadGroundTruth(pr);
            const metrics = scoreReviewPair(
              truth,
              skilled.findings,
              baseline.findings,
              skillDuration,
              pr.baseline_duration_ms ?? 0,
            );
            const reportPath = path.join(root, `pr-${pr.number}-report.md`);
            await writeEvaluationReport({
              outputPath: reportPath,
              repository,
              pr,
              baseline,
              skilled,
              metrics,
              truth,
              baselineDurationMs: pr.baseline_duration_ms ?? 0,
            });
            db.prepare(`
              UPDATE pull_requests SET
                skill_status = 'completed',
                skill_duration_ms = ?,
                skill_findings_json = ?,
                skill_metrics_json = ?,
                skill_error = NULL,
                skill_completed_at = ?,
                skill_report_path = ?
              WHERE id = ?
            `).run(
              skillDuration,
              JSON.stringify(skilled.findings),
              JSON.stringify(metrics),
              new Date().toISOString(),
              reportPath,
              pr.id,
            );
          },
        });
      } catch (error) {
        throwIfWorkflowCancelled(error);
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(
          "UPDATE pull_requests SET skill_status = 'failed', skill_error = ? WHERE id = ?",
        ).run(message, pr.id);
        errors.push(`PR #${pr.number}: ${message}`);
      } finally {
        completed += 1;
        db.prepare(
          "UPDATE workflow_tasks SET current_item = ?, status_message = ? WHERE id = ?",
        ).run(
          completed,
          `Running ${concurrency} parallel skill review agents · ${completed}/${ids.length} complete`,
          task.id,
        );
      }
    }
  }

  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, ids.length) },
      () => reviewNextPr(),
    ),
  );
  throwIfWorkflowCancelled();
  const rejectedWorker = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejectedWorker) throw rejectedWorker.reason;
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${ids.length} skill reviews failed:\n${errors.join("\n")}`,
    );
  }
}

function profileLabel(profile: BaselineProfileRecord) {
  return (
    profile.name?.trim() ||
    `${profile.model} + ${profile.model_secondary} / ${profile.context_tier}`
  );
}

function persistedReviewOutput(
  findingsJson: string | null,
  rawOutputJson: string | null,
): ReviewOutput {
  const findings = parseFindings(findingsJson);
  if (!rawOutputJson) {
    return { summary: "", findings };
  }
  try {
    const rawOutputs = JSON.parse(rawOutputJson) as {
      model1?: unknown;
      orchestration?: unknown;
    };
    const finalRaw =
      typeof rawOutputs.orchestration === "string"
        ? rawOutputs.orchestration
        : rawOutputs.model1;
    if (typeof finalRaw === "string") {
      return parseReviewOutput(finalRaw);
    }
  } catch {
    // Findings are still usable when an older raw-output payload cannot be parsed.
  }
  return { summary: "", findings };
}

async function reconcileSkillComparisons(
  repository: RepositoryRecord,
  pr: WorkflowPr,
  profile: BaselineProfileRecord,
) {
  const db = getDb();
  const baselineResult = db
    .prepare(`
      SELECT duration_ms, findings_json, raw_output,
        repository_context_mode, repository_commit
      FROM baseline_profile_results
      WHERE profile_id = ? AND pull_request_id = ? AND status = 'completed'
    `)
    .get(profile.id, pr.id) as
    | {
        duration_ms: number | null;
        findings_json: string | null;
        raw_output: string | null;
        repository_context_mode: string;
        repository_commit: string | null;
      }
    | undefined;
  if (!baselineResult) {
    return;
  }
  const skillResults = db
    .prepare(`
      SELECT result.skill_id, result.duration_ms, result.findings_json,
        result.raw_output_json, skill.name
      FROM personal_skill_results result
      JOIN personal_review_skills skill ON skill.id = result.skill_id
      WHERE result.baseline_profile_id = ?
        AND result.pull_request_id = ?
        AND result.status = 'completed'
        AND result.model = ?
        AND result.model_secondary = ?
        AND result.context_tier = ?
        AND result.repository_context_mode = ?
        AND result.repository_commit IS ?
    `)
    .all(
      profile.id,
      pr.id,
      profile.model,
      profile.model_secondary,
      profile.context_tier,
      baselineResult.repository_context_mode,
      baselineResult.repository_commit,
    ) as Array<{
    skill_id: number;
    duration_ms: number | null;
    findings_json: string | null;
    raw_output_json: string | null;
    name: string;
  }>;
  if (skillResults.length === 0) {
    return;
  }
  const truth = await loadGroundTruth(pr);
  const baseline = persistedReviewOutput(
    baselineResult.findings_json,
    baselineResult.raw_output,
  );
  for (const skillResult of skillResults) {
    const skilled = persistedReviewOutput(
      skillResult.findings_json,
      skillResult.raw_output_json,
    );
    const metrics = scoreReviewPair(
      truth,
      skilled.findings,
      baseline.findings,
      skillResult.duration_ms ?? 0,
      baselineResult.duration_ms ?? 0,
    );
    const reportPath = path.join(
      DATA_DIR,
      "workflow",
      "comparisons",
      `profile-${profile.id}`,
      `skill-${skillResult.skill_id}`,
      `pr-${pr.number}-report.md`,
    );
    await writeEvaluationReport({
      outputPath: reportPath,
      repository,
      pr,
      baseline,
      skilled,
      metrics,
      truth,
      baselineDurationMs: baselineResult.duration_ms ?? 0,
      skillName: skillResult.name,
      baselineName: profileLabel(profile),
    });
    db.prepare(`
      UPDATE personal_skill_results SET
        metrics_json = ?,
        report_path = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE skill_id = ? AND pull_request_id = ?
        AND model = ? AND model_secondary = ? AND context_tier = ?
    `).run(
      JSON.stringify(metrics),
      reportPath,
      skillResult.skill_id,
      pr.id,
      profile.model,
      profile.model_secondary,
      profile.context_tier,
    );
  }
}

export async function rescoreCompletedResults(repositoryId?: number) {
  const db = getDb();
  const repositories = (
    repositoryId
      ? db.prepare("SELECT * FROM repositories WHERE id = ?").all(repositoryId)
      : db.prepare("SELECT * FROM repositories").all()
  ) as RepositoryRecord[];
  let baselineResults = 0;
  let skillResults = 0;

  for (const repository of repositories) {
    const pullRequests = db
      .prepare(`
        SELECT id, number, title, url, dataset_path, defect_description,
          baseline_status, baseline_duration_ms, baseline_findings_json
        FROM pull_requests
        WHERE repository_id = ? AND active = 1
      `)
      .all(repository.id) as WorkflowPr[];
    const profiles = db
      .prepare("SELECT * FROM baseline_profiles WHERE repository_id = ?")
      .all(repository.id) as BaselineProfileRecord[];

    for (const pr of pullRequests) {
      const truth = await loadGroundTruth(pr);
      for (const profile of profiles) {
        const baselineResult = db
          .prepare(`
            SELECT status, duration_ms, findings_json
            FROM baseline_profile_results
            WHERE profile_id = ? AND pull_request_id = ?
          `)
          .get(profile.id, pr.id) as
          | {
              status: string;
              duration_ms: number | null;
              findings_json: string | null;
            }
          | undefined;
        if (baselineResult?.status !== "completed") continue;
        const metrics = scoreReviewPair(
          truth,
          [],
          parseFindings(baselineResult.findings_json),
          0,
          baselineResult.duration_ms ?? 0,
        ).baseline;
        db.prepare(`
          UPDATE baseline_profile_results SET
            metrics_json = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ? AND pull_request_id = ?
        `).run(JSON.stringify(metrics), profile.id, pr.id);
        baselineResults += 1;

        const before = db
          .prepare(`
            SELECT COUNT(*) count
            FROM personal_skill_results
            WHERE baseline_profile_id = ? AND pull_request_id = ?
              AND status = 'completed'
              AND model = ? AND model_secondary = ? AND context_tier = ?
          `)
          .get(
            profile.id,
            pr.id,
            profile.model,
            profile.model_secondary,
            profile.context_tier,
          ) as { count: number };
        await reconcileSkillComparisons(repository, pr, profile);
        skillResults += before.count;
      }
    }
  }

  return { repositories: repositories.length, baselineResults, skillResults };
}

async function processBaselineProfiles(
  task: WorkflowTask,
  repository: RepositoryRecord,
  profileIds: number[],
  concurrency: number,
) {
  const db = getDb();
  const prIds = JSON.parse(task.pr_ids_json) as number[];
  const placeholders = profileIds.map(() => "?").join(",");
  const profiles = db
    .prepare(`
      SELECT * FROM baseline_profiles
      WHERE repository_id = ? AND id IN (${placeholders})
    `)
    .all(repository.id, ...profileIds) as BaselineProfileRecord[];
  if (profiles.length !== profileIds.length) {
    throw new Error("One or more queued baseline profiles no longer exist");
  }
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const orderedProfiles = profileIds.map((profileId) => profilesById.get(profileId)!);
  const units = prIds.flatMap((pullRequestId) =>
    orderedProfiles.map((profile) => ({ profile, pullRequestId })),
  );
  db.prepare(
    "UPDATE workflow_tasks SET total_items = ?, status_message = ? WHERE id = ?",
  ).run(
    units.length,
    `Starting ${concurrency} parallel baseline result units`,
    task.id,
  );
  const root = taskRoot(task.id);
  await fs.mkdir(root, { recursive: true });
  let nextIndex = 0;
  let completed = 0;
  const errors: string[] = [];

  async function reviewNextUnit() {
    while (true) {
      await waitForPersonalSkillPriority(task.id, repository.id);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= units.length) return;
      const { profile, pullRequestId } = units[index];
      const pr = db
        .prepare(`
          SELECT id, number, title, url, dataset_path, defect_description,
            baseline_status, baseline_duration_ms, baseline_findings_json
          FROM pull_requests
          WHERE id = ? AND repository_id = ? AND active = 1
        `)
        .get(pullRequestId, repository.id) as WorkflowPr | undefined;
      try {
        if (!pr) throw new Error(`Pull request ${pullRequestId} is unavailable`);
        const previous = db
          .prepare(`
            SELECT status, error
            FROM baseline_profile_results
            WHERE profile_id = ? AND pull_request_id = ?
          `)
          .get(profile.id, pr.id) as
          | { status: string; error: string | null }
          | undefined;
        if (previous?.status === "completed") continue;
        if (previous?.status === "failed") {
          errors.push(
            `${profileLabel(profile)} / PR #${pr.number}: ${previous.error ?? "Previous attempt failed"}`,
          );
          continue;
        }
        db.prepare(`
          INSERT INTO baseline_profile_results (
            profile_id, pull_request_id, status, repository_context_mode
          ) VALUES (?, ?, 'running', ?)
          ON CONFLICT(profile_id, pull_request_id) DO UPDATE SET
            status = 'running',
            duration_ms = NULL,
            findings_json = NULL,
            usage_json = NULL,
            metrics_json = NULL,
            raw_output = NULL,
            repository_context_mode = excluded.repository_context_mode,
            repository_commit = NULL,
            error = NULL,
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          profile.id,
          pr.id,
          repository.local_repo_path ? "local_repo" : "diff",
        );
        const result = await runSnapshotReviews({
          repository,
          pr,
          root: path.join(root, `profile-${profile.id}`),
          workspacePrefix: `pr-${pr.number}-baseline`,
          model: profile.model,
          modelSecondary: profile.model_secondary,
          contextTier: profile.context_tier,
        });
        const truth = await loadGroundTruth(pr);
        const metrics = scoreReviewPair(
          truth,
          [],
          result.review.findings,
          0,
          result.durationMs,
        ).baseline;
        db.prepare(`
              UPDATE baseline_profile_results SET
                status = 'completed',
                duration_ms = ?,
                findings_json = ?,
                usage_json = ?,
                metrics_json = ?,
                raw_output = ?,
                repository_context_mode = ?,
                repository_commit = ?,
                error = NULL,
                completed_at = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE profile_id = ? AND pull_request_id = ?
            `).run(
          result.durationMs,
          JSON.stringify(result.review.findings),
          JSON.stringify(result.usage),
          JSON.stringify(metrics),
          JSON.stringify(result.rawOutput),
          result.repositoryContextMode,
          result.repositoryCommit,
          new Date().toISOString(),
          profile.id,
          pr.id,
        );
        await reconcileSkillComparisons(repository, pr, profile);
      } catch (error) {
        throwIfWorkflowCancelled(error);
        const message = error instanceof Error ? error.message : String(error);
        if (pr) {
          db.prepare(`
            INSERT INTO baseline_profile_results (
              profile_id, pull_request_id, status, error, updated_at
            ) VALUES (?, ?, 'failed', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(profile_id, pull_request_id) DO UPDATE SET
              status = 'failed',
              error = excluded.error,
              completed_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          `).run(profile.id, pr.id, message);
        }
        errors.push(`${profileLabel(profile)} / PR ${pr ? `#${pr.number}` : pullRequestId}: ${message}`);
      } finally {
        completed += 1;
        db.prepare(
          "UPDATE workflow_tasks SET current_item = ?, status_message = ? WHERE id = ?",
        ).run(
          completed,
          `Running ${concurrency} parallel baseline result units · ${completed}/${units.length} complete`,
          task.id,
        );
      }
    }
  }

  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, units.length) },
      () => reviewNextUnit(),
    ),
  );
  throwIfWorkflowCancelled();
  const rejectedWorker = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejectedWorker) throw rejectedWorker.reason;
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${units.length} baseline result units failed:\n${errors.join("\n")}`,
    );
  }
}

async function processBaseline(
  task: WorkflowTask,
  repository: RepositoryRecord,
) {
  const payload = JSON.parse(task.payload_json ?? "{}") as {
    concurrency?: number;
    profileIds?: number[];
    localRepoPath?: string | null;
    localRepoBranch?: string | null;
  };
  const concurrency = Math.max(
    1,
    Math.min(20, payload.concurrency ?? repository.baseline_concurrency ?? 5),
  );
  if (payload.profileIds?.length) {
    const reviewRepository =
      "localRepoPath" in payload
        ? {
            ...repository,
            local_repo_path: payload.localRepoPath ?? null,
            local_repo_branch: payload.localRepoBranch ?? null,
          }
        : repository;
    await processBaselineProfiles(
      task,
      reviewRepository,
      [...new Set(payload.profileIds)],
      concurrency,
    );
    return;
  }
  await processLegacyBaseline(task, repository);
}

async function processNamedSkillEval(
  task: WorkflowTask,
  repository: RepositoryRecord,
  payload: {
    concurrency?: number;
    skillIds: number[];
    model: string;
    modelSecondary: string;
    contextTier: string;
    localRepoPath?: string | null;
    localRepoBranch?: string | null;
  },
) {
  const db = getDb();
  const reviewRepository =
    "localRepoPath" in payload
      ? {
          ...repository,
          local_repo_path: payload.localRepoPath ?? null,
          local_repo_branch: payload.localRepoBranch ?? null,
        }
      : repository;
  const requestedPrIds = JSON.parse(task.pr_ids_json) as number[];
  const skillIds = [...new Set(payload.skillIds)];
  const placeholders = skillIds.map(() => "?").join(",");
  const skills = db
    .prepare(`
      SELECT * FROM personal_review_skills
      WHERE repository_id = ? AND active = 1 AND id IN (${placeholders})
    `)
    .all(repository.id, ...skillIds) as PersonalReviewSkillRecord[];
  if (skills.length !== skillIds.length) {
    throw new Error("One or more queued personal skills no longer exist");
  }
  const concurrency = Math.max(
    1,
    Math.min(20, payload.concurrency ?? repository.baseline_concurrency ?? 5),
  );
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const orderedSkills = skillIds.map((skillId) => skillsById.get(skillId)!);
  const units = requestedPrIds.flatMap((pullRequestId) =>
    orderedSkills.map((skill) => ({ skill, pullRequestId })),
  );
  const parallelism = Math.min(concurrency, units.length);
  db.prepare(
    "UPDATE workflow_tasks SET total_items = ?, status_message = ? WHERE id = ?",
  ).run(
    units.length,
    `Starting ${parallelism} parallel personal skill result units`,
    task.id,
  );
  const root = taskRoot(task.id);
  await fs.mkdir(root, { recursive: true });
  const preparedSkills = new Map<
    number,
    { root: string | null; error: string | null }
  >();
  await Promise.all(
    skills.map(async (skill) => {
      try {
        preparedSkills.set(skill.id, {
          root: await prepareSkillRoot(
            skill.path,
            path.join(root, `skill-${skill.id}`),
          ),
          error: null,
        });
      } catch (error) {
        preparedSkills.set(skill.id, {
          root: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  let nextIndex = 0;
  let completed = 0;
  const errors: string[] = [];

  async function reviewNextUnit() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= units.length) return;
      const { skill, pullRequestId } = units[index];
      const pr = db
        .prepare(`
          SELECT id, number, title, url, dataset_path, defect_description,
            baseline_status, baseline_duration_ms, baseline_findings_json
          FROM pull_requests
          WHERE id = ? AND repository_id = ? AND active = 1
        `)
        .get(pullRequestId, repository.id) as WorkflowPr | undefined;
      try {
        if (!pr) throw new Error(`Pull request ${pullRequestId} is unavailable`);
        const previous = db
          .prepare(`
            SELECT status, error
            FROM personal_skill_results
            WHERE skill_id = ? AND pull_request_id = ?
              AND model = ? AND model_secondary = ? AND context_tier = ?
          `)
          .get(
            skill.id,
            pr.id,
            payload.model,
            payload.modelSecondary,
            payload.contextTier,
          ) as { status: string; error: string | null } | undefined;
        if (previous?.status === "completed") continue;
        if (previous?.status === "failed") {
          errors.push(
            `${skill.name} / PR #${pr.number}: ${previous.error ?? "Previous attempt failed"}`,
          );
          continue;
        }
        db.prepare(`
          INSERT INTO personal_skill_results (
            skill_id, pull_request_id, baseline_profile_id, model,
            model_secondary, context_tier, status, repository_context_mode
          ) VALUES (?, ?, NULL, ?, ?, ?, 'running', ?)
          ON CONFLICT(
            skill_id, pull_request_id, model, model_secondary, context_tier
          ) DO UPDATE SET
            baseline_profile_id = NULL,
            status = 'running',
            duration_ms = NULL,
            findings_json = NULL,
            usage_json = NULL,
            metrics_json = NULL,
            raw_output_json = NULL,
            repository_context_mode = excluded.repository_context_mode,
            repository_commit = NULL,
            error = NULL,
            report_path = NULL,
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          skill.id,
          pr.id,
          payload.model,
          payload.modelSecondary,
          payload.contextTier,
          reviewRepository.local_repo_path ? "local_repo" : "diff",
        );
        const prepared = preparedSkills.get(skill.id);
        if (!prepared?.root) {
          throw new Error(prepared?.error ?? "Skill path could not be prepared");
        }
        const preparedSkillRoot = prepared.root;
        const skillDirectory = path.join(root, `skill-${skill.id}`);
        const result = await runSnapshotReviews({
          repository: reviewRepository,
          pr,
          root: skillDirectory,
          workspacePrefix: `pr-${pr.number}-skill`,
          model: payload.model,
          modelSecondary: payload.modelSecondary,
          contextTier: payload.contextTier,
          skillRoot: preparedSkillRoot,
          skillName: path.basename(skill.path),
        });
        const truth = await loadGroundTruth(pr);
        const metrics = scoreReview(truth, result.review.findings);
        const reportPath = path.join(
          skillDirectory,
          `pr-${pr.number}-report.md`,
        );
        await writePersonalSkillReport({
          outputPath: reportPath,
          repository,
          pr,
          review: result.review,
          metrics,
          truth,
          durationMs: result.durationMs,
          skillName: skill.name,
        });
        db.prepare(`
              UPDATE personal_skill_results SET
                baseline_profile_id = NULL,
                status = 'completed',
                duration_ms = ?,
                findings_json = ?,
                usage_json = ?,
                metrics_json = ?,
                raw_output_json = ?,
                repository_context_mode = ?,
                repository_commit = ?,
                error = NULL,
                report_path = ?,
                completed_at = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE skill_id = ? AND pull_request_id = ? AND model = ?
                AND model_secondary = ? AND context_tier = ?
            `).run(
          result.durationMs,
          JSON.stringify(result.review.findings),
          JSON.stringify(result.usage),
          JSON.stringify(metrics),
          JSON.stringify(result.rawOutput),
          result.repositoryContextMode,
          result.repositoryCommit,
          reportPath,
          new Date().toISOString(),
          skill.id,
          pr.id,
          payload.model,
          payload.modelSecondary,
          payload.contextTier,
        );
      } catch (error) {
        throwIfWorkflowCancelled(error);
        const message = error instanceof Error ? error.message : String(error);
        if (pr) {
          db.prepare(`
            INSERT INTO personal_skill_results (
              skill_id, pull_request_id, baseline_profile_id, model,
              model_secondary, context_tier, status, error
            ) VALUES (?, ?, NULL, ?, ?, ?, 'failed', ?)
            ON CONFLICT(
              skill_id, pull_request_id, model, model_secondary, context_tier
            ) DO UPDATE SET
              baseline_profile_id = NULL,
              status = 'failed',
              error = excluded.error,
              completed_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            skill.id,
            pr.id,
            payload.model,
            payload.modelSecondary,
            payload.contextTier,
            message,
          );
        }
        errors.push(`${skill.name} / PR ${pr ? `#${pr.number}` : pullRequestId}: ${message}`);
      } finally {
        completed += 1;
        db.prepare(
          "UPDATE workflow_tasks SET current_item = ?, status_message = ? WHERE id = ?",
        ).run(
          completed,
          `Running ${concurrency} parallel personal skill result units · ${completed}/${units.length} complete`,
          task.id,
        );
      }
    }
  }

  const workers = await Promise.allSettled(
    Array.from(
      { length: parallelism },
      () => reviewNextUnit(),
    ),
  );
  throwIfWorkflowCancelled();
  const rejectedWorker = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejectedWorker) throw rejectedWorker.reason;
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${units.length} personal skill result units failed:\n${errors.join("\n")}`,
    );
  }
}

async function processSkillEval(
  task: WorkflowTask,
  repository: RepositoryRecord,
) {
  const payload = JSON.parse(task.payload_json ?? "{}") as {
    concurrency?: number;
    skillIds?: number[];
    model?: string;
    modelSecondary?: string;
    contextTier?: string;
    localRepoPath?: string | null;
    localRepoBranch?: string | null;
  };
  if (payload.skillIds?.length) {
    if (
      !payload.model ||
      !payload.modelSecondary ||
      !payload.contextTier
    ) {
      throw new Error("Named skill task is missing its configuration snapshot");
    }
    await processNamedSkillEval(task, repository, {
      concurrency: payload.concurrency,
      skillIds: payload.skillIds,
      model: payload.model,
      modelSecondary: payload.modelSecondary,
      contextTier: payload.contextTier,
      localRepoPath: payload.localRepoPath,
      localRepoBranch: payload.localRepoBranch,
    });
    return;
  }
  await processLegacySkillEval(task, repository);
}

export async function executeWorkflowTask(task: WorkflowTask) {
  const db = getDb();
  const repository = db
    .prepare("SELECT * FROM repositories WHERE id = ?")
    .get(task.repository_id) as RepositoryRecord | undefined;
  if (!repository) throw new Error("Repository configuration was not found");
  const controller = new AbortController();
  const cancellationTimer = setInterval(() => {
    if (workflowCancellationRequested(task.id)) controller.abort();
  }, 500);
  try {
    if (workflowCancellationRequested(task.id)) {
      throw new WorkflowCancellationError();
    }
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'running', started_at = ?, error = NULL
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), task.id);

    await runWithWorkflowCancellation(controller.signal, async () => {
      if (task.kind === "manual_pr") await processManualPr(task, repository);
      else if (task.kind === "baseline") await processBaseline(task, repository);
      else await processSkillEval(task, repository);
    });
    if (workflowCancellationRequested(task.id)) {
      throw new WorkflowCancellationError();
    }
    db.prepare(`
      UPDATE workflow_tasks
      SET status = 'completed', status_message = 'Complete', completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), task.id);
  } catch (error) {
    if (
      error instanceof WorkflowCancellationError ||
      workflowCancellationRequested(task.id)
    ) {
      controller.abort();
      resetCancelledTaskResults(task);
      db.prepare(`
        UPDATE workflow_tasks
        SET status = 'cancelled', status_message = 'Cancelled',
          error = NULL, completed_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), task.id);
      return;
    }
    throw error;
  } finally {
    clearInterval(cancellationTimer);
  }
}
