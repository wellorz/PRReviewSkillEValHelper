import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  remoteMatchesRepository,
  validateLocalRepositoryPath,
} from "@/lib/local-repository";
import { DATA_DIR } from "@/lib/paths";
import { runCommand } from "@/lib/process";
import {
  createHistoricalRepositoryContext,
  recordedPrHeadCommit,
} from "@/lib/repository-context";
import type { RepositoryRecord } from "@/lib/types";

test("matches common GitHub and Azure remote URL forms", () => {
  assert.equal(
    remoteMatchesRepository("git@github.com:Owner/Repo.git", {
      provider: "github",
      slug: "owner/repo",
      repository_name: "Repo",
      project_name: null,
    }),
    true,
  );
  assert.equal(
    remoteMatchesRepository(
      "https://dev.azure.com/org/O365%20Core/_git/Substrate",
      {
        provider: "azure-devops",
        slug: "org/project/repo",
        repository_name: "Substrate",
        project_name: "O365 Core",
      },
    ),
    true,
  );
  assert.equal(
    remoteMatchesRepository(
      "https://o365exchange.visualstudio.com/O365%20Core/_git/_optimized/Substrate",
      {
        provider: "azure-devops",
        slug: "o365exchange/O365 Core/Substrate",
        repository_name: "Substrate",
        project_name: "O365 Core",
      },
    ),
    true,
  );
});

test("creates and safely removes a detached historical worktree", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const source = path.join(process.cwd(), "runtime", `context-source-${suffix}`);
  const dataset = path.join(process.cwd(), "runtime", `context-data-${suffix}`);
  const worktreeRoot = path.join(
    DATA_DIR,
    "workflow",
    `context-test-${suffix}`,
  );
  const worktree = path.join(worktreeRoot, "repository");
  try {
    await fs.mkdir(source, { recursive: true });
    assert.equal(
      (await runCommand("git", ["init", "--quiet", source])).exitCode,
      0,
    );
    await fs.writeFile(path.join(source, "tracked.txt"), "historical");
    assert.equal(
      (
        await runCommand(
          "git",
          [
            "-C",
            source,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "add",
            "tracked.txt",
          ],
        )
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runCommand(
          "git",
          [
            "-C",
            source,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ],
        )
      ).exitCode,
      0,
    );
    const sha = (
      await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    await fs.mkdir(dataset, { recursive: true });
    await fs.writeFile(
      path.join(dataset, "pr.json"),
      JSON.stringify({ head: { sha } }),
    );
    assert.equal(await recordedPrHeadCommit(dataset), sha);
    const repository = {
      provider: "github",
      slug: "owner/repo",
      repository_name: "repo",
      project_name: null,
      local_repo_path: source,
    } as RepositoryRecord;
    await runCommand("git", [
      "-C",
      source,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/repo.git",
    ]);
    const validated = await validateLocalRepositoryPath(source, repository);
    assert.equal(validated.path, path.resolve(source));
    assert.equal(validated.warning, null);
    const context = await createHistoricalRepositoryContext({
      repository,
      datasetPath: dataset,
      worktreePath: worktree,
    });
    assert.equal(context?.commit, sha);
    assert.equal(
      await fs.readFile(path.join(worktree, "tracked.txt"), "utf8"),
      "historical",
    );
    await context?.cleanup();
    await assert.rejects(fs.stat(worktree));
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(dataset, { recursive: true, force: true });
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  }
});

