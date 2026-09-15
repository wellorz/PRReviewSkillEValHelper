import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "@/lib/process";
import type { ModelFinding, ReviewOutput } from "@/lib/types";

const DEVLOOP_BACKEND_URL = "http://127.0.0.1:8000";
const DEVLOOP_RUNNER_RELATIVE_PATH = path.join(
  ".github",
  "skills",
  "devloop-pr-review",
  "scripts",
  "run_review.py",
);

type DevLoopComment = {
  id: string;
  file: string | null;
  line: number | null;
  severity: "nit" | "suggestion" | "concern";
  body: string;
  reviewerModels: Array<string | null> | null;
  reviewerIds: string[] | null;
};

type DevLoopReview = {
  comments: DevLoopComment[];
  reviewerModels: Array<string | null> | null;
  reviewedSha: string;
  baseSha: string;
  reviewedIteration: number | null;
  publishRequested: boolean;
  prId: number;
};

export type DevLoopExecutionEvidence = {
  reviewedSha: string;
  baseSha: string;
  reviewedIteration: number;
  reviewerModels: string[];
  publishRequested: false;
  savedModels: string[];
  evaluationRunPath: string;
};

type DevLoopResponse = {
  review: DevLoopReview;
  savedModels: string[];
  evaluationRunPath: string;
};

type ExpectedDevLoopReview = {
  prId: number;
  sourceCommit: string;
  targetCommit: string;
  iterationId: number;
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseDevLoopResponse(raw: string): DevLoopResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch (error) {
    throw new Error("DevLoop runner returned invalid JSON", { cause: error });
  }
  if (!value || typeof value !== "object") {
    throw new Error("DevLoop runner response was not an object");
  }
  const object = value as Record<string, unknown>;
  const review = object.review;
  if (!review || typeof review !== "object") {
    throw new Error("DevLoop runner response did not contain a review");
  }
  const reviewObject = review as Record<string, unknown>;
  if (!Array.isArray(reviewObject.comments)) {
    throw new Error("DevLoop review did not contain comments");
  }
  const comments = reviewObject.comments.map((comment, index) => {
    if (!comment || typeof comment !== "object") {
      throw new Error(`DevLoop comment ${index + 1} was invalid`);
    }
    const item = comment as Record<string, unknown>;
    if (
      typeof item.body !== "string" ||
      !["nit", "suggestion", "concern"].includes(String(item.severity))
    ) {
      throw new Error(`DevLoop comment ${index + 1} was incomplete`);
    }
    return {
      id: typeof item.id === "string" ? item.id : `comment-${index + 1}`,
      file: typeof item.file === "string" ? item.file : null,
      line: typeof item.line === "number" ? item.line : null,
      severity: item.severity as DevLoopComment["severity"],
      body: item.body,
      reviewerModels: Array.isArray(item.reviewerModels)
        ? item.reviewerModels.map((model) =>
            typeof model === "string" ? model : null,
          )
        : null,
      reviewerIds: Array.isArray(item.reviewerIds)
        ? stringArray(item.reviewerIds)
        : null,
    };
  });
  return {
    review: {
      comments,
      reviewerModels: Array.isArray(reviewObject.reviewerModels)
        ? reviewObject.reviewerModels.map((model) =>
            typeof model === "string" ? model : null,
          )
        : null,
      reviewedSha:
        typeof reviewObject.reviewedSha === "string"
          ? reviewObject.reviewedSha
          : "",
      baseSha:
        typeof reviewObject.baseSha === "string" ? reviewObject.baseSha : "",
      reviewedIteration:
        typeof reviewObject.reviewedIteration === "number"
          ? reviewObject.reviewedIteration
          : null,
      publishRequested: reviewObject.publishRequested === true,
      prId: typeof reviewObject.prId === "number" ? reviewObject.prId : 0,
    },
    savedModels: stringArray(object.savedModels),
    evaluationRunPath:
      typeof object.evaluationRunPath === "string"
        ? object.evaluationRunPath
        : "",
  };
}

function titleFromBody(body: string) {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!firstLine) return "DevLoop review finding";
  return firstLine.length <= 120
    ? firstLine
    : `${firstLine.slice(0, 117)}...`;
}

