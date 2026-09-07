import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "@/lib/process";
import type { RepositoryRecord } from "@/lib/types";

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function remoteMatchesRepository(
  remote: string,
  repository: Pick<
    RepositoryRecord,
    "provider" | "slug" | "repository_name" | "project_name"
  >,
) {
  const normalized = decoded(remote)
    .trim()
    .replaceAll("\\", "/")
    .replace(/^git@([^:]+):/i, "$1/")
    .replace(/^https?:\/\/(?:[^/@]+@)?/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (repository.provider === "github") {
    return normalized.endsWith(
      `github.com/${repository.slug.toLowerCase()}`,
    );
  }
  const repositoryName = repository.repository_name.toLowerCase();
  const gitPath = `/_git/${repositoryName}`;
  const optimizedGitPath = `/_git/_optimized/${repositoryName}`;
  if (
    !normalized.endsWith(gitPath) &&
    !normalized.endsWith(optimizedGitPath)
  ) {
    return false;
  }
  return repository.project_name
    ? normalized.includes(`/${repository.project_name.toLowerCase()}/`)
    : true;
}

export async function validateLocalRepositoryPath(
  configuredPath: string | null | undefined,
  repository: Pick<
    RepositoryRecord,
    "provider" | "slug" | "repository_name" | "project_name"
  >,
) {
  const value = configuredPath?.trim();
  if (!value) return { path: null, warning: null };
  const resolved = path.resolve(value);
  try {
    if (!(await fs.stat(resolved)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`Local repository path does not exist: ${resolved}`);
  }
  const rootResult = await runCommand(
    "git",
    ["-C", resolved, "rev-parse", "--show-toplevel"],
    { timeoutMs: 30_000 },
  );
  if (rootResult.exitCode !== 0) {
    throw new Error(`Local repository path is not a Git repository: ${resolved}`);
  }
  const root = path.resolve(rootResult.stdout.trim());
  const originResult = await runCommand(
    "git",
    ["-C", root, "remote", "get-url", "origin"],
    { timeoutMs: 30_000 },
  );
  if (originResult.exitCode !== 0 || !originResult.stdout.trim()) {
    throw new Error(
      `Local repository has no readable origin remote: ${root}`,
    );
  }
  if (!remoteMatchesRepository(originResult.stdout, repository)) {
    throw new Error(
      `Local repository origin does not match the configured benchmark repository: ${root}`,
    );
  }
  return { path: root, warning: null };
}

export async function validateLocalRepositoryBranch(
  repositoryPath: string,
  branch: string | null | undefined,
) {
  const value = branch?.trim();
  if (!value) {
    throw new Error("Select a local repository branch for historical reviews");
  }
  const refs = await runCommand(
    "git",
    [
      "-C",
      repositoryPath,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ],
    { timeoutMs: 30_000 },
  );
  const branches = refs.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (refs.exitCode !== 0 || !branches.includes(value)) {
    throw new Error(
      `Local repository branch does not exist in ${repositoryPath}: ${value}`,
    );
  }
  return value;
}
