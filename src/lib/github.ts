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
  pathMatchesFilters,
  reviewableChangedFilePaths,
} from "@/lib/repository-source";
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
  GithubPullRequest,
  HumanFinding,
  RepositoryRecord,
} from "@/lib/types";

type GithubComment = {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  author_association: string;
  user: { login: string; type: string };
  path?: string;
  line?: number | null;
  original_line?: number | null;
  state?: string;
};

type GithubFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
};

const LOW_VALUE_PATTERN =
  /^(lgtm|looks good|approved|approve|ship it|thanks|thank you|done|fixed|nit|nice|great|\+1|👍)[.! ]*$/i;
const ACTIONABLE_PATTERN =
  /\b(bug|break|incorrect|wrong|fail|error|exception|race|leak|security|unsafe|null|undefined|edge case|should|must|need|consider|instead|why|what if|could)\b/i;
const MINOR_COMMENT_PATTERN =
  /\b(nit|nitpick|typo|spelling|grammar|format(?:ting)?|whitespace|indent(?:ation)?|style|convention|vari(?:able|ant) name|parameter name|method name|function name|class name|rename|naming)\b/i;
const DEFECT_COMMENT_PATTERN =
  /\b(bug|break|incorrect|wrong result|fail|error|exception|race|leak|security|unsafe|null|undefined|data loss|deadlock|corrupt|crash|skip(?:ped|ping)?|drop(?:ped|ping)?|misclassif(?:y|ied|ication)|prevent(?:s|ed|ing)?|not requir(?:e|ed|ing))\b/i;
const TEST_ONLY_COMMENT_PATTERN =
  /\b(add|include|update|write|need|missing|cover)\b.{0,40}\b(unit tests?|tests?|test coverage|ut)\b/i;

function isBot(login: string, type: string) {
  return type === "Bot" || /\[bot\]$|-bot$/i.test(login);
}

export function scoreHumanComment(
  comment: GithubComment,
  prAuthor: string,
): { score: number; reasons: string[] } {
  const body = (comment.body ?? "").trim();
  if (
    !body ||
    comment.user.login === prAuthor ||
    isBot(comment.user.login, comment.user.type) ||
    LOW_VALUE_PATTERN.test(body)
  ) {
    return { score: 0, reasons: [] };
  }

  let score = 0;
  const reasons: string[] = [];
  if (comment.path) {
    score += 2;
    reasons.push("inline-code-location");
  }
  if (body.length >= 80) {
    score += 1;
    reasons.push("substantive-detail");
  }
  if (ACTIONABLE_PATTERN.test(body)) {
    score += 2;
    reasons.push("actionable-language");
  }
  if (/```|`[^`]+`|suggestion/i.test(body)) {
    score += 1;
    reasons.push("code-or-suggestion");
  }
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association)) {
    score += 1;
    reasons.push("trusted-repository-role");
  }
  return { score, reasons };
}

export function humanFindingScorePoint(body: string): 0 | 1 {
  if (DEFECT_COMMENT_PATTERN.test(body)) return 1;
  return MINOR_COMMENT_PATTERN.test(body) || TEST_ONLY_COMMENT_PATTERN.test(body)
    ? 0
    : 1;
}

async function ghJson<T>(endpoint: string, fields: string[] = []): Promise<T> {
  const args = ["api", endpoint, "--paginate", "--slurp"];
  for (const field of fields) args.push("-f", field);
  const result = await runCommand("gh", args, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `gh api failed for ${endpoint}`);
  }
  const pages = JSON.parse(result.stdout) as T[] | T[][];
  return (Array.isArray(pages[0]) ? pages.flat() : pages) as T;
}

async function ghSingle<T>(endpoint: string): Promise<T> {
  const result = await runCommand("gh", ["api", endpoint], {
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `gh api failed for ${endpoint}`);
  }
  return JSON.parse(result.stdout) as T;
}

async function ghDiff(slug: string, number: number) {
  const result = await runCommand(
    "gh",
    [
      "api",
      `repos/${slug}/pulls/${number}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ],
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Unable to download PR #${number} diff`);
  }
  return result.stdout;
}

function filterGithubFiles(files: GithubFile[], filters: string[]) {
  return files.filter((file) => pathMatchesFilters(file.filename, filters));
}

function filteredGithubDiff(files: GithubFile[]) {
  return files
    .map((file) => {
      const previous = file.previous_filename ?? file.filename;
      return `diff --git a/${previous} b/${file.filename}
--- a/${previous}
+++ b/${file.filename}
${file.patch ?? "# Patch unavailable from GitHub API"}`;
    })
    .join("\n");
}