test("uses a verified Azure squash commit from the selected branch", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const source = path.join(process.cwd(), "runtime", `squash-source-${suffix}`);
  const dataset = path.join(process.cwd(), "runtime", `squash-data-${suffix}`);
  const worktreeRoot = path.join(
    DATA_DIR,
    "workflow",
    `squash-test-${suffix}`,
  );
  const worktree = path.join(worktreeRoot, "repository");
  try {
    await fs.mkdir(source, { recursive: true });
    assert.equal(
      (await runCommand("git", ["init", "--quiet", source])).exitCode,
      0,
    );
    await fs.writeFile(path.join(source, "tracked.txt"), "base");
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "add",
          "tracked.txt",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-m",
          "base",
        ])
      ).exitCode,
      0,
    );
    const baseSha = (
      await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    const branch = (
      await runCommand("git", [
        "-C",
        source,
        "symbolic-ref",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    await fs.writeFile(path.join(source, "tracked.txt"), "merged");
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-am",
          "Merged PR 42: fixture",
        ])
      ).exitCode,
      0,
    );
    const mergeSha = (
      await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    await runCommand("git", [
      "-C",
      source,
      "remote",
      "add",
      "origin",
      "https://dev.azure.com/org/Project/_git/Repo",
    ]);
    await fs.mkdir(dataset, { recursive: true });
    await fs.writeFile(
      path.join(dataset, "pr.json"),
      JSON.stringify({
        number: 42,
        base: { sha: baseSha },
        head: { sha: "f".repeat(40) },
      }),
    );
    const repository = {
      provider: "azure-devops",
      slug: "org/Project/Repo",
      repository_name: "Repo",
      project_name: "Project",
      local_repo_path: source,
      local_repo_branch: branch,
    } as RepositoryRecord;
    const context = await createHistoricalRepositoryContext({
      repository,
      datasetPath: dataset,
      worktreePath: worktree,
    });
    assert.equal(context.commit, mergeSha);
    assert.equal(
      await fs.readFile(path.join(worktree, "tracked.txt"), "utf8"),
      "merged",
    );
    await context.cleanup();
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(dataset, { recursive: true, force: true });
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  }
});

test("uses a verified Azure squash commit retained by a local review ref", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const source = path.join(process.cwd(), "runtime", `ref-source-${suffix}`);
  const dataset = path.join(process.cwd(), "runtime", `ref-data-${suffix}`);
  const worktreeRoot = path.join(DATA_DIR, "workflow", `ref-test-${suffix}`);
  const worktree = path.join(worktreeRoot, "repository");
  try {
    await fs.mkdir(source, { recursive: true });
    assert.equal(
      (await runCommand("git", ["init", "--quiet", source])).exitCode,
      0,
    );
    await fs.writeFile(path.join(source, "tracked.txt"), "base");
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "add",
          "tracked.txt",
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-m",
          "base",
        ])
      ).exitCode,
      0,
    );
    const baseSha = (
      await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    const branch = (
      await runCommand("git", [
        "-C",
        source,
        "symbolic-ref",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    await fs.writeFile(path.join(source, "tracked.txt"), "merged");
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-am",
          "Merged PR 42: fixture",
        ])
      ).exitCode,
      0,
    );
    const mergeSha = (
      await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
    ).stdout.trim();
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "update-ref",
          "refs/devloop/review/42/source",
          mergeSha,
        ])
      ).exitCode,
      0,
    );
    assert.equal(
      (
        await runCommand("git", [
          "-C",
          source,
          "reset",
          "--hard",
          baseSha,
        ])
      ).exitCode,
      0,
    );
    await runCommand("git", [
      "-C",
      source,
      "remote",
      "add",
      "origin",
      "https://dev.azure.com/org/Project/_git/Repo",
    ]);
    await fs.mkdir(dataset, { recursive: true });
    await fs.writeFile(
      path.join(dataset, "pr.json"),
      JSON.stringify({
        number: 42,
        base: { sha: baseSha },
        head: { sha: "f".repeat(40) },
      }),
    );
    const repository = {
      provider: "azure-devops",
      slug: "org/Project/Repo",
      repository_name: "Repo",
      project_name: "Project",
      local_repo_path: source,
      local_repo_branch: branch,
    } as RepositoryRecord;
    const context = await createHistoricalRepositoryContext({
      repository,
      datasetPath: dataset,
      worktreePath: worktree,
    });
    assert.equal(context.commit, mergeSha);
    assert.equal(
      await fs.readFile(path.join(worktree, "tracked.txt"), "utf8"),
      "merged",
    );
    await context.cleanup();
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(dataset, { recursive: true, force: true });
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  }
});
