import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { parseRepositorySource } from "@/lib/repository-source";
import { normalizeModelId } from "@/lib/models";
import { repositorySyncQueueMessage } from "@/lib/repository-queue";
import {
  COLLECTION_MODES,
  normalizeConfirmationWords,
} from "@/lib/collection-policy";

const repositorySchema = z.object({
  slug: z.string().trim().min(1),
  skillPath: z.string().trim().min(1).optional().default("."),
  model: z.string().trim().min(1).default("gpt-5.4"),
  modelSecondary: z.string().trim().min(1).default("gpt-5.4"),
  contextTier: z.enum(["default", "long_context"]).default("default"),
  targetPrs: z.number().int().min(1).max(100).default(100),
  scanLimit: z.number().int().min(1).max(10_000).default(2_000),
  usePathFilter: z.boolean().default(true),
  pathFilter: z.string().trim().optional().default(""),
  collectionMode: z.enum(COLLECTION_MODES).default("strict_confirmed"),
  confirmationWords: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  prNumberGreaterThan: z.number().int().positive().nullable().default(null),
  prNumberLessThan: z.number().int().positive().nullable().default(null),
  prCreatedBefore: z.union([
    z.literal(""),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ]).default(""),
  baselineConcurrency: z.number().int().min(1).max(20).default(5),
}).superRefine((input, context) => {
  if (
    input.prNumberGreaterThan != null &&
    input.prNumberLessThan != null &&
    input.prNumberGreaterThan >= input.prNumberLessThan
  ) {
    context.addIssue({
      code: "custom",
      path: ["prNumberLessThan"],
      message: "The right PR number must be greater than the left PR number",
    });
  }
});

export async function POST(request: Request) {
  const parsed = repositorySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid repository settings" },
      { status: 400 },
    );
  }
  const input = parsed.data;
  let source;
  try {
    source = parseRepositorySource(input.slug);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  if (
    source.provider === "github" &&
    input.collectionMode === "resolved_comments"
  ) {
    return NextResponse.json(
      {
        error:
          "All resolved comments currently requires Azure DevOps thread-resolution metadata.",
      },
      { status: 400 },
    );
  }
  const skillPath = path.resolve(input.skillPath);
  let model: string;
  let modelSecondary: string;
  try {
    model = normalizeModelId(input.model);
    modelSecondary = normalizeModelId(input.modelSecondary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO repositories (
      slug, display_name, provider, clone_url, organization_url, project_name,
      repository_name, path_filter, skill_path, model, model_secondary,
      collection_mode, confirmation_words_json,
      context_tier, target_prs, scan_limit, pr_number_greater_than,
      pr_number_less_than, pr_created_before, baseline_concurrency,
      status, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'Waiting for worker')
    ON CONFLICT(slug) DO UPDATE SET
      display_name = excluded.display_name,
      provider = excluded.provider,
      clone_url = excluded.clone_url,
      organization_url = excluded.organization_url,
      project_name = excluded.project_name,
      repository_name = excluded.repository_name,
      path_filter = excluded.path_filter,
      collection_mode = excluded.collection_mode,
      confirmation_words_json = excluded.confirmation_words_json,
      skill_path = excluded.skill_path,
      model = excluded.model,
      model_secondary = excluded.model_secondary,
      context_tier = excluded.context_tier,
      target_prs = excluded.target_prs,
      scan_limit = excluded.scan_limit,
      pr_number_greater_than = excluded.pr_number_greater_than,
      pr_number_less_than = excluded.pr_number_less_than,
      pr_created_before = excluded.pr_created_before,
      baseline_concurrency = excluded.baseline_concurrency,
      status = 'queued',
      status_message = 'Waiting for worker',
      scan_current = 0,
      scan_total = 0,
      scan_current_prs = NULL,
      collected_count = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    source.key,
    source.displayName,
    source.provider,
    source.cloneUrl,
    source.organizationUrl,
    source.projectName,
    source.repositoryName,
    input.usePathFilter ? input.pathFilter || source.suggestedPathFilter : "",
    skillPath,
    model,
    modelSecondary,
    input.collectionMode,
    JSON.stringify(normalizeConfirmationWords(input.confirmationWords)),
    input.contextTier,
    input.targetPrs,
    input.scanLimit,
    input.prNumberGreaterThan,
    input.prNumberLessThan,
    input.prCreatedBefore || null,
    input.baselineConcurrency,
  );
  const repository = db
    .prepare("SELECT * FROM repositories WHERE slug = ?")
    .get(source.key) as { id: number };
  const statusMessage = repositorySyncQueueMessage();
  db.prepare(
    "UPDATE repositories SET status_message = ? WHERE id = ?",
  ).run(statusMessage, repository.id);
  return NextResponse.json({ repository }, { status: 201 });
}
