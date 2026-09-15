import path from "node:path";
import { normalizeModelId } from "@/lib/models";

type ExistingReviewSettings = {
  skill_path: string;
  model: string;
  model_secondary: string;
  context_tier: string;
  baseline_concurrency: number;
};

type ReviewSettingsInput = {
  skillPath?: string;
  model?: string;
  modelSecondary?: string;
  contextTier?: "default" | "long_context";
  baselineConcurrency?: number;
};

export function resolveRepositoryReviewSettings(
  input: ReviewSettingsInput,
  existing?: ExistingReviewSettings,
) {
  return {
    skillPath: path.resolve(input.skillPath ?? existing?.skill_path ?? "."),
    model: normalizeModelId(input.model ?? existing?.model ?? "gpt-5.4"),
    modelSecondary: normalizeModelId(
      input.modelSecondary ?? existing?.model_secondary ?? "gpt-5.4",
    ),
    contextTier:
      input.contextTier ??
      (existing?.context_tier === "long_context"
        ? "long_context"
        : "default"),
    baselineConcurrency:
      input.baselineConcurrency ?? existing?.baseline_concurrency ?? 5,
  };
}

