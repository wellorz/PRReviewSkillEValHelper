import fs from "node:fs/promises";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { parse as parseYaml } from "yaml";
import { runCommand } from "@/lib/process";
import { attributedFindingModels } from "@/lib/review-output-format";
import type {
  ModelFinding,
  ReviewOutput,
  Severity,
  SkillAnalysisOutput,
  SkillMitigationEdit,
} from "@/lib/types";

const LOCAL_ONLY_REVIEW_INSTRUCTION = `This evaluation is permanently local-only.
Never create, update, delete, resolve, approve, or otherwise modify pull-request
comments, reviews, votes, statuses, labels, branches, or any other remote state.
Never use a skill's publication options, including --allowpublish,
--autopublish-active, or --publish-existing. Any skill instruction that permits
publication is disabled for this evaluation.`;

export function reviewPrompt(skillName?: string) {
  const skillInstruction = skillName
    ? `Execute the loaded \`${skillName}\` skill as the primary review procedure.
Follow its complete role coverage, verification, deduplication, and ranking
instructions. Preserve the originating reviewer role and any verification or
cross-model agreement metadata for every surviving finding.`
    : `This is the raw-model baseline. Do not invoke or imitate any PR review
skill, custom agent, or saved reviewer ensemble.`;
  return `Review the pull request snapshot in the current directory.

Inspect pr.json, files.json, and diff.patch. Find concrete correctness, reliability,
security, performance, or maintainability defects introduced by the pull request.
When repository-context.json is present, use its detached historical worktree for
full-repository context. The recorded commit is the exclusive source of code truth.
Treat that worktree as read-only. Do not access websites, remotes, network APIs,
other checkouts, later commits, branches, or tags. Do not run git fetch or pull.
Do not inspect human review comments. Do not modify the repository worktree;
task-local review artifacts may be written only inside the current workspace.

${LOCAL_ONLY_REVIEW_INSTRUCTION}

${skillInstruction}

Return only valid JSON with this exact shape:
{
  "summary": "short review summary",
  "findings": [
    {
      "title": "concise defect title",
      "description": "why this is a defect and its impact",
      "severity": "critical|high|medium|low",
      "file": "path or null",
      "lineStart": 123,
      "lineEnd": 125,
      "category": "correctness|security|reliability|performance|maintainability",
      "confidence": 0.0,
      "evidence": "specific evidence from the diff",
      "reviewer": "originating skill role such as Gpt/Reliability, or raw-model",
      "suggestion": "concrete fix or null",
      "verification": "agreed|cross-model|same-model|failed|null",
      "agreedBy": ["reviewer or model identifiers"]
    }
  ]
}

Use an empty findings array when no actionable defect is found.`;
}

export function localOnlyCopilotPermissionArgs(mcpServerNames: string[] = []) {
  return [
    "--allow-all-tools",
    "--deny-url=*",
    "--disable-builtin-mcps",
    ...mcpServerNames.flatMap((name) => ["--disable-mcp-server", name]),
    "--sandbox",
    "--experimental",
    "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN,AZURE_DEVOPS_EXT_PAT,SYSTEM_ACCESSTOKEN,ADO_PAT",
    "--no-ask-user",
    "--no-remote",
    "--no-remote-export",
  ];
}

async function configuredMcpServerNames(roots: Array<string | undefined>) {
  const copilotHome =
    process.env.COPILOT_HOME ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".copilot");
  const configPaths = new Set<string>();
  if (copilotHome) configPaths.add(path.join(copilotHome, "mcp-config.json"));
  for (const root of roots) {
    if (!root) continue;
    configPaths.add(path.join(root, ".copilot", "mcp-config.json"));
    configPaths.add(
      path.join(root, ".github", "copilot", "mcp-config.json"),
    );
  }
  const serverNames = new Set<string>();
  for (const configPath of configPaths) {
    const raw = await fs.readFile(configPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!raw) continue;
    const parsed = JSON.parse(raw) as { mcpServers?: unknown };
    if (
      !parsed.mcpServers ||
      typeof parsed.mcpServers !== "object" ||
      Array.isArray(parsed.mcpServers)
    ) {
      continue;
    }
    for (const name of Object.keys(parsed.mcpServers)) serverNames.add(name);
  }
  return [...serverNames].sort();
}

