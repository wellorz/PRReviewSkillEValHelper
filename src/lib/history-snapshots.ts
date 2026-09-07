import type {
  AggregateSummary,
  ComparisonMatrixRow,
} from "@/lib/comparison-matrix";
import { modelLabel } from "@/lib/models";
import type { ModelFinding, VariantMetrics } from "@/lib/types";

export type HistorySnapshotScope = {
  pullRequestNumbers: number[];
  pathFilter: string | null;
  pathFilterEnabled: boolean | null;
};

export type SavedPrResult = {
  pullRequest: {
    number: number;
    title: string;
    url: string;
    author: string;
    valuedCommentCount: number;
  };
  status: string;
  durationMs: number | null;
  completedAt?: string | null;
  repositoryCommit: string | null;
  metrics: VariantMetrics | null;
  summary: string;
  findings: ModelFinding[];
  rawOutput: string | null;
  error: string | null;
};

export type HistoryConfigurationSnapshot = {
  version: number;
  createdAt: string;
  repository: { id: number; name: string; slug: string };
  configuration: {
    kind: "baseline" | "personal-skill";
    name: string;
    model: string;
    modelSecondary: string;
    contextTier: string;
    description?: string;
  };
  aggregate: { earnedPoints: number; availablePoints: number };
  summary?: AggregateSummary;
  results: SavedPrResult[];
};

export type HistorySnapshotListItem = {
  id: number;
  name: string;
  createdAt: string;
  pullRequestCount: number;
  configurationCount: number;
};

export type HistorySnapshot = {
  id: number;
  repositoryId: number;
  name: string;
  createdAt: string;
  scope: HistorySnapshotScope;
  rows: Array<ComparisonMatrixRow & { reportId: number }>;
};

export function historyTimestampIso(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized).toISOString();
}

export function historySnapshotName(date: Date) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

export function formatHistoryTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(historyTimestampIso(value)));
}

export function historyConfigurationDescription(
  configuration: HistoryConfigurationSnapshot["configuration"],
) {
  if (configuration.description) return configuration.description;
  const secondary =
    configuration.kind === "baseline" || configuration.modelSecondary !== "none"
      ? ` + ${modelLabel(configuration.modelSecondary)}`
      : "";
  return `${modelLabel(configuration.model)}${secondary} \u00b7 ${configuration.contextTier === "long_context" ? "1M" : "400K"}`;
}
