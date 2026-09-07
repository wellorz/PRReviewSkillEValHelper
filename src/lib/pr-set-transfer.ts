import fs from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { DATASETS_DIR, prDatasetDir } from "@/lib/paths";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
export const PR_SET_BUNDLE_VERSION = 1;
export const MAX_PR_SET_ARCHIVE_BYTES = 512 * 1024 * 1024;

type BundleFile = {
  path: string;
  contentBase64: string;
};

type BundlePullRequest = {
  number: number;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  mergedAt: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  valuedCommentCount: number;
  rawJson: string;
  selected: boolean;
  manual: boolean;
  defectDescription: string | null;
  files: BundleFile[];
};

type BundleRepository = {
  slug: string;
  displayName: string;
  provider: "github" | "azure-devops";
  cloneUrl: string;
  organizationUrl: string | null;
  projectName: string | null;
  repositoryName: string;
  model: string;
  modelSecondary: string;
  contextTier: string;
  pullRequests: BundlePullRequest[];
};

export type PrSetBundle = {
  format: "pr-review-skill-eval-helper";
  version: number;
  exportedAt: string;
  repositories: BundleRepository[];
};

type RepositoryRow = {
  id: number;
  slug: string;
  display_name: string;
  provider: "github" | "azure-devops";
  clone_url: string;
  organization_url: string | null;
  project_name: string | null;
  repository_name: string;
  model: string;
  model_secondary: string;
  context_tier: string;
};

type PullRequestRow = {
  number: number;
  title: string;
  url: string;
  author: string;
  base_ref: string;
  head_ref: string;
  merged_at: string | null;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  valued_comment_count: number;
  dataset_path: string;
  raw_json: string;
  selected: number;
  manual: number;
  defect_description: string | null;
};

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe PR-set file path: ${value}`);
  }
  return normalized;
}

async function readBundleFiles(root: string) {
  const resolvedRoot = path.resolve(root);
  const relativeToDatasets = path.relative(path.resolve(DATASETS_DIR), resolvedRoot);
  if (
    relativeToDatasets.startsWith("..") ||
    path.isAbsolute(relativeToDatasets)
  ) {
    throw new Error(`PR dataset is outside ${DATASETS_DIR}`);
  }
  const entries = await fs.readdir(resolvedRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const files: BundleFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(entry.parentPath, entry.name);
    const relativePath = safeRelativePath(
      path.relative(resolvedRoot, absolutePath),
    );
    files.push({
      path: relativePath,
      contentBase64: (await fs.readFile(absolutePath)).toString("base64"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createPrSetBundle(db: Database.Database) {
  const repositories = db
    .prepare(`
      SELECT id, slug, display_name, provider, clone_url, organization_url,
        project_name, repository_name, model, model_secondary, context_tier
      FROM repositories
      ORDER BY id
    `)
    .all() as RepositoryRow[];
  const bundledRepositories: BundleRepository[] = [];
  for (const repository of repositories) {
    const pullRequests = db
      .prepare(`
        SELECT number, title, url, author, base_ref, head_ref, merged_at,
          updated_at, additions, deletions, changed_files,
          valued_comment_count, dataset_path, raw_json, selected, manual,
          defect_description
        FROM pull_requests
        WHERE repository_id = ? AND active = 1 AND excluded_by_user = 0
        ORDER BY number
      `)
      .all(repository.id) as PullRequestRow[];
    bundledRepositories.push({
      slug: repository.slug,
      displayName: repository.display_name,
      provider: repository.provider,
      cloneUrl: repository.clone_url,
      organizationUrl: repository.organization_url,
      projectName: repository.project_name,
      repositoryName: repository.repository_name,
      model: repository.model,
      modelSecondary: repository.model_secondary,
      contextTier: repository.context_tier,
      pullRequests: await Promise.all(
        pullRequests.map(async (pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          baseRef: pullRequest.base_ref,
          headRef: pullRequest.head_ref,
          mergedAt: pullRequest.merged_at,
          updatedAt: pullRequest.updated_at,
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
          changedFiles: pullRequest.changed_files,
          valuedCommentCount: pullRequest.valued_comment_count,
          rawJson: pullRequest.raw_json,
          selected: Boolean(pullRequest.selected),
          manual: Boolean(pullRequest.manual),
          defectDescription: pullRequest.defect_description,
          files: await readBundleFiles(pullRequest.dataset_path),
        })),
      ),
    });
  }
  const bundle: PrSetBundle = {
    format: "pr-review-skill-eval-helper",
    version: PR_SET_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    repositories: bundledRepositories,
  };
  return gzipAsync(Buffer.from(JSON.stringify(bundle)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid PR-set ${key}`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = stringValue(record, key);
  if (!value.trim()) {
    throw new Error(`Invalid PR-set ${key}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value == null ? null : stringValue(record, key);
}

function requiredInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid PR-set ${key}`);
  }
  return Number(value);
}

