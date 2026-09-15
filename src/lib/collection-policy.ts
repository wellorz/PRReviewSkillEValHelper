import { createHash } from "node:crypto";
import type { RepositoryRecord } from "@/lib/types";

export const COLLECTION_MODES = [
  "strict_confirmed",
  "resolved_comments",
] as const;

export type CollectionMode = (typeof COLLECTION_MODES)[number];

export const DEFAULT_CONFIRMATION_WORDS = [
  "good catch",
  "great catch",
  "excellent catch",
  "you're right",
  "you are right",
  "I agree",
  "valid issue",
  "valid bug",
  "valid finding",
  "real issue",
  "real bug",
  "real finding",
  "thanks ... catch/finding/spotting/reporting",
  "thank you ... catch/finding/spotting/reporting",
  "will fix",
  "will address",
  "fixed",
  "addressed",
  "corrected",
] as const;

export function normalizeCollectionMode(
  value: string | null | undefined,
): CollectionMode {
  return value === "resolved_comments" ? value : "strict_confirmed";
}

export function parseConfirmationWords(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed
        .filter((word): word is string => typeof word === "string")
        .map((word) => word.trim())
        .filter(Boolean),
    )];
  } catch {
    return [];
  }
}

export function normalizeConfirmationWords(words: string[]) {
  return [...new Set(
    words
      .map((word) => word.trim())
      .filter(Boolean),
  )];
}

export function selectionLevelForMode(mode: CollectionMode) {
  return mode === "strict_confirmed" ? 1 : 0;
}

export function collectionPolicyKey(repository: RepositoryRecord) {
  const mode = normalizeCollectionMode(repository.collection_mode);
  const words =
    mode === "strict_confirmed"
      ? parseConfirmationWords(repository.confirmation_words_json)
          .map((word) => word.toLocaleLowerCase())
          .sort()
      : [];
  return createHash("sha256")
    .update(JSON.stringify({
      mode,
      words,
      prCreatedBefore: repository.pr_created_before ?? null,
    }))
    .digest("hex")
    .slice(0, 16);
}