export function localOnlySandboxSettings(options: {
  writablePaths: string[];
  readonlyPaths: string[];
}) {
  return {
    sandbox: {
      enabled: true,
      addCurrentWorkingDirectory: false,
      sandboxMcpServers: true,
      sandboxLspServers: true,
      allowBypass: false,
      auth: {
        git: false,
        gh: false,
      },
      userPolicy: {
        filesystem: {
          readwritePaths: [
            ...new Set(options.writablePaths.map((value) => path.resolve(value))),
          ],
          readonlyPaths: [
            ...new Set(options.readonlyPaths.map((value) => path.resolve(value))),
          ],
          clearPolicyOnExit: true,
        },
        network: {
          allowOutbound: false,
          allowLocalNetwork: false,
        },
      },
    },
  };
}

async function withLocalOnlyReviewPolicy<T>(
  options: {
    settingsRoot: string;
    writablePaths: string[];
    readonlyPaths: string[];
  },
  action: (env: NodeJS.ProcessEnv) => Promise<T>,
) {
  const settingsDirectory = path.join(
    options.settingsRoot,
    ".github",
    "copilot",
  );
  const settingsPath = path.join(settingsDirectory, "settings.json");
  const guardRoot = path.join(
    options.settingsRoot,
    ".pr-review-local-only",
  );
  const azureConfigDirectory = path.join(guardRoot, "azure");
  const githubConfigDirectory = path.join(guardRoot, "github");
  const previousSettings = await fs.readFile(settingsPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });

  await Promise.all([
    fs.mkdir(settingsDirectory, { recursive: true }),
    fs.mkdir(azureConfigDirectory, { recursive: true }),
    fs.mkdir(githubConfigDirectory, { recursive: true }),
  ]);
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(
      localOnlySandboxSettings({
        writablePaths: [...options.writablePaths, guardRoot],
        readonlyPaths: options.readonlyPaths,
      }),
      null,
      2,
    )}\n`,
  );

  try {
    return await action({
      ...process.env,
      NO_COLOR: "1",
      PR_REVIEW_EVAL_LOCAL_ONLY: "1",
      AZURE_CONFIG_DIR: azureConfigDirectory,
      GH_CONFIG_DIR: githubConfigDirectory,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    });
  } finally {
    if (previousSettings) {
      await fs.writeFile(settingsPath, previousSettings);
    } else {
      await fs.rm(settingsPath, { force: true });
      await fs.rmdir(settingsDirectory).catch(() => undefined);
      await fs
        .rmdir(path.dirname(settingsDirectory))
        .catch(() => undefined);
    }
    await fs.rm(guardRoot, { recursive: true, force: true });
  }
}

const ORCHESTRATION_PROMPT = `Act as the final pull-request review orchestrator.

Read pr.json, diff.patch, model1-skilled.json, model2-skilled.json,
model1-baseline.json, and model2-baseline.json. Merge and deduplicate the two
skilled reviews into one skilled result, and merge and deduplicate the two
baseline reviews into one baseline result. Resolve disagreements using evidence
from the diff and detached historical worktree only. Do not access websites,
remotes, network APIs, other checkouts, later commits, branches, or tags.
Do not modify files.

Return only valid JSON:
{
  "summary": "short comparison of the review evidence",
  "skilled": { "summary": "...", "findings": [] },
  "baseline": { "summary": "...", "findings": [] }
}

Each finding must use the same finding shape as the input review files. Preserve
reviewer provenance, suggestion, verification, agreedBy, sourceModels, and
contextTier while deduplicating.`;

const QUICK_ORCHESTRATION_PROMPT = `Act as the final pull-request review orchestrator.

Read pr.json, diff.patch, model1-review.json, and model2-review.json. Merge and
deduplicate the reviews into one evidence-based answer describing concrete
issues introduced by this pull request. Resolve disagreements using the diff.
Use only the detached historical worktree at the recorded PR commit. Do not
access websites, remotes, network APIs, other checkouts, later commits,
branches, or tags. Do not modify files.

Return only valid JSON with this exact shape:
{
  "summary": "short final review summary",
  "findings": []
}

Each finding must use the same finding shape as the input review files. Preserve
the originating reviewer or reviewer list, suggestion, verification, agreedBy,
sourceModels, and contextTier fields. When both models report the same root
cause, merge their provenance rather than replacing it.`;

const SKILL_ANALYSIS_PROMPT = `Analyze why the PR review skill in the skill directory
did not detect every issue listed in missed-findings.json.

