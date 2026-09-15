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

export type ComparisonScoreSortDirection = "asc" | "desc";

export function sortComparisonRowsByScore(
  rows: ComparisonMatrixRow[],
  direction: ComparisonScoreSortDirection | null,
) {
  if (!direction) return rows;
  const multiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftScore = left.row.summary?.percentage;
      const rightScore = right.row.summary?.percentage;
      if (leftScore == null && rightScore == null) {
        return left.index - right.index;
      }
      if (leftScore == null) return 1;
      if (rightScore == null) return -1;
      const difference = (leftScore - rightScore) * multiplier;
      return difference || left.index - right.index;
    })
    .map(({ row }) => row);
}

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