export async function collectPullRequestSnapshot(
  repository: RepositoryRecord,
  number: number,
  destination: string,
) {
  if (repository.provider === "azure-devops") {
    const { collectAzurePullRequestSnapshot } = await import(
      "@/lib/azure-devops"
    );
    return collectAzurePullRequestSnapshot(repository, number, destination);
  }
  await checkGithubAuthentication();
  const filters = parsePathFilters(repository.path_filter);
  const [pr, files, diff] = await Promise.all([
    ghSingle<GithubPullRequest>(`repos/${repository.slug}/pulls/${number}`),
    ghJson<GithubFile[]>(
      `repos/${repository.slug}/pulls/${number}/files?per_page=100`,
    ),
    ghDiff(repository.slug, number),
  ]);
  const matchingFiles = filterGithubFiles(files, filters);
  if (matchingFiles.length === 0) {
    throw new Error("The PR has no changed files under the configured path filter.");
  }
  await fs.mkdir(destination, { recursive: true });
  const publicPr = {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    body: pr.body,
    author: pr.user.login,
    base: pr.base,
    head: pr.head,
    mergedAt: pr.merged_at,
    updatedAt: pr.updated_at,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: matchingFiles.length,
  };
  await Promise.all([
    fs.writeFile(path.join(destination, "pr.json"), JSON.stringify(publicPr, null, 2)),
    fs.writeFile(
      path.join(destination, "files.json"),
      JSON.stringify(matchingFiles, null, 2),
    ),
    fs.writeFile(
      path.join(destination, "diff.patch"),
      filters.length ? filteredGithubDiff(matchingFiles) : diff,
    ),
  ]);
  return publicPr;
}

function toHumanFinding(
  comment: GithubComment,
  source: HumanFinding["source"],
  prAuthor: string,
): HumanFinding | null {
  const value = scoreHumanComment(comment, prAuthor);
  if (value.score < 2) return null;
  return {
    id: `${source}-${comment.id}`,
    source,
    author: comment.user.login,
    authorAssociation: comment.author_association,
    body: (comment.body ?? "").trim(),
    path: comment.path ?? null,
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    url: comment.html_url,
    createdAt: comment.created_at,
    valueScore: value.score,
    valueReasons: value.reasons,
    scorePoint: humanFindingScorePoint((comment.body ?? "").trim()),
  };
}