export async function decodePrSetBundle(archive: Buffer) {
  if (archive.length > MAX_PR_SET_ARCHIVE_BYTES) {
    throw new Error("PR-set bundle exceeds the 512 MB compressed size limit");
  }
  let json: Buffer;
  try {
    json =
      archive[0] === 0x1f && archive[1] === 0x8b
        ? await gunzipAsync(archive)
        : archive;
  } catch {
    throw new Error("Unable to decompress the PR-set bundle");
  }
  let value: unknown;
  try {
    value = JSON.parse(json.toString("utf8"));
  } catch {
    throw new Error("PR-set bundle does not contain valid JSON");
  }
  if (
    !isRecord(value) ||
    value.format !== "pr-review-skill-eval-helper" ||
    value.version !== PR_SET_BUNDLE_VERSION ||
    !Array.isArray(value.repositories)
  ) {
    throw new Error("Unsupported PR-set bundle format or version");
  }
  const repositories: BundleRepository[] = value.repositories.map(
    (repositoryValue) => {
      if (!isRecord(repositoryValue) || !Array.isArray(repositoryValue.pullRequests)) {
        throw new Error("Invalid PR-set repository");
      }
      const provider = requiredString(repositoryValue, "provider");
      if (provider !== "github" && provider !== "azure-devops") {
        throw new Error(`Unsupported PR-set provider: ${provider}`);
      }
      return {
        slug: requiredString(repositoryValue, "slug"),
        displayName: stringValue(repositoryValue, "displayName"),
        provider,
        cloneUrl: stringValue(repositoryValue, "cloneUrl"),
        organizationUrl: optionalString(repositoryValue, "organizationUrl"),
        projectName: optionalString(repositoryValue, "projectName"),
        repositoryName: requiredString(repositoryValue, "repositoryName"),
        model: requiredString(repositoryValue, "model"),
        modelSecondary: requiredString(repositoryValue, "modelSecondary"),
        contextTier: requiredString(repositoryValue, "contextTier"),
        pullRequests: repositoryValue.pullRequests.map((pullRequestValue) => {
          if (!isRecord(pullRequestValue) || !Array.isArray(pullRequestValue.files)) {
            throw new Error("Invalid PR-set pull request");
          }
          return {
            number: requiredInteger(pullRequestValue, "number"),
            title: stringValue(pullRequestValue, "title"),
            url: stringValue(pullRequestValue, "url"),
            author: stringValue(pullRequestValue, "author"),
            baseRef: stringValue(pullRequestValue, "baseRef"),
            headRef: stringValue(pullRequestValue, "headRef"),
            mergedAt: optionalString(pullRequestValue, "mergedAt"),
            updatedAt: stringValue(pullRequestValue, "updatedAt"),
            additions: requiredInteger(pullRequestValue, "additions"),
            deletions: requiredInteger(pullRequestValue, "deletions"),
            changedFiles: requiredInteger(pullRequestValue, "changedFiles"),
            valuedCommentCount: requiredInteger(
              pullRequestValue,
              "valuedCommentCount",
            ),
            rawJson: stringValue(pullRequestValue, "rawJson"),
            selected: pullRequestValue.selected !== false,
            manual: pullRequestValue.manual === true,
            defectDescription: optionalString(
              pullRequestValue,
              "defectDescription",
            ),
            files: pullRequestValue.files.map((fileValue) => {
              if (!isRecord(fileValue)) throw new Error("Invalid PR-set file");
              const contentBase64 = stringValue(
                fileValue,
                "contentBase64",
              );
              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
                throw new Error("Invalid PR-set file content");
              }
              return {
                path: safeRelativePath(requiredString(fileValue, "path")),
                contentBase64,
              };
            }),
          };
        }),
      };
    },
  );
  return {
    format: value.format,
    version: value.version,
    exportedAt:
      typeof value.exportedAt === "string"
        ? value.exportedAt
        : new Date(0).toISOString(),
    repositories,
  } satisfies PrSetBundle;
}

