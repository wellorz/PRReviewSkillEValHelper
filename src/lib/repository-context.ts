import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  validateLocalRepositoryBranch,
  validateLocalRepositoryPath,
} from "@/lib/local-repository";
import { DATA_DIR } from "@/lib/paths";
import { runCommand } from "@/lib/process";
import type { RepositoryRecord } from "@/lib/types";

let gitAdministrationQueue = Promise.resolve();
const SHARED_WORKTREE_ROOT = path.join(
  os.tmpdir(),
  "pr-review-skill-eval-helper-worktrees",
);
const sharedWorktrees = new Map<
  string,
  {
    path: string;
    repositoryPath: string;
    references: number;
    ready: Promise<void>;
    cleanupTimer: NodeJS.Timeout | null;
  }
>();

async function serializeGitAdministration<T>(action: () => Promise<T>) {
  const previous = gitAdministrationQueue;
  let release = () => {};
  gitAdministrationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function assertSafeWorktreePath(worktreePath: string) {
  const workflowRoot = path.resolve(DATA_DIR, "workflow");
  const resolved = path.resolve(worktreePath);
  const relative = path.relative(workflowRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Historical worktree path must be under ${workflowRoot}: ${resolved}`,
    );
  }
  return resolved;
}

function sharedWorktreePath(repositoryPath: string, commit: string) {
  const key = createHash("sha256")
    .update(`${repositoryPath.toLowerCase()}\0${commit.toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(SHARED_WORKTREE_ROOT, key);
}

async function removeWorktree(repositoryPath: string, worktreePath: string) {
  const removeArgs = [
    "-C",
    repositoryPath,
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ];
  let remove = await runCommand("git", removeArgs, {
    timeoutMs: 10 * 60 * 1000,
  });
  if (
    remove.exitCode !== 0 &&
    /locked working tree|lock reason:/i.test(remove.stderr)
  ) {
    const unlock = await runCommand(
      "git",
      ["-C", repositoryPath, "worktree", "unlock", worktreePath],
      { timeoutMs: 30_000 },
    );
    if (unlock.exitCode !== 0 && !/not locked/i.test(unlock.stderr)) {
      throw new Error(
        unlock.stderr.trim() ||
          `Unable to unlock historical worktree ${worktreePath}`,
      );
    }
    remove = await runCommand(
      "git",
      [
        "-C",
        repositoryPath,
        "worktree",
        "remove",
        "--force",
        "--force",
        worktreePath,
      ],
      { timeoutMs: 10 * 60 * 1000 },
    );
  }
  if (
    remove.exitCode !== 0 &&
    /is not a working tree|is not a working tree directory/i.test(
      remove.stderr,
    )
  ) {
    await fs.rm(worktreePath, { recursive: true, force: true });
    await runCommand(
      "git",
      ["-C", repositoryPath, "worktree", "prune"],
      { timeoutMs: 30_000 },
    );
    return;
  }
  if (remove.exitCode !== 0 && (await fs.stat(worktreePath).catch(() => null))) {
    throw new Error(
      remove.stderr.trim() ||
        `Unable to remove historical worktree ${worktreePath}`,
    );
  }
}

async function addWorktree(
  repositoryPath: string,
  worktreePath: string,
  commit: string,
) {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  if (await fs.stat(worktreePath).catch(() => null)) {
    await removeWorktree(repositoryPath, worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  await runCommand(
    "git",
    ["-C", repositoryPath, "worktree", "prune"],
    { timeoutMs: 30_000 },
  );
  const add = await runCommand(
    "git",
    ["-C", repositoryPath, "worktree", "add", "--detach", worktreePath, commit],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (add.exitCode !== 0) {
    throw new Error(
      add.stderr.trim() ||
        `Unable to create historical worktree for commit ${commit}`,
    );
  }
}

async function switchWorktree(worktreePath: string, commit: string) {
  const checkout = await runCommand(
    "git",
    ["-C", worktreePath, "checkout", "--detach", "--force", commit],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (checkout.exitCode !== 0) {
    throw new Error(
      checkout.stderr.trim() ||
        `Unable to switch historical worktree to commit ${commit}`,
    );
  }
}

async function acquireSharedWorktree(
  repositoryPath: string,
  commit: string,
) {
  const key = `${repositoryPath.toLowerCase()}\0${commit.toLowerCase()}`;
  const existing = sharedWorktrees.get(key);
  if (existing) {
    existing.references += 1;
    if (existing.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
    }
    await existing.ready;
    return { key, entry: existing };
  }
  const reusable = [...sharedWorktrees.entries()].find(
    ([, entry]) =>
      entry.references === 0 &&
      entry.repositoryPath.toLowerCase() === repositoryPath.toLowerCase(),
  );
  if (reusable) {
    const [previousKey, entry] = reusable;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    sharedWorktrees.delete(previousKey);
    entry.references = 1;
    entry.cleanupTimer = null;
    entry.ready = serializeGitAdministration(() =>
      switchWorktree(entry.path, commit),
    );
    sharedWorktrees.set(key, entry);
    try {
      await entry.ready;
      return { key, entry };
    } catch (error) {
      sharedWorktrees.delete(key);
      throw error;
    }
  }
  const worktreePath = sharedWorktreePath(repositoryPath, commit);
  const entry = {
    path: worktreePath,
    repositoryPath,
    references: 1,
    cleanupTimer: null as NodeJS.Timeout | null,
    ready: serializeGitAdministration(() =>
      addWorktree(repositoryPath, worktreePath, commit),
    ),
  };
  sharedWorktrees.set(key, entry);
  try {
    await entry.ready;
    return { key, entry };
  } catch (error) {
    sharedWorktrees.delete(key);
    throw error;
  }
}

function releaseSharedWorktree(key: string, repositoryPath: string) {
  const entry = sharedWorktrees.get(key);
  if (!entry) return;
  entry.references -= 1;
  if (entry.references > 0 || entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    if (entry.references > 0 || sharedWorktrees.get(key) !== entry) return;
    sharedWorktrees.delete(key);
    void serializeGitAdministration(async () => {
      await removeWorktree(repositoryPath, entry.path);
    }).catch((error) => {
      console.error(`Unable to release shared worktree ${entry.path}:`, error);
    });
  }, 60_000);
  entry.cleanupTimer.unref();
}

export async function recordedPrHeadCommit(datasetPath: string) {
  const metadata = JSON.parse(
    await fs.readFile(path.join(datasetPath, "pr.json"), "utf8"),
  ) as {
    head?: { sha?: unknown };
    lastMergeSourceCommit?: { commitId?: unknown };
    sourceCommit?: unknown;
  };
  const candidates = [
    metadata.head?.sha,
    metadata.lastMergeSourceCommit?.commitId,
    metadata.sourceCommit,
  ];
  const commit = candidates.find(
    (value): value is string =>
      typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value.trim()),
  );
  if (!commit) {
    throw new Error(
      "The PR snapshot does not contain a usable head/source commit SHA",
    );
  }
  return commit.trim();
}

async function resolveHistoricalPrCommit(
  repository: RepositoryRecord,
  repositoryPath: string,
  datasetPath: string,
) {
  const metadata = JSON.parse(
    await fs.readFile(path.join(datasetPath, "pr.json"), "utf8"),
  ) as {
    number?: unknown;
    base?: { sha?: unknown };
  };
  const sourceCommit = await recordedPrHeadCommit(datasetPath);
  const sourceExists = await runCommand(
    "git",
    ["-C", repositoryPath, "cat-file", "-e", `${sourceCommit}^{commit}`],
    { timeoutMs: 30_000 },
  );
  if (sourceExists.exitCode === 0) return sourceCommit;

  if (repository.provider !== "azure-devops") {
    throw new Error(
      `PR head commit ${sourceCommit} is not available in local repository ${repositoryPath}`,
    );
  }
  const branch = await validateLocalRepositoryBranch(
    repositoryPath,
    repository.local_repo_branch,
  );
  const prNumber =
    typeof metadata.number === "number" ? metadata.number : null;
  const baseCommit =
    typeof metadata.base?.sha === "string" &&
    /^[0-9a-f]{7,64}$/i.test(metadata.base.sha.trim())
      ? metadata.base.sha.trim().toLowerCase()
      : null;
  if (!prNumber || !baseCommit) {
    throw new Error(
      `PR head commit ${sourceCommit} is unavailable and the snapshot lacks metadata needed to verify a merged commit`,
    );
  }

  async function matchingMergedCommits(revision: string) {
    const candidates = await runCommand(
      "git",
      [
        "-C",
        repositoryPath,
        "log",
        revision,
        "--fixed-strings",
        `--grep=Merged PR ${prNumber}:`,
        "--format=%H%x09%P",
        "-n",
        "50",
      ],
      { timeoutMs: 30_000 },
    );
    if (candidates.exitCode !== 0) return [];
    const matches = new Set<string>();
    for (const line of candidates.stdout.split(/\r?\n/)) {
      const [commit, parentText = ""] = line.trim().split("\t");
      const parents = parentText.toLowerCase().split(/\s+/).filter(Boolean);
      if (/^[0-9a-f]{7,64}$/i.test(commit) && parents[0] === baseCommit) {
        matches.add(commit);
      }
    }
    return [...matches];
  }

  const branchMatches = await matchingMergedCommits(branch);
  if (branchMatches.length === 1) return branchMatches[0];
  if (branchMatches.length > 1) {
    throw new Error(
      `Multiple commits on branch ${branch} match merged PR ${prNumber} based on ${baseCommit}`,
    );
  }

  // Azure optimized clones can retain the exact squash commit only through
  // internal review refs even when the configured branch no longer reaches it.
  const localRefMatches = await matchingMergedCommits("--all");
  if (localRefMatches.length === 1) return localRefMatches[0];
  if (localRefMatches.length > 1) {
    throw new Error(
      `Multiple local commits match merged PR ${prNumber} based on ${baseCommit}`,
    );
  }
  throw new Error(
    `PR head commit ${sourceCommit} is unavailable, and no local ref contains a verified "Merged PR ${prNumber}" commit based on ${baseCommit}`,
  );
}

export async function createHistoricalRepositoryContext(options: {
  repository: RepositoryRecord;
  datasetPath: string;
  worktreePath: string;
  shareReadOnly?: boolean;
}) {
  if (!options.repository.local_repo_path) {
    throw new Error(
      "A verified local repository path is required for benchmark reviews",
    );
  }
  const validated = await validateLocalRepositoryPath(
    options.repository.local_repo_path,
    options.repository,
  );
  if (!validated.path) {
    throw new Error(
      "A verified local repository path is required for benchmark reviews",
    );
  }
  const commit = await resolveHistoricalPrCommit(
    options.repository,
    validated.path,
    options.datasetPath,
  );
  if (options.shareReadOnly) {
    const shared = await acquireSharedWorktree(validated.path, commit);
    let cleaned = false;
    return {
      path: shared.entry.path,
      commit,
      warning: validated.warning,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        releaseSharedWorktree(shared.key, validated.path!);
      },
    };
  }
  const worktreePath = assertSafeWorktreePath(options.worktreePath);
  await serializeGitAdministration(async () => {
    await addWorktree(validated.path!, worktreePath, commit);
  });
  let cleaned = false;
  return {
    path: worktreePath,
    commit,
    warning: validated.warning,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await serializeGitAdministration(async () => {
        await removeWorktree(validated.path!, worktreePath);
      });
    },
  };
}