export async function checkGithubAuthentication() {
  const result = await runCommand("gh", ["auth", "status"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login` first.");
  }
}

export async function syncRepositoryDataset(repository: RepositoryRecord) {
  if (repository.provider === "azure-devops") {
    const { syncAzureRepositoryDataset } = await import("@/lib/azure-devops");
    return syncAzureRepositoryDataset(repository);
  }
  await checkGithubAuthentication();
  const db = getDb();
  db.prepare(
    "UPDATE repositories SET status = 'syncing', status_message = ?, scan_current = 0, scan_total = ?, collected_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run("Scanning recent pull requests", repository.scan_limit, repository.id);

  const root = repositoryDatasetDir(repository.slug);
  await fs.mkdir(root, { recursive: true });
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
  let saved = preserved.length;
  let scanned = 0;
  let page = 1;
  const preservedNumbers = new Set(
    preserved.map((pullRequest) => pullRequest.number),
  );
  db.prepare(
    "UPDATE repositories SET status_message = ?, collected_count = ? WHERE id = ?",
  ).run(
    preserved.length > 0
      ? `Preserved ${preserved.length} existing eligible PRs; scanning recent pull requests`
      : "Scanning recent pull requests",
    saved,
    repository.id,
  );

  while (saved < repository.target_prs && scanned < repository.scan_limit) {
    const perPage = Math.min(100, repository.scan_limit - scanned);
    const prs = await ghSingle<GithubPullRequest[]>(
      `repos/${repository.slug}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
    );
    if (prs.length === 0) break;

    for (const listPr of prs) {
      if (saved >= repository.target_prs || scanned >= repository.scan_limit) break;
      scanned += 1;
      const scanCandidate: ScanCandidate = {
        number: listPr.number,
        sourceUpdatedAt: listPr.updated_at,
        sourceCommit: listPr.head.sha,
      };
      if (
        preservedNumbers.has(listPr.number) ||
        excludedNumbers.has(listPr.number)
      ) {
        continue;
      }
      const cached = cachedScanOutcome(scope, scanCandidate);
      if (cached) {
        recordCachedScan(scanRunId, scope, scanCandidate);
        continue;
      }
      if (!listPr.merged_at || listPr.draft || isBot(listPr.user.login, listPr.user.type)) {
        recordScanOutcome(scanRunId, scope, scanCandidate, "ignored", 0);
        continue;
      }

      db.prepare(
        "UPDATE repositories SET status_message = ?, scan_current = ?, collected_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(
        `Inspecting PR #${listPr.number}`,
        scanned,
        saved,
        repository.id,
      );

      const [pr, reviewComments, issueComments, reviews, files, diff] =
        await Promise.all([
          ghSingle<GithubPullRequest>(
            `repos/${repository.slug}/pulls/${listPr.number}`,
          ),
          ghJson<GithubComment[]>(
            `repos/${repository.slug}/pulls/${listPr.number}/comments?per_page=100`,
          ),
          ghJson<GithubComment[]>(
            `repos/${repository.slug}/issues/${listPr.number}/comments?per_page=100`,
          ),
          ghJson<GithubComment[]>(
            `repos/${repository.slug}/pulls/${listPr.number}/reviews?per_page=100`,
          ),
          ghJson<GithubFile[]>(
            `repos/${repository.slug}/pulls/${listPr.number}/files?per_page=100`,
          ),
          ghDiff(repository.slug, listPr.number),
        ]);
      const matchingFiles = filterGithubFiles(files, filters);
      if (matchingFiles.length === 0) {
        recordScanOutcome(scanRunId, scope, scanCandidate, "ineligible", 0);
        continue;
      }

      let findings = [
        ...reviewComments
          .map((comment) => toHumanFinding(comment, "review_comment", pr.user.login))
          .filter((finding): finding is HumanFinding => Boolean(finding)),
        ...(filters.length === 0
          ? issueComments
              .map((comment) =>
                toHumanFinding(comment, "issue_comment", pr.user.login),
              )
              .filter((finding): finding is HumanFinding => Boolean(finding))
          : []),
        ...(filters.length === 0
          ? reviews
              .filter((review) => review.state !== "APPROVED")
              .map((comment) => toHumanFinding(comment, "review", pr.user.login))
              .filter((finding): finding is HumanFinding => Boolean(finding))
          : []),
      ];
      if (!findings.some((finding) => finding.scorePoint === 1)) {
        recordScanOutcome(scanRunId, scope, scanCandidate, "ineligible", 0);
        continue;
      }
      const reviewablePaths = new Set(
        reviewableChangedFilePaths(
          files.map((file) => file.filename),
          findings
            .filter((finding) => (finding.scorePoint ?? 1) === 1)
            .map((finding) => finding.path),
          filters,
        ),
      );
      const reviewableFiles = files.filter((file) =>
        reviewablePaths.has(file.filename),
      );

      const datasetPath = prDatasetDir(repository.slug, pr.number);
      await fs.mkdir(path.join(datasetPath, "files"), { recursive: true });
      const publicPr = {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        body: pr.body,
        author: pr.user.login,
        base: pr.base,
        head: pr.head,
        mergedAt: pr.merged_at,
        updatedAt: pr.updated_at,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: reviewableFiles.length,
      };
      const scopedDiff = filters.length
        ? filteredGithubDiff(reviewableFiles)
        : diff;
      findings = await normalizeHumanFindings({
        repository,
        prNumber: pr.number,
        prMetadata: publicPr,
        diff: scopedDiff,
        findings,
      });
      await Promise.all([
        fs.writeFile(
          path.join(datasetPath, "pr.json"),
          JSON.stringify(publicPr, null, 2),
        ),
        fs.writeFile(
          path.join(datasetPath, "human-findings.json"),
          JSON.stringify(findings, null, 2),
        ),
        fs.writeFile(
          path.join(datasetPath, "files.json"),
          JSON.stringify(reviewableFiles, null, 2),
        ),
        fs.writeFile(
          path.join(datasetPath, "diff.patch"),
          scopedDiff,
        ),
      ]);

      const findingCount = findings.filter(
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
          additions = excluded.additions,
          deletions = excluded.deletions,
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
        pr.number,
        pr.title,
        pr.html_url,
        pr.user.login,
        pr.base.ref,
        pr.head.ref,
        pr.merged_at,
        pr.updated_at,
        pr.additions ?? 0,
        pr.deletions ?? 0,
        reviewableFiles.length,
        findingCount,
        datasetPath,
        JSON.stringify(publicPr),
      );
      recordScanOutcome(
        scanRunId,
        scope,
        scanCandidate,
        "eligible",
        findingCount,
      );
      saved += 1;
      db.prepare(
        "UPDATE repositories SET collected_count = ? WHERE id = ?",
      ).run(saved, repository.id);
    }
    page += 1;
  }
  db.prepare(`
    UPDATE pull_requests
    SET active = 0, selected = 0
    WHERE repository_id = ? AND manual = 0 AND valued_comment_count = 0
  `).run(repository.id);
  completeDatasetScan(scanRunId, saved);

  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        repository: repository.slug,
        provider: repository.provider,
        pathFilter: repository.path_filter,
        generatedAt: new Date().toISOString(),
        scanRunId,
        scannedPullRequests: scanned,
        eligiblePullRequests: saved,
      },
      null,
      2,
    ),
  );
  db.prepare(
    "UPDATE repositories SET status = 'ready', status_message = ?, scan_current = ?, scan_total = ?, collected_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(
    `Collected ${saved} PRs after scanning ${scanned}`,
    scanned,
    scanned,
    saved,
    repository.id,
  );
}