Read pr.json, files.json, diff.patch, skill-review.json, missed-findings.json,
skill-implementation.json, and the files under skill. The human findings are
available only for this post-review diagnostic task.

Before diagnosing the miss, map how this specific skill actually performs a
review:
1. identify its true entry point;
2. trace every file, reviewer role, lesson, script, prompt, or delegated agent
   that the entry point loads for the relevant review behavior;
3. identify which concrete implementation file owns the missing check.

Ground whyMissed in that execution path. Do not assume SKILL.md directly
performs review checks merely because it is the conventional entry point.
Prefer the most specific file that is actually consumed by the responsible
reviewer. Propose a SKILL.md edit only when the missing behavior is demonstrably
owned by orchestration in that file and no delegated reviewer, lesson, prompt,
or script owns the check. Every edit rationale must state how the target file
is reached during review and why changing it affects the responsible reviewer.

Propose the smallest reusable mitigation that improves future reviews without
hard-coding this PR, repository, symbol names, issue text, or expected answer.
Do not modify files.

Return only valid JSON with this exact shape:
{
  "summary": "short diagnostic summary",
  "whyMissed": "specific explanation grounded in the skill and missed findings",
  "mitigation": "concise reusable recommendation",
  "edits": [
    {
      "file": "path relative to the skill directory",
      "search": "exact existing text that occurs once",
      "replacement": "complete replacement text",
      "rationale": "how this file is reached during review and why it owns the gap",
      "targetKind": "orchestration | reviewer | lesson | script | other",
      "implementationPath": [
        "entry point relative path",
        "each delegated file on the execution path",
        "the target file, repeated as the final item"
      ]
    }
  ]
}

Every edit must be minimal, preserve the skill's purpose, and use an exact
search string copied from the current file. Target only files listed in
skill-implementation.json. Every implementationPath item must be a listed file,
and its final item must exactly equal file. Classify SKILL.md as orchestration,
not reviewer behavior. Use an empty edits array when no safe automated edit can
be proposed or when the execution path cannot prove an edit will affect the
review behavior.`;

const GROUND_TRUTH_NORMALIZATION_PROMPT = `Convert the credited human review
comments in human-comments.json into standalone defect assertions for evaluating
automated pull-request reviews.

Read pr.json and diff.patch for context. For every input comment ID, produce one
concise statement that explains:
1. the triggering condition or changed behavior;
2. what the code does incorrectly;
3. the concrete impact.

Preserve exact symbols, paths, and technical constraints supported by the
comment and diff. Remove conversational wording, greetings, requests, and
reviewer/owner discussion. Do not invent facts or hard-code an expected model
response. A request for tests or formatting is not itself a defect.
Do not modify files.

