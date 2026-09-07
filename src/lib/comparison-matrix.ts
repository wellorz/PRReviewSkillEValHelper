export type AggregateSummary = {
  earnedPoints: number;
  availablePoints: number;
  percentage: number | null;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  notQueued: number;
  totalPullRequests: number;
};

export type ComparisonMatrixRow = {
  id: string | number;
  name: string;
  description: string;
  kind: "baseline" | "personal-skill";
  summary?: AggregateSummary;
  href?: string;
};

export function summarizeComparisonResults(
  results: Array<{ status: string; earnedPoints: number }>,
  totalPullRequests: number,
  availablePoints: number,
): AggregateSummary {
  const earnedPoints = results.reduce(
    (sum, result) =>
      sum + (result.status === "completed" ? result.earnedPoints : 0),
    0,
  );
  return {
    earnedPoints,
    availablePoints,
    percentage:
      availablePoints > 0 ? (earnedPoints / availablePoints) * 100 : null,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    running: results.filter((result) => result.status === "running").length,
    pending: results.filter((result) => result.status === "pending").length,
    notQueued:
      results.filter((result) => result.status === "not-queued").length +
      Math.max(0, totalPullRequests - results.length),
    totalPullRequests,
  };
}

export function comparisonState(summary: AggregateSummary | undefined) {
  if (summary?.running) return `${summary.running} running`;
  if (summary?.failed) return `${summary.failed} failed`;
  if (summary?.pending) return `${summary.pending} pending`;
  if (summary?.notQueued) return `${summary.notQueued} not queued`;
  return "Complete";
}