export async function importPrSetBundle(
  db: Database.Database,
  bundle: PrSetBundle,
) {
  const prepared: Array<{
    repository: BundleRepository;
    pullRequest: BundlePullRequest;
    datasetPath: string;
  }> = [];
  for (const repository of bundle.repositories) {
    for (const pullRequest of repository.pullRequests) {
      const datasetPath = prDatasetDir(repository.slug, pullRequest.number);
      await fs.rm(datasetPath, { recursive: true, force: true });
      await fs.mkdir(datasetPath, { recursive: true });
      for (const file of pullRequest.files) {
        const destination = path.resolve(datasetPath, file.path);
        const relative = path.relative(path.resolve(datasetPath), destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`Unsafe PR-set destination: ${file.path}`);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, Buffer.from(file.contentBase64, "base64"));
      }
      prepared.push({ repository, pullRequest, datasetPath });
    }
  }

  return db.transaction(() => {
    const upsertRepository = db.prepare(`
      INSERT INTO repositories (
        slug, display_name, provider, clone_url, organization_url, project_name,
        repository_name, path_filter, skill_path, model, model_secondary,
        context_tier, target_prs, scan_limit, baseline_concurrency,
        status, status_message, collected_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '.', ?, ?, ?, ?, 2000, 5,
        'ready', ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        display_name = excluded.display_name,
        provider = excluded.provider,
        clone_url = excluded.clone_url,
        organization_url = excluded.organization_url,
        project_name = excluded.project_name,
        repository_name = excluded.repository_name,
        status = 'ready',
        status_message = excluded.status_message,
        collected_count = excluded.collected_count,
        updated_at = CURRENT_TIMESTAMP
    `);
    const readRepository = db.prepare(
      "SELECT id FROM repositories WHERE slug = ?",
    );
    const upsertPullRequest = db.prepare(`
      INSERT INTO pull_requests (
        repository_id, number, title, url, author, base_ref, head_ref,
        merged_at, updated_at, additions, deletions, changed_files,
        valued_comment_count, dataset_path, raw_json, active, selected,
        manual, excluded_by_user, defect_description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)
      ON CONFLICT(repository_id, number) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        author = excluded.author,
        base_ref = excluded.base_ref,
        head_ref = excluded.head_ref,
        merged_at = excluded.merged_at,
        updated_at = excluded.updated_at,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        valued_comment_count = excluded.valued_comment_count,
        dataset_path = excluded.dataset_path,
        raw_json = excluded.raw_json,
        active = 1,
        selected = excluded.selected,
        manual = excluded.manual,
        excluded_by_user = 0,
        defect_description = excluded.defect_description,
        baseline_status = 'pending',
        baseline_duration_ms = NULL,
        baseline_findings_json = NULL,
        baseline_usage_json = NULL,
        baseline_metrics_json = NULL,
        baseline_completed_at = NULL,
        skill_status = 'pending',
        skill_duration_ms = NULL,
        skill_findings_json = NULL,
        skill_metrics_json = NULL,
        skill_completed_at = NULL,
        skill_report_path = NULL
    `);
    const readPullRequest = db.prepare(`
      SELECT id FROM pull_requests WHERE repository_id = ? AND number = ?
    `);
    const clearBaselineResults = db.prepare(
      "DELETE FROM baseline_profile_results WHERE pull_request_id = ?",
    );
    const clearSkillResults = db.prepare(
      "DELETE FROM personal_skill_results WHERE pull_request_id = ?",
    );
    let importedPullRequests = 0;
    for (const repository of bundle.repositories) {
      const count = repository.pullRequests.length;
      upsertRepository.run(
        repository.slug,
        repository.displayName,
        repository.provider,
        repository.cloneUrl,
        repository.organizationUrl,
        repository.projectName,
        repository.repositoryName,
        repository.model,
        repository.modelSecondary,
        repository.contextTier,
        count,
        `Imported ${count} PRs from a shared PR set`,
        count,
      );
      const repositoryId = (
        readRepository.get(repository.slug) as { id: number }
      ).id;
      for (const item of prepared.filter(
        (entry) => entry.repository.slug === repository.slug,
      )) {
        const pullRequest = item.pullRequest;
        upsertPullRequest.run(
          repositoryId,
          pullRequest.number,
          pullRequest.title,
          pullRequest.url,
          pullRequest.author,
          pullRequest.baseRef,
          pullRequest.headRef,
          pullRequest.mergedAt,
          pullRequest.updatedAt,
          pullRequest.additions,
          pullRequest.deletions,
          pullRequest.changedFiles,
          pullRequest.valuedCommentCount,
          item.datasetPath,
          pullRequest.rawJson,
          pullRequest.selected ? 1 : 0,
          pullRequest.manual ? 1 : 0,
          pullRequest.defectDescription,
        );
        const pullRequestId = (
          readPullRequest.get(repositoryId, pullRequest.number) as {
            id: number;
          }
        ).id;
        clearBaselineResults.run(pullRequestId);
        clearSkillResults.run(pullRequestId);
        importedPullRequests += 1;
      }
    }
    return {
      repositories: bundle.repositories.length,
      pullRequests: importedPullRequests,
    };
  })();
}