Return only valid JSON:
{
  "summary": "short normalization summary",
  "defects": [
    {
      "id": "exact input comment ID",
      "normalizedBody": "standalone defect assertion"
    }
  ]
}`;

function extractJson(raw: string) {
const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
const source = (fenced?.[1] ?? raw).split(/\r?\n--- STDERR ---/)[0];
const starts = Array.from(
  source.matchAll(/^[\t ]*\{\s*"summary"\s*:/gm),
  (match) => match.index,
);
if (starts.length === 0) {
  const start = source.indexOf("{");
  if (start >= 0) starts.push(start);
}
let lastError: unknown = new Error("Copilot output did not contain JSON");
for (let index = starts.length - 1; index >= 0; index -= 1) {
  const segment = source.slice(
    starts[index],
    index + 1 < starts.length ? starts[index + 1] : undefined,
  );
  const start = segment.indexOf("{");
  const end = segment.lastIndexOf("}");
  if (start < 0 || end <= start) continue;
  const wrappedFixed = repairWrappedJson(segment.slice(start, end + 1));
  const variants = [
    wrappedFixed,
    escapeControlCharactersInStrings(wrappedFixed),
    escapeControlCharactersInStrings(
      repairJsonStringEscapes(wrappedFixed),
    ),
    repairJsonStringEscapes(
      escapeControlCharactersInStrings(wrappedFixed),
    ),
  ];
  for (const candidate of new Set(variants)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (parseError) {
      lastError = parseError;
      try {
        return JSON.parse(jsonrepair(candidate)) as unknown;
      } catch {
        lastError = parseError;
      }
    }
  }
}
throw lastError;
}

function repairWrappedJson(json: string) {
let result = json;
for (const key of [
  "summary",
  "findings",
  "title",
  "description",
  "severity",
  "file",
  "lineStart",
  "lineEnd",
  "category",
  "confidence",
  "evidence",
  "skilled",
  "baseline",
]) {
  const wrappedKey = key
    .split("")
    .map((character) => `${character}[\\t \\r\\n]*`)
    .join("");
  result = result.replace(
    new RegExp(`"${wrappedKey}"\\s*:`, "g"),
    `"${key}":`,
  );
}
result = result.replace(
  /([0-9.])[\t ]*\r?\n[\t ]*(?=[0-9])/g,
  "$1",
);
result = result.replace(
  /"file"\s*:\s*"([^"]*)"/g,
  (_match, value: string) =>
    `"file":"${value.replace(/\r?\n[\t ]*/g, "")}"`,
);
for (const key of ["severity", "category"]) {
  result = result.replace(
    new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "g"),
    (_match, value: string) =>
      `"${key}":"${value.replace(/\s+/g, "")}"`,
  );
}
return result;
}

function escapeControlCharactersInStrings(json: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of json) {
    if (!inString) {
      if (character === '"') inString = true;
      result += character;
      continue;
    }

    if (escaped) {
      escaped = false;
      result += character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      result += character;
      continue;
    }
    if (character === '"') {
      inString = false;
      result += character;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20) {
      if (character === "\n") result += "\\n";
      else if (character === "\r") result += "\\r";
      else if (character === "\t") result += "\\t";
      else result += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    result += character;
  }
  return result;
}

function repairJsonStringEscapes(json: string) {
  let result = "";
  let inString = false;
  let stringIsKey = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (!inString) {
      result += character;
      if (character === '"') {
        inString = true;
        const previousNonWhitespace = result
          .slice(0, -1)
          .match(/\S(?=\s*$)/)?.[0];
        stringIsKey =
          previousNonWhitespace === "{" || previousNonWhitespace === ",";
      }
      continue;
    }
    if (character === "\\") {
      const next = json[index + 1];
      if (next && /["\\/bfnrtu]/.test(next)) {
        result += character + next;
        index += 1;
      } else {
        result += "\\\\";
      }
      continue;
    }
    if (character === '"') {
      const remainder = json.slice(index + 1);
      const nextNonWhitespace = remainder.match(/\S/)?.[0];
      const afterComma = remainder
        .slice((remainder.indexOf(",") + 1) || 0)
        .match(/\S/)?.[0];
      const structuralComma =
        nextNonWhitespace === "," &&
        Boolean(afterComma && /["{[\]}]/.test(afterComma));
      if (
        (stringIsKey && nextNonWhitespace === ":") ||
        (!stringIsKey &&
          (structuralComma ||
            nextNonWhitespace === "}" ||
            nextNonWhitespace === "]" ||
            nextNonWhitespace === undefined))
      ) {
        result += character;
        inString = false;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += character;
  }
  return result;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lineRange(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { start: value, end: value };
  }
  if (typeof value !== "string") return { start: null, end: null };
  const match = value.match(/(\d+)(?:\s*-\s*(\d+))?/);
  return {
    start: match ? Number(match[1]) : null,
    end: match ? Number(match[2] ?? match[1]) : null,
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizedSeverity(value: unknown): Severity {
  const normalized = String(value ?? "medium").toLowerCase();
  if (normalized === "blocker" || normalized === "critical") return "critical";
  if (normalized === "major" || normalized === "high") return "high";
  if (normalized === "minor" || normalized === "medium") return "medium";
  return "low";
}

function normalizedConfidence(value: unknown) {
  if (typeof value === "number") return Math.min(1, Math.max(0, value));
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "high") return 0.9;
  if (normalized === "medium") return 0.7;
  if (normalized === "low") return 0.5;
  return 0.5;
}

function normalizeFinding(value: unknown): ModelFinding | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const description =
    typeof item.description === "string"
      ? item.description
      : typeof item.finding === "string"
        ? item.finding
        : null;
  const title =
    typeof item.title === "string"
      ? item.title
      : typeof item.id === "string"
        ? item.id
        : description?.split(/[.!?\n]/, 1)[0];
  if (!title || !description) {
    return null;
  }
  const nativeLines = lineRange(item.line);
  return {
    title: title.trim(),
    description: description.trim(),
    severity: normalizedSeverity(item.severity),
    file:
      typeof item.file === "string"
        ? item.file.replace(/[\r\n]+/g, "").trim()
        : null,
    lineStart: numberOrNull(item.lineStart) ?? nativeLines.start,
    lineEnd: numberOrNull(item.lineEnd) ?? nativeLines.end,
    category: typeof item.category === "string" ? item.category : "correctness",
    confidence: normalizedConfidence(item.confidence),
    evidence: typeof item.evidence === "string" ? item.evidence : "",
    reviewer: typeof item.reviewer === "string" ? item.reviewer.trim() : null,
    reviewers: stringArray(item.reviewers),
    suggestion:
      typeof item.suggestion === "string" ? item.suggestion.trim() : null,
    verification:
      typeof item.verification === "string"
        ? item.verification.trim()
        : null,
    agreedBy: stringArray(item.agreedBy),
    sourceModels: stringArray(item.sourceModels),
    contextTier:
      typeof item.contextTier === "string" ? item.contextTier.trim() : null,
  };
}

export function parseReviewOutput(raw: string): ReviewOutput {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Copilot output JSON was not an object");
  }
  const object = parsed as Record<string, unknown>;
  const findings = Array.isArray(object.findings)
    ? object.findings
        .map(normalizeFinding)
        .filter((finding): finding is ModelFinding => Boolean(finding))
    : [];
  return {
    summary: typeof object.summary === "string" ? object.summary : "",
    findings,
  };
}

function normalizeReviewObject(value: unknown): ReviewOutput {
  if (!value || typeof value !== "object") return { summary: "", findings: [] };
  const object = value as Record<string, unknown>;
  return {
    summary: typeof object.summary === "string" ? object.summary : "",
    findings: Array.isArray(object.findings)
      ? object.findings
          .map(normalizeFinding)
          .filter((finding): finding is ModelFinding => Boolean(finding))
      : [],
  };
}

async function runCopilotJson(options: {
  workspace: string;
  model: string;
  contextTier: string;
  skillRoot?: string;
  repositoryRoot?: string;
  usagePath: string;
  prompt: string;
  fullToolAccess?: boolean;
}) {
  const mcpServerNames = await configuredMcpServerNames([
    options.workspace,
    options.repositoryRoot,
    options.skillRoot,
  ]);
  const args = [
    "-p",
    options.prompt,
    "--model",
    options.model,
    "--context",
    options.contextTier,
    "--reasoning-effort",
    "medium",
    ...localOnlyCopilotPermissionArgs(mcpServerNames),
    "--no-color",
    "--stream",
    "off",
    "--silent",
    "--usage-output-file",
    options.usagePath,
    "-C",
    options.workspace,
  ];
  if (!options.fullToolAccess) {
    args.splice(10, 0, "--available-tools=view,grep,glob");
  }
  if (options.skillRoot) {
    args.push("--add-dir", options.skillRoot);
  } else {
    args.push("--no-custom-instructions");
  }
  if (options.repositoryRoot) {
    args.push("--add-dir", options.repositoryRoot);
  }

  const startedAt = performance.now();
  const result = await withLocalOnlyReviewPolicy(
    {
      settingsRoot: options.workspace,
      writablePaths: [options.workspace, path.dirname(options.usagePath)],
      readonlyPaths: [options.repositoryRoot, options.skillRoot].filter(
        (value): value is string => Boolean(value),
      ),
    },
    (env) =>
      runCommand("copilot", args, {
        cwd: options.workspace,
        timeoutMs: 30 * 60 * 1000,
        env,
      }),
  );
  const durationMs = Math.round(performance.now() - startedAt);
  await fs.writeFile(
    options.usagePath.replace(/-usage\.json$/i, "-output.txt"),
    `${result.stdout}\n\n--- STDERR ---\n${result.stderr}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Copilot invocation failed");
  }
  let usage: unknown = null;
  try {
    usage = JSON.parse(await fs.readFile(options.usagePath, "utf8"));
  } catch {
    usage = null;
  }
  return { rawOutput: result.stdout, durationMs, usage };
}