function adaptComment(comment: DevLoopComment): ModelFinding {
  const sourceModels = stringArray(comment.reviewerModels);
  const reviewers =
    comment.reviewerIds && comment.reviewerIds.length > 0
      ? comment.reviewerIds
      : sourceModels.map((model) => `DevLoop/${model}`);
  return {
    title: titleFromBody(comment.body),
    description: comment.body,
    severity:
      comment.severity === "concern"
        ? "high"
        : comment.severity === "suggestion"
          ? "medium"
          : "low",
    file: comment.file,
    lineStart: comment.line,
    lineEnd: comment.line,
    category: "correctness",
    confidence: 0.5,
    evidence: comment.body,
    reviewer: reviewers[0] ?? "DevLoop",
    reviewers,
    sourceModels,
    suggestion: null,
    verification: sourceModels.length > 1 ? "agreed" : "same-model",
    agreedBy: sourceModels,
  };
}

export function devLoopRunnerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedNames = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "ComSpec",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: source.NODE_ENV ?? "production",
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
  };
  for (const name of allowedNames) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

export async function validateDevLoopSkillPath(skillRoot: string) {
  const runnerPath = path.join(skillRoot, DEVLOOP_RUNNER_RELATIVE_PATH);
  try {
    if ((await fs.stat(runnerPath)).isFile()) return;
  } catch {
    // Report the stable configuration error below.
  }
  throw new Error(
    "devloop-local mode requires .github\\skills\\devloop-pr-review\\scripts\\run_review.py",
  );
}

export function adaptDevLoopReviewResponse(
  raw: string,
  expected: ExpectedDevLoopReview,
) {
  const response = parseDevLoopResponse(raw);
  const { review } = response;
  if (
    review.prId !== expected.prId ||
    review.reviewedSha.toLowerCase() !== expected.sourceCommit.toLowerCase() ||
    review.baseSha.toLowerCase() !== expected.targetCommit.toLowerCase() ||
    review.reviewedIteration !== expected.iterationId
  ) {
    throw new Error(
      "DevLoop returned a review for a different PR iteration or commit",
    );
  }
  if (review.publishRequested) {
    throw new Error("DevLoop unexpectedly requested publication");
  }
  if (
    response.savedModels.length === 0 ||
    stringArray(review.reviewerModels).length === 0
  ) {
    throw new Error("DevLoop did not report its saved/internal reviewer models");
  }
  if (!path.isAbsolute(response.evaluationRunPath)) {
    throw new Error("DevLoop returned an invalid evaluation run path");
  }
  const evidence: DevLoopExecutionEvidence = {
    reviewedSha: review.reviewedSha,
    baseSha: review.baseSha,
    reviewedIteration: review.reviewedIteration,
    reviewerModels: stringArray(review.reviewerModels),
    publishRequested: false,
    savedModels: response.savedModels,
    evaluationRunPath: response.evaluationRunPath,
  };
  const output: ReviewOutput = {
    summary: `DevLoop returned ${review.comments.length} finding(s) using ${evidence.reviewerModels.join(", ")}.`,
    findings: review.comments.map(adaptComment),
  };
  return { response, evidence, output };
}

export async function runNativeDevLoopReview(options: {
  workspace: string;
  skillRoot: string;
  expectedPrId: number;
  expectedSourceCommit: string;
  expectedTargetCommit: string;
  expectedIterationId: number;
}) {
  await validateDevLoopSkillPath(options.skillRoot);
  const runnerPath = path.join(
    options.skillRoot,
    DEVLOOP_RUNNER_RELATIVE_PATH,
  );
  const startedAt = performance.now();
  const result = await runCommand(
    "python",
    [
      runnerPath,
      "--snapshot",
      options.workspace,
      "--backend-url",
      DEVLOOP_BACKEND_URL,
    ],
    {
      cwd: options.workspace,
      env: devLoopRunnerEnvironment(),
      timeoutMs: 90 * 60 * 1000,
    },
  );
  const durationMs = Math.round(performance.now() - startedAt);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `DevLoop runner exited with code ${result.exitCode}`,
    );
  }
  const { response, evidence, output } = adaptDevLoopReviewResponse(
    result.stdout,
    {
      prId: options.expectedPrId,
      sourceCommit: options.expectedSourceCommit,
      targetCommit: options.expectedTargetCommit,
      iterationId: options.expectedIterationId,
    },
  );
  if (
    !(await fs.stat(response.evaluationRunPath).catch(() => null))?.isDirectory()
  ) {
    throw new Error("DevLoop returned an invalid evaluation run path");
  }
  return {
    output,
    durationMs,
    usage: {
      outerCopilot: null,
      internalUsageAvailable: false,
      reviewerModels: evidence.reviewerModels,
    },
    rawOutput: {
      stdout: result.stdout,
      stderr: result.stderr,
      response,
      executionEvidence: evidence,
    },
  };
}
