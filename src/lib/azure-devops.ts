import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import {
  findReusablePullRequests,
  type ExistingDatasetPullRequest,
} from "@/lib/dataset-preservation";
import { normalizeHumanFindings } from "@/lib/human-finding-normalization";
import { prDatasetDir, repositoryDatasetDir } from "@/lib/paths";
import { runCommand } from "@/lib/process";
import {
  parsePathFilters,
  reviewableChangedFilePaths,
} from "@/lib/repository-source";
import { humanFindingScorePoint, scoreHumanComment } from "@/lib/github";
import {
  beginDatasetScan,
  cachedScanOutcome,
  completeDatasetScan,
  recordCachedScan,
  recordScanOutcome,
  scanScope,
  type ScanCandidate,
} from "@/lib/scan-ledger";
import type {
  HumanFinding,
  RepositoryRecord,
  ReviewSnapshotManifest,
} from "@/lib/types";

type AzureIdentity = {
  id: string;
  displayName: string;
  uniqueName: string | null;
};

type AzurePullRequest = {
  pullRequestId: number;
  title: string;
  description: string | null;
  status: string;
  isDraft: boolean;
  creationDate: string;
  closedDate: string | null;
  sourceRefName: string;
  targetRefName: string;
  createdBy: AzureIdentity;
  lastMergeSourceCommit: { commitId: string };
  lastMergeTargetCommit: { commitId: string };
};

type AzureThread = {
  id: number;
  status: string | null;
  threadContext: {
    filePath?: string | null;
    rightFileStart?: { line?: number | null };
  } | null;
  pullRequestThreadContext?: {
    iterationContext?: {
      firstComparingIteration?: number | null;
      secondComparingIteration?: number | null;
    } | null;
    trackingCriteria?: {
      origFilePath?: string | null;
      origRightFileStart?: { line?: number | null } | null;
    } | null;
  } | null;
  comments: Array<{
    id: number;
    content: string | null;
    commentType: string;
    isDeleted: boolean;
    publishedDate: string;
    author: AzureIdentity;
  }>;
};

type AzurePullRequestIteration = {
  id: number;
  createdDate?: string | null;
  updatedDate?: string | null;
  sourceRefCommit?: { commitId?: string | null } | null;
  targetRefCommit?: { commitId?: string | null } | null;
  commonRefCommit?: { commitId?: string | null } | null;
};

type AzurePullRequestIterationChanges = {
  changeEntries: Array<{
    item: { path?: string | null };
    originalPath?: string | null;
  }>;
};

let azureCliInvocation:
  | Promise<{ command: string; prefixArgs: string[] }>
  | undefined;

function getAzureCliInvocation() {
  azureCliInvocation ??= (async () => {
    if (process.platform !== "win32") {
      return { command: "az", prefixArgs: [] };
    }
    const located = await runCommand("where.exe", ["az.cmd"], {
      timeoutMs: 10_000,
    });
    if (located.exitCode !== 0) {
      throw new Error("Azure CLI was not found on PATH.");
    }
    const launcher = located.stdout.split(/\r?\n/).find(Boolean);
    if (!launcher) throw new Error("Azure CLI launcher path was empty.");
    const python = path.resolve(path.dirname(launcher.trim()), "..", "python.exe");
    try {
      await fs.access(python);
    } catch {
      throw new Error(`Azure CLI Python runtime was not found at ${python}`);
    }
    return { command: python, prefixArgs: ["-IBm", "azure.cli"] };
  })();
  return azureCliInvocation;
}