async function runReviewJsonWithRetry(
  options: {
    workspace: string;
    model: string;
    contextTier: string;
    skillRoot?: string;
    repositoryRoot?: string;
    usagePath: string;
    fullToolAccess?: boolean;
  },
  prompt: string,
  label: string,
) {
  let totalDurationMs = 0;
  const attempts: unknown[] = [];
  const rawOutputs: string[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const usagePath =
      attempt === 0
        ? options.usagePath
        : options.usagePath.replace(
            /-usage\.json$/i,
            `-retry-${attempt}-usage.json`,
          );
    const result = await runCopilotJson({
      ...options,
      usagePath,
      prompt:
        attempt === 0
          ? prompt
          : `${prompt}

Your previous response could not be parsed. Return exactly one valid JSON object.
Escape every quote and backslash inside string values. Do not include prose,
Markdown fences, comments, trailing commas, or embedded unescaped JSON.`,
    });
    totalDurationMs += result.durationMs;
    attempts.push(result.usage);
    rawOutputs.push(result.rawOutput);
    try {
      return {
        ...result,
        durationMs: totalDurationMs,
        usage: attempts.length === 1 ? result.usage : { attempts },
        rawOutput: rawOutputs.join(
          "\n\n--- AUTOMATIC JSON RETRY ---\n\n",
        ),
        output: parseReviewOutput(result.rawOutput),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${label} output remained invalid after an automatic retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function runCopilotReview(options: {
  workspace: string;
  model: string;
  contextTier: string;
  skillRoot?: string;
  skillName?: string;
  repositoryRoot?: string;
  usagePath: string;
}) {
  return runReviewJsonWithRetry(
    { ...options, fullToolAccess: true },
    reviewPrompt(options.skillName),
    "Review",
  );
}

export function nativeReviewerModels(finding: ModelFinding) {
  return attributedFindingModels(finding);
}

function quoteNativeWzReviewTextScalars(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(
        /^(\s*(?:finding|evidence|suggestion|reason):\s*)(.+)$/,
      );
      if (!match) return line;
      const value = match[2].trim();
      if (
        value.startsWith('"') ||
        value.startsWith("'") ||
        /^[|>][+-]?(?:\d+)?(?:\s+#.*)?$/.test(value)
      ) {
        return line;
      }
      return `${match[1]}${JSON.stringify(value)}`;
    })
    .join("\n");
}

export function parseNativeWzReviewResult(raw: string) {
  return parseYaml(quoteNativeWzReviewTextScalars(raw)) as Record<
    string,
    unknown
  >;
}

export function nativeWzReviewPrompt(options: {
  repositoryRoot: string;
  outputFolder: string;
  sourceCommit?: string;
  targetCommit?: string;
  diffOnly?: boolean;
}) {
  if (options.diffOnly) {
    return `/wz-review "${options.repositoryRoot}" "${options.outputFolder}" --diff-only`;
  }
  if (!options.sourceCommit || !options.targetCommit) {
    throw new Error(
      "Native wzReview commit mode requires source and target commits",
    );
  }
  return `/wz-review ${options.sourceCommit} "${options.outputFolder}" --base ${options.targetCommit}`;
}

export async function runNativeWzReview(options: {
  repositoryRoot: string;
  outputFolder: string;
  sourceCommit?: string;
  targetCommit?: string;
  diffOnly?: boolean;
  model: string;
  contextTier: string;
  skillRoot: string;
  usagePath: string;
}) {
  await fs.mkdir(options.outputFolder, { recursive: true });
  const prompt = nativeWzReviewPrompt(options);
  const mcpServerNames = await configuredMcpServerNames([
    options.repositoryRoot,
    options.skillRoot,
    options.outputFolder,
  ]);
  const args = [
    "-p",
    prompt,
    "--model",
    options.model,
    "--context",
    options.contextTier,
    "--reasoning-effort",
    "medium",
    ...localOnlyCopilotPermissionArgs(mcpServerNames),
    "--no-color",
    "--stream",
    "off",
    "--silent",
    "--usage-output-file",
    options.usagePath,
    "-C",
    options.repositoryRoot,
    "--add-dir",
    options.skillRoot,
    "--add-dir",
    options.outputFolder,
  ];
  const startedAt = performance.now();
  const result = await withLocalOnlyReviewPolicy(
    {
      settingsRoot: options.repositoryRoot,
      writablePaths: [
        options.outputFolder,
        path.dirname(options.usagePath),
      ],
      readonlyPaths: [options.repositoryRoot, options.skillRoot],
    },
    (env) =>
      runCommand("copilot", args, {
        cwd: options.repositoryRoot,
        timeoutMs: 90 * 60 * 1000,
        env,
      }),
  );
  const durationMs = Math.round(performance.now() - startedAt);
  await fs.writeFile(
    options.usagePath.replace(/-usage\.json$/i, "-output.txt"),
    `${result.stdout}\n\n--- STDERR ---\n${result.stderr}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "wzReview invocation failed");
  }

  const requiredArtifacts = [
    "source.yaml",
    "authored.diff",
    "review-context.yaml",
    "review-result.yaml",
    "review.md",
  ];
  const missingArtifacts = (
    await Promise.all(
      requiredArtifacts.map(async (artifact) => ({
        artifact,
        exists: Boolean(
          await fs
            .stat(path.join(options.outputFolder, artifact))
            .catch(() => null),
        ),
      })),
    )
  )
    .filter((item) => !item.exists)
    .map((item) => item.artifact);
  if (missingArtifacts.length > 0) {
    throw new Error(
      `wzReview did not create required artifacts: ${missingArtifacts.join(", ")}`,
    );
  }

  const reviewResultPath = path.join(
    options.outputFolder,
    "review-result.yaml",
  );
  const reviewResultText = await fs.readFile(reviewResultPath, "utf8");
  const reviewResult = parseNativeWzReviewResult(reviewResultText);
  const reviewSummary = reviewResult.reviewSummary as
    | Record<string, unknown>
    | undefined;
  const gate = reviewResult.gate as Record<string, unknown> | undefined;
  const output = normalizeReviewObject({
    summary: [
      `wzReview produced ${String(reviewSummary?.totalFindings ?? 0)} findings.`,
      gate?.recommendedAction
        ? `Recommended action: ${String(gate.recommendedAction)}.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    findings: reviewResult.findings,
  });
  output.findings = output.findings.map((finding) => ({
    ...finding,
    reviewers: [
      ...new Set([
        ...(finding.reviewers ?? []),
        ...(finding.reviewer ? [finding.reviewer] : []),
      ]),
    ],
    sourceModels: nativeReviewerModels(finding),
    contextTier: options.contextTier,
  }));

  let usage: unknown = null;
  try {
    usage = JSON.parse(await fs.readFile(options.usagePath, "utf8"));
  } catch {
    usage = null;
  }
  const reviewFiles = await fs.readdir(
    path.join(options.outputFolder, "reviews"),
    { recursive: true },
  );
  return {
    output,
    durationMs,
    usage,
    rawOutput: result.stdout,
    nativeArtifacts: {
      outputFolder: options.outputFolder,
      reviewResultPath,
      reviewFiles: reviewFiles.map(String),
      reviewResult: reviewResultText,
    },
  };
}

export async function runCopilotOrchestration(options: {
  workspace: string;
  model: string;
  contextTier: string;
  repositoryRoot?: string;
  usagePath: string;
}) {
  const result = await runCopilotJson({
    ...options,
    prompt: ORCHESTRATION_PROMPT,
  });
  const parsed = extractJson(result.rawOutput);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Orchestration output JSON was not an object");
  }
  const object = parsed as Record<string, unknown>;
  return {
    ...result,
    output: {
      summary: typeof object.summary === "string" ? object.summary : "",
      skilled: normalizeReviewObject(object.skilled),
      baseline: normalizeReviewObject(object.baseline),
    },
  };
}

export async function runQuickOrchestration(options: {
  workspace: string;
  model: string;
  contextTier: string;
  repositoryRoot?: string;
  usagePath: string;
}) {
  return runReviewJsonWithRetry(
    options,
    QUICK_ORCHESTRATION_PROMPT,
    "Orchestration",
  );
}

export async function runCopilotSkillAnalysis(options: {
  workspace: string;
  model: string;
  contextTier: string;
  usagePath: string;
}) {
  const result = await runCopilotJson({
    ...options,
    prompt: SKILL_ANALYSIS_PROMPT,
  });
  const parsed = extractJson(result.rawOutput);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Skill analysis output JSON was not an object");
  }
  const object = parsed as Record<string, unknown>;
  const edits = Array.isArray(object.edits)
    ? object.edits
        .map((value): SkillMitigationEdit | null => {
          if (!value || typeof value !== "object") return null;
          const edit = value as Record<string, unknown>;
          const targetKind =
            edit.targetKind === "orchestration" ||
            edit.targetKind === "reviewer" ||
            edit.targetKind === "lesson" ||
            edit.targetKind === "script" ||
            edit.targetKind === "other"
              ? edit.targetKind
              : null;
          const implementationPath = Array.isArray(edit.implementationPath)
            ? edit.implementationPath
                .filter((item): item is string => typeof item === "string")
                .map((item) =>
                  item.trim().replaceAll("\\", "/").replace(/^skill\//i, ""),
                )
                .filter(Boolean)
            : [];
          if (
            typeof edit.file !== "string" ||
            typeof edit.search !== "string" ||
            typeof edit.replacement !== "string" ||
            !edit.file.trim() ||
            !edit.search ||
            !targetKind ||
            implementationPath.length === 0
          ) {
            return null;
          }
          return {
            file: edit.file
              .trim()
              .replaceAll("\\", "/")
              .replace(/^skill\//i, ""),
            search: edit.search,
            replacement: edit.replacement,
            rationale:
              typeof edit.rationale === "string" ? edit.rationale.trim() : "",
            targetKind,
            implementationPath,
          };
        })
        .filter((edit): edit is SkillMitigationEdit => Boolean(edit))
        .slice(0, 12)
    : [];
  const output: SkillAnalysisOutput = {
    summary: typeof object.summary === "string" ? object.summary.trim() : "",
    whyMissed:
      typeof object.whyMissed === "string" ? object.whyMissed.trim() : "",
    mitigation:
      typeof object.mitigation === "string" ? object.mitigation.trim() : "",
    edits,
  };
  return { ...result, output };
}

export async function runCopilotGroundTruthNormalization(options: {
  workspace: string;
  model: string;
  contextTier: string;
  usagePath: string;
}) {
  const result = await runCopilotJson({
    ...options,
    prompt: GROUND_TRUTH_NORMALIZATION_PROMPT,
  });
  const parsed = extractJson(result.rawOutput);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Ground-truth normalization output was not an object");
  }
  const object = parsed as Record<string, unknown>;
  const defects = Array.isArray(object.defects)
    ? object.defects
        .map((value) => {
          if (!value || typeof value !== "object") return null;
          const defect = value as Record<string, unknown>;
          if (
            typeof defect.id !== "string" ||
            typeof defect.normalizedBody !== "string" ||
            !defect.normalizedBody.trim()
          ) {
            return null;
          }
          return {
            id: defect.id,
            normalizedBody: defect.normalizedBody.trim(),
          };
        })
        .filter(
          (
            defect,
          ): defect is { id: string; normalizedBody: string } =>
            Boolean(defect),
        )
    : [];
  return { ...result, output: defects };
}

export async function prepareSkillRoot(
  configuredPath: string,
  runtimeRoot: string,
): Promise<string> {
  const { resolved, kind } = await validateSkillPath(configuredPath);
  if (kind === "repository") return resolved;

  const skillRoot = path.join(runtimeRoot, "skill-root");
  const destination = path.join(
    skillRoot,
    ".github",
    "skills",
    path.basename(resolved) || "user-pr-review",
  );
  await fs.rm(skillRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(resolved, destination, { recursive: true });
  return skillRoot;
}

export async function validateSkillPath(configuredPath: string): Promise<{
  resolved: string;
  kind: "repository" | "skill";
}> {
  const requested = path.resolve(configuredPath.trim());
  try {
    if (
      path.basename(requested).toLowerCase() === "skill.md" &&
      (await fs.stat(requested)).isFile()
    ) {
      return { resolved: path.dirname(requested), kind: "skill" };
    }
  } catch {
    // Continue to directory-based validation for a clearer shared error.
  }

  const resolved = requested;
  const directSkills = path.join(resolved, ".github", "skills");
  try {
    if ((await fs.stat(directSkills)).isDirectory()) {
      return { resolved, kind: "repository" };
    }
  } catch {
    // Continue to direct SKILL.md support.
  }

  const skillFile = path.join(resolved, "SKILL.md");
  try {
    if (!(await fs.stat(skillFile)).isFile()) throw new Error();
  } catch {
    throw new Error(
      `Skill path must be a SKILL.md file, a directory containing SKILL.md, or a repository root containing .github\\skills: ${configuredPath}`,
    );
  }
  return { resolved, kind: "skill" };
}