async function runAzJson<T>(args: string[]): Promise<T> {
  const az = await getAzureCliInvocation();
  let lastError = "Azure DevOps CLI command failed";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await runCommand(
      az.command,
      [...az.prefixArgs, ...args, "--output", "json", "--only-show-errors"],
      { timeoutMs: 180_000 },
    );
    if (result.exitCode === 0) {
      return JSON.parse(result.stdout) as T;
    }
    lastError = result.stderr.trim() || lastError;
    const retryable =
      /need to run the login command|timed out|temporarily unavailable|locked/i.test(
        lastError,
      );
    if (!retryable || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  throw new Error(lastError);
}

async function ensureAzureDevOpsCli() {
  const az = await getAzureCliInvocation();
  const result = await runCommand(
    az.command,
    [
      ...az.prefixArgs,
      "extension",
      "show",
      "--name",
      "azure-devops",
      "--only-show-errors",
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "Azure DevOps CLI extension is required. Run `az extension add --name azure-devops`.",
    );
  }
}

async function ensureMirror(repository: RepositoryRecord) {
  const mirror = path.join(repositoryDatasetDir(repository.slug), "_repository");
  try {
    if ((await fs.stat(path.join(mirror, ".git"))).isDirectory()) return mirror;
  } catch {
    // Clone below.
  }
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  const result = await runCommand(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", repository.clone_url, mirror],
    { timeoutMs: 30 * 60 * 1000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Unable to clone Azure DevOps repository");
  }
  return mirror;
}

let mirrorOperationQueue = Promise.resolve();

function withMirrorOperationLock<T>(operation: () => Promise<T>) {
  const result = mirrorOperationQueue.then(operation, operation);
  mirrorOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function prepareDiff(
  mirror: string,
  sourceCommit: string,
  targetCommit: string,
  changedFiles: string[],
) {
  return withMirrorOperationLock(async () => {
    const fetch = await runCommand(
      "git",
      [
        "-C",
        mirror,
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "origin",
        sourceCommit,
        targetCommit,
      ],
      { timeoutMs: 15 * 60 * 1000 },
    );
    if (fetch.exitCode !== 0) {
      throw new Error(fetch.stderr.trim() || "Unable to fetch PR commits");
    }
    const pathArgs = ["--", ...changedFiles];
    const names = await runCommand(
      "git",
      [
        "-C",
        mirror,
        "diff",
        "--name-only",
        targetCommit,
        sourceCommit,
        ...pathArgs,
      ],
      { timeoutMs: 5 * 60 * 1000 },
    );
    if (names.exitCode !== 0) {
      throw new Error(names.stderr.trim() || "Unable to list PR changes");
    }
    const files = names.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (files.length === 0) return { files, diff: "" };
    const diff = await runCommand(
      "git",
      [
        "-C",
        mirror,
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=80",
        targetCommit,
        sourceCommit,
        ...pathArgs,
      ],
      { timeoutMs: 10 * 60 * 1000 },
    );
    if (diff.exitCode !== 0) {
      throw new Error(diff.stderr.trim() || "Unable to generate PR diff");
    }
    return { files, diff: diff.stdout };
  });
}

async function getPullRequestIterations(
  repository: RepositoryRecord,
  prNumber: number,
) {
  const iterations = await runAzJson<{ value: AzurePullRequestIteration[] }>([
    "devops",
    "invoke",
    "--organization",
    repository.organization_url!,
    "--area",
    "git",
    "--resource",
    "pullRequestIterations",
    "--route-parameters",
    `project=${repository.project_name}`,
    `repositoryId=${repository.repository_name}`,
    `pullRequestId=${prNumber}`,
    "--api-version",
    "7.1",
  ]);
  const ordered = [...(iterations.value ?? [])].sort(
    (left, right) => left.id - right.id,
  );
  if (ordered.length === 0) {
    throw new Error(`Azure DevOps returned no iterations for PR #${prNumber}`);
  }
  return ordered;
}

async function getPullRequestChangedFiles(
  repository: RepositoryRecord,
  prNumber: number,
  iterationId: number,
) {
  const changes = await runAzJson<AzurePullRequestIterationChanges>([
    "devops",
    "invoke",
    "--organization",
    repository.organization_url!,
    "--area",
    "git",
    "--resource",
    "pullRequestIterationChanges",
    "--route-parameters",
    `project=${repository.project_name}`,
    `repositoryId=${repository.repository_name}`,
    `pullRequestId=${prNumber}`,
    `iterationId=${iterationId}`,
    "--api-version",
    "7.1",
  ]);
  return [
    ...new Set(
      (changes.changeEntries ?? [])
        .flatMap((entry) => [entry.item.path, entry.originalPath])
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.replace(/^\/+/, "")),
    ),
  ];
}

async function getThreads(repository: RepositoryRecord, prNumber: number) {
  const response = await runAzJson<{ value: AzureThread[] }>([
    "devops",
    "invoke",
    "--organization",
    repository.organization_url!,
    "--area",
    "git",
    "--resource",
    "pullRequestThreads",
    "--route-parameters",
    `project=${repository.project_name}`,
    `repositoryId=${repository.repository_name}`,
    `pullRequestId=${prNumber}`,
    "--api-version",
    "7.1",
  ]);
  return response.value ?? [];
}

function isHumanIdentity(identity: AzureIdentity) {
  return Boolean(identity.uniqueName) && !/bot|gitops|build|service/i.test(
    `${identity.displayName} ${identity.uniqueName}`,
  );
}

function sameIdentity(left: AzureIdentity, right: AzureIdentity) {
  if (left.id && right.id && left.id === right.id) return true;
  return Boolean(
    left.uniqueName &&
      right.uniqueName &&
      left.uniqueName.toLowerCase() === right.uniqueName.toLowerCase(),
  );
}

export function isExplicitOwnerConfirmation(body: string) {
  const normalized = body.trim();
  if (
    /\b(not an issue|by design|expected behavior|should be possible|already covered|no change needed|works as intended)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /\b(good|great|excellent)\s+catch\b/i.test(normalized) ||
    /\byou(?:'re| are)\s+right\b/i.test(normalized) ||
    /\bi\s+agree\b/i.test(normalized) ||
    /\b(valid|real)\s+(issue|bug|finding)\b/i.test(normalized) ||
    /\bthank(?:s| you)\b.{0,40}\b(catch|finding|spotting|reporting)\b/i.test(
      normalized,
    ) ||
    /\b(will fix|will address|fixed|addressed|corrected)\b/i.test(normalized)
  );
}

export function azureHumanFindings(
  pr: AzurePullRequest,
  threads: AzureThread[],
  filters: string[],
  iterations: AzurePullRequestIteration[] = [],
): HumanFinding[] {
  const findings: HumanFinding[] = [];
  for (const thread of threads) {
    const threadPath =
      (
        thread.pullRequestThreadContext?.trackingCriteria?.origFilePath ??
        thread.threadContext?.filePath
      )?.replace(/^\/+/, "") ?? null;
    if (filters.length > 0 && !threadPath) {
      continue;
    }
    const line =
      thread.pullRequestThreadContext?.trackingCriteria?.origRightFileStart
        ?.line ??
      thread.threadContext?.rightFileStart?.line ??
      null;
    const comments = (thread.comments ?? []).filter(
      (comment) =>
        !comment.isDeleted &&
        comment.commentType === "text" &&
        Boolean(comment.content) &&
        isHumanIdentity(comment.author),
    );
    for (let index = 0; index < comments.length; index += 1) {
      const comment = comments[index];
      if (
        sameIdentity(comment.author, pr.createdBy) ||
        !comments
          .slice(index + 1)
          .some(
            (reply) =>
              sameIdentity(reply.author, pr.createdBy) &&
              isExplicitOwnerConfirmation(reply.content ?? ""),
          )
      ) {
        continue;
      }
      const content = comment.content!;
      const mapped = {
        id: Number(`${thread.id}${comment.id}`),
        body: content,
        html_url: `${pr.pullRequestId}/thread/${thread.id}`,
        created_at: comment.publishedDate,
        author_association: "MEMBER",
        user: {
          login: comment.author.displayName,
          type: "User",
        },
        path: threadPath ?? undefined,
        line,
        original_line: line,
      };
      const value = scoreHumanComment(mapped, pr.createdBy.displayName);
      if (
        value.score < 2 ||
        humanFindingScorePoint(content.trim()) === 0
      ) {
        continue;
      }
      const contextIteration =
        thread.pullRequestThreadContext?.iterationContext
          ?.secondComparingIteration;
      const publishedAt = new Date(comment.publishedDate).getTime();
      const datedIteration = [...iterations]
        .filter((iteration) => {
          const date = iteration.updatedDate ?? iteration.createdDate;
          return date && new Date(date).getTime() <= publishedAt;
        })
        .sort((left, right) => right.id - left.id)[0];
      const finalIteration = iterations.at(-1);
      const iteration =
        (contextIteration == null
          ? undefined
          : iterations.find((candidate) => candidate.id === contextIteration)) ??
        datedIteration ??
        finalIteration;
      findings.push({
        id: `azure-thread-${thread.id}-comment-${comment.id}`,
        source: "review_comment",
        author: comment.author.displayName,
        authorAssociation: "MEMBER",
        body: content.trim(),
        path: threadPath,
        line,
        originalLine: line,
        url: mapped.html_url,
        createdAt: comment.publishedDate,
        valueScore: value.score,
        valueReasons: [...value.reasons, "pr-owner-confirmed"],
        scorePoint: 1,
        iterationId: iteration?.id ?? null,
        iterationSourceCommit:
          iteration?.sourceRefCommit?.commitId ??
          pr.lastMergeSourceCommit.commitId,
        iterationTargetCommit:
          iteration?.commonRefCommit?.commitId ??
          iteration?.targetRefCommit?.commitId ??
          pr.lastMergeTargetCommit.commitId,
        iterationResolution:
          contextIteration != null && iteration?.id === contextIteration
            ? "thread-context"
            : datedIteration
              ? "published-date"
              : "final",
      });
      break;
    }
  }
  return findings;
}

function publicPr(
  repository: RepositoryRecord,
  pr: AzurePullRequest,
  files: string[],
  iteration?: {
    id: number;
    sourceCommit: string;
    targetCommit: string;
    isFinal: boolean;
  },
) {
  return {
    number: pr.pullRequestId,
    title: pr.title,
    url: `${repository.organization_url}/${encodeURIComponent(repository.project_name!)}/_git/${encodeURIComponent(repository.repository_name)}/pullrequest/${pr.pullRequestId}`,
    body: pr.description,
    author: pr.createdBy.displayName,
    base: {
      ref: pr.targetRefName.replace(/^refs\/heads\//, ""),
      sha: iteration?.targetCommit ?? pr.lastMergeTargetCommit.commitId,
    },
    head: {
      ref: pr.sourceRefName.replace(/^refs\/heads\//, ""),
      sha: iteration?.sourceCommit ?? pr.lastMergeSourceCommit.commitId,
    },
    reviewIteration: iteration ?? null,
    mergedAt: pr.closedDate,
    updatedAt: pr.closedDate ?? pr.creationDate,
    additions: 0,
    deletions: 0,
    changedFiles: files.length,
  };
}

async function saveSnapshot(
  repository: RepositoryRecord,
  pr: AzurePullRequest,
  destination: string,
  requireHumanFindings: boolean,
  precomputedFindings?: HumanFinding[],
) {
  const filters = parsePathFilters(repository.path_filter);
  const mirror = await ensureMirror(repository);
  const iterations = await getPullRequestIterations(
    repository,
    pr.pullRequestId,
  );
  const finalIteration = iterations.at(-1)!;
  const existingNormalized = new Map<string, string>();
  try {
    const existing = JSON.parse(
      await fs.readFile(path.join(destination, "human-findings.json"), "utf8"),
    ) as HumanFinding[];
    for (const finding of existing) {
      if (finding.normalizedBody?.trim()) {
        existingNormalized.set(finding.id, finding.normalizedBody);
      }
    }
  } catch {
    // New and legacy-incomplete snapshots have no normalization to reuse.
  }
  let findings = requireHumanFindings
    ? precomputedFindings ??
      azureHumanFindings(
        pr,
        await getThreads(repository, pr.pullRequestId),
        filters,
        iterations,
      )
    : [];
  findings = findings.map((finding) => ({
    ...finding,
    normalizedBody:
      finding.normalizedBody ?? existingNormalized.get(finding.id),
  }));
  if (
    requireHumanFindings &&
    !findings.some((finding) => finding.scorePoint === 1)
  ) {
    return null;
  }
  const selectedIterationIds = new Set(
    findings
      .filter((finding) => (finding.scorePoint ?? 1) === 1)
      .map((finding) => finding.iterationId)
      .filter((id): id is number => id != null),
  );
  selectedIterationIds.add(finalIteration.id);
  const manifest: ReviewSnapshotManifest = { version: 1, snapshots: [] };
  const normalizedFindings: HumanFinding[] = [];
  let finalSnapshot:
    | {
        metadata: ReturnType<typeof publicPr>;
        files: string[];
        diff: string;
      }
    | undefined;
  for (const iteration of iterations) {
    if (!selectedIterationIds.has(iteration.id)) continue;
    const sourceCommit =
      iteration.sourceRefCommit?.commitId ??
      (iteration.id === finalIteration.id
        ? pr.lastMergeSourceCommit.commitId
        : null);
    const targetCommit =
      iteration.commonRefCommit?.commitId ??
      iteration.targetRefCommit?.commitId ??
      (iteration.id === finalIteration.id
        ? pr.lastMergeTargetCommit.commitId
        : null);
    if (!sourceCommit || !targetCommit) {
      throw new Error(
        `Azure DevOps iteration ${iteration.id} is missing source or target commit metadata`,
      );
    }
    const iterationFindings = findings.filter(
      (finding) => finding.iterationId === iteration.id,
    );
    const changedFiles = reviewableChangedFilePaths(
      await getPullRequestChangedFiles(
        repository,
        pr.pullRequestId,
        iteration.id,
      ),
      iterationFindings.map((finding) => finding.path),
      filters,
    );
    if (changedFiles.length === 0) continue;
    const changes = await prepareDiff(
      mirror,
      sourceCommit,
      targetCommit,
      changedFiles,
    );
    if (changes.files.length === 0) continue;
    const isFinal = iteration.id === finalIteration.id;
    const metadata = publicPr(repository, pr, changes.files, {
      id: iteration.id,
      sourceCommit,
      targetCommit,
      isFinal,
    });
    const normalized = requireHumanFindings
      ? await normalizeHumanFindings({
          repository,
          prNumber: pr.pullRequestId,
          prMetadata: metadata,
          diff: changes.diff,
          findings: iterationFindings,
        })
      : [];
    normalizedFindings.push(...normalized);
    const relativePath = path.join("iterations", `iteration-${iteration.id}`);
    const snapshotPath = path.join(destination, relativePath);
    await fs.mkdir(snapshotPath, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(snapshotPath, "pr.json"),
        JSON.stringify(metadata, null, 2),
      ),
      fs.writeFile(
        path.join(snapshotPath, "files.json"),
        JSON.stringify(
          changes.files.map((filename) => ({ filename })),
          null,
          2,
        ),
      ),
      fs.writeFile(path.join(snapshotPath, "diff.patch"), changes.diff),
      fs.writeFile(
        path.join(snapshotPath, "human-findings.json"),
        JSON.stringify(normalized, null, 2),
      ),
    ]);
    manifest.snapshots.push({
      key: `iteration-${iteration.id}`,
      iterationId: iteration.id,
      sourceCommit,
      targetCommit,
      isFinal,
      relativePath,
      findingIds: normalized.map((finding) => finding.id),
    });
    if (isFinal) {
      finalSnapshot = {
        metadata,
        files: changes.files,
        diff: changes.diff,
      };
    }
  }
  if (!finalSnapshot) return null;
  await fs.mkdir(destination, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(destination, "pr.json"),
      JSON.stringify(finalSnapshot.metadata, null, 2),
    ),
    fs.writeFile(
      path.join(destination, "files.json"),
      JSON.stringify(
        finalSnapshot.files.map((filename) => ({ filename })),
        null,
        2,
      ),
    ),
    fs.writeFile(path.join(destination, "diff.patch"), finalSnapshot.diff),
    fs.writeFile(
      path.join(destination, "review-snapshots.json"),
      JSON.stringify(manifest, null, 2),
    ),
    requireHumanFindings
      ? fs.writeFile(
          path.join(destination, "human-findings.json"),
          JSON.stringify(normalizedFindings, null, 2),
        )
      : Promise.resolve(),
  ]);
  return {
    metadata: finalSnapshot.metadata,
    findings: normalizedFindings,
  };
}

export async function collectAzurePullRequestSnapshot(
  repository: RepositoryRecord,
  number: number,
  destination: string,
) {
  const saved = await refreshAzurePullRequestIterationSnapshots(
    repository,
    number,
    destination,
    false,
  );
  if (!saved) {
    throw new Error("The PR has no changed files under the configured path filter.");
  }
  return saved.metadata;
}

export async function refreshAzurePullRequestIterationSnapshots(
  repository: RepositoryRecord,
  number: number,
  destination: string,
  requireHumanFindings: boolean,
) {
  await ensureAzureDevOpsCli();
  const pr = await runAzJson<AzurePullRequest>([
    "repos",
    "pr",
    "show",
    "--organization",
    repository.organization_url!,
    "--id",
    String(number),
  ]);
  return saveSnapshot(
    repository,
    pr,
    destination,
    requireHumanFindings,
  );
}

export async function collectAzurePullRequestBenchmarkSnapshot(
  repository: RepositoryRecord,
  number: number,
  destination: string,
) {
  const saved = await refreshAzurePullRequestIterationSnapshots(
    repository,
    number,
    destination,
    true,
  );
  if (!saved) {
    getDb()
      .prepare(`
        UPDATE pull_requests
        SET active = 0, selected = 0
        WHERE repository_id = ? AND number = ? AND manual = 0
      `)
      .run(repository.id, number);
    throw new Error(
      "The PR has no owner-confirmed valued findings or reviewable changed files.",
    );
  }
  return saved;
}

export async function syncAzureRepositoryDataset(repository: RepositoryRecord) {
  await ensureAzureDevOpsCli();
  const db = getDb();
  db.prepare(
    "UPDATE repositories SET status = 'syncing', status_message = ?, scan_current = 0, scan_total = 0, collected_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run("Loading recent Azure DevOps pull requests", repository.id);
  const filters = parsePathFilters(repository.path_filter);
  const scope = scanScope(repository, filters);
  const scanRunId = beginDatasetScan(repository, scope);
  const existing = db
    .prepare(`
      SELECT id, number, dataset_path, defect_description, url
      FROM pull_requests
      WHERE repository_id = ? AND manual = 0 AND excluded_by_user = 0
    `)
    .all(repository.id) as ExistingDatasetPullRequest[];
  const excludedNumbers = new Set(
    (
      db
        .prepare(`
          SELECT number
          FROM pull_requests
          WHERE repository_id = ? AND excluded_by_user = 1
        `)
        .all(repository.id) as Array<{ number: number }>
    ).map((row) => row.number),
  );
  const preserved = await findReusablePullRequests(existing, filters);
  const preserveExisting = db.transaction(() => {
    db.prepare(
      "UPDATE pull_requests SET active = 0 WHERE repository_id = ? AND manual = 0",
    ).run(repository.id);
    const reactivate = db.prepare(
      "UPDATE pull_requests SET active = 1 WHERE id = ?",
    );
    for (const pullRequest of preserved) reactivate.run(pullRequest.id);
  });
  preserveExisting();
  let savedCount = preserved.length;
  const preservedNumbers = new Set(
    preserved.map((pullRequest) => pullRequest.number),
  );
  db.prepare(
    "UPDATE repositories SET status_message = ?, collected_count = ? WHERE id = ?",
  ).run(
    preserved.length > 0
      ? `Preserved ${preserved.length} existing eligible PRs; loading recent Azure DevOps pull requests`
      : "Loading recent Azure DevOps pull requests",
    savedCount,
    repository.id,
  );
  const root = repositoryDatasetDir(repository.slug);
  await fs.mkdir(root, { recursive: true });
  const prs = await runAzJson<AzurePullRequest[]>([
    "repos",
    "pr",
    "list",
    "--organization",
    repository.organization_url!,
    "--project",
    repository.project_name!,
    "--repository",
    repository.repository_name,
    "--status",
    "completed",
    "--top",
    String(repository.scan_limit),
  ]);
  prs.sort(
    (left, right) =>
      new Date(right.closedDate ?? 0).getTime() -
      new Date(left.closedDate ?? 0).getTime(),
  );
  db.prepare(
    "UPDATE repositories SET status_message = ?, scan_total = ? WHERE id = ?",
  ).run(
    "Preparing filtered repository mirror; the first run can take several minutes",
    prs.length,
    repository.id,
  );
  await ensureMirror(repository);
  let scanned = 0;

  const scanConcurrency = 10;
  for (
    let offset = 0;
    offset < prs.length && savedCount < repository.target_prs;
    offset += scanConcurrency
  ) {
    const batch = prs.slice(offset, offset + scanConcurrency);
    db.prepare(
      "UPDATE repositories SET status_message = ?, scan_current = ?, collected_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(
      `${filters.length > 0 ? "Checking in-folder" : "Checking"} human comments in PRs ${offset + 1}-${offset + batch.length} with ${scanConcurrency} parallel workers`,
      scanned,
      savedCount,
      repository.id,
    );
    const candidates = await Promise.all(
      batch.map(async (pr) => {
        const scanCandidate: ScanCandidate = {
          number: pr.pullRequestId,
          sourceUpdatedAt: pr.closedDate,
          sourceCommit: pr.lastMergeSourceCommit.commitId,
        };
        if (
          preservedNumbers.has(pr.pullRequestId) ||
          excludedNumbers.has(pr.pullRequestId)
        ) {
          return null;
        }
        const cached = cachedScanOutcome(scope, scanCandidate);
        if (cached) {
          recordCachedScan(scanRunId, scope, scanCandidate);
          return null;
        }
        if (pr.isDraft || !pr.closedDate) {
          recordScanOutcome(
            scanRunId,
            scope,
            scanCandidate,
            "ignored",
            0,
          );
          return null;
        }
        const [threads, iterations] = await Promise.all([
          getThreads(repository, pr.pullRequestId),
          getPullRequestIterations(repository, pr.pullRequestId),
        ]);
        const findings = azureHumanFindings(pr, threads, filters, iterations);
        const findingCount = findings.filter(
          (finding) => finding.scorePoint === 1,
        ).length;
        if (findingCount === 0) {
          recordScanOutcome(
            scanRunId,
            scope,
            scanCandidate,
            "ineligible",
            0,
          );
          return null;
        }
        return { pr, findings, scanCandidate };
      }),
    );
    scanned += batch.length;
    db.prepare(
      "UPDATE repositories SET scan_current = ? WHERE id = ?",
    ).run(scanned, repository.id);

    const remainingSlots = repository.target_prs - savedCount;
    const eligibleCandidates = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate),
      )
      .slice(0, remainingSlots);
    if (eligibleCandidates.length > 0) {
      db.prepare(
        "UPDATE repositories SET status_message = ? WHERE id = ?",
      ).run(
        `Downloading diffs and normalizing ${eligibleCandidates.length} eligible PRs in parallel`,
        repository.id,
      );
    }
    const processedCandidates = await Promise.all(
      eligibleCandidates.map(async (candidate) => {
        const destination = prDatasetDir(
          repository.slug,
          candidate.pr.pullRequestId,
        );
        const saved = await saveSnapshot(
          repository,
          candidate.pr,
          destination,
          true,
          candidate.findings,
        );
        return { candidate, destination, saved };
      }),
    );

    for (const { candidate, destination, saved } of processedCandidates) {
      if (!saved) {
        recordScanOutcome(
          scanRunId,
          scope,
          candidate.scanCandidate,
          "ineligible",
          0,
        );
        continue;
      }
      const metadata = saved.metadata;
      const findingCount = saved.findings.filter(
        (finding) => finding.scorePoint === 1,
      ).length;
      db.prepare(`
      INSERT INTO pull_requests (
        repository_id, number, title, url, author, base_ref, head_ref,
        merged_at, updated_at, additions, deletions, changed_files,
        valued_comment_count, dataset_path, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, number) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        author = excluded.author,
        base_ref = excluded.base_ref,
        head_ref = excluded.head_ref,
        merged_at = excluded.merged_at,
        updated_at = excluded.updated_at,
        changed_files = excluded.changed_files,
        valued_comment_count = excluded.valued_comment_count,
        dataset_path = excluded.dataset_path,
        raw_json = excluded.raw_json,
        active = CASE
          WHEN pull_requests.excluded_by_user = 1 THEN 0
          ELSE 1
        END
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
        0,
        0,
        metadata.changedFiles,
        findingCount,
        destination,
        JSON.stringify(metadata),
      );
      recordScanOutcome(
        scanRunId,
        scope,
        candidate.scanCandidate,
        "eligible",
        findingCount,
      );
      savedCount += 1;
      db.prepare(
        "UPDATE repositories SET collected_count = ? WHERE id = ?",
      ).run(savedCount, repository.id);
    }
  }
  db.prepare(`
    UPDATE pull_requests
    SET active = 0, selected = 0
    WHERE repository_id = ? AND manual = 0 AND valued_comment_count = 0
  `).run(repository.id);
  completeDatasetScan(scanRunId, savedCount);
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        repository: repository.slug,
        provider: "azure-devops",
        pathFilter: repository.path_filter,
        generatedAt: new Date().toISOString(),
        scanRunId,
        scannedPullRequests: scanned,
        eligiblePullRequests: savedCount,
      },
      null,
      2,
    ),
  );
  db.prepare(
    "UPDATE repositories SET status = 'ready', status_message = ?, scan_current = ?, scan_total = ?, collected_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(
    `Collected ${savedCount} PRs after scanning ${scanned}${repository.path_filter ? ` under ${repository.path_filter}` : ""}`,
    scanned,
    scanned,
    savedCount,
    repository.id,
  );
}
