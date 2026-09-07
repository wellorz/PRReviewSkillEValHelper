import Link from "next/link";
import {
  comparisonState,
  type ComparisonMatrixRow,
} from "@/lib/comparison-matrix";

export function ComparisonMatrix({
  rows,
  emptyMessage = "Add baseline profiles and personal skills to build the comparison matrix.",
}: {
  rows: ComparisonMatrixRow[];
  emptyMessage?: string;
}) {
  return (
    <section className="panel comparisonPanel">
      <div className="panelHeading">
        <div>
          <span className="step">Aggregate results</span>
          <h2>PR review comparison matrix</h2>
        </div>
        <span className="badge">Credit coverage score</span>
      </div>
      <div className="tableWrap">
        <table className="comparisonTable">
          <thead>
            <tr>
              <th>Configuration</th>
              <th>Type</th>
              <th>Score</th>
              <th>Credits</th>
              <th>Completed</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>
                    {row.href ? <Link href={row.href}>{row.name}</Link> : row.name}
                  </strong>
                  <span className="subcell">{row.description}</span>
                </td>
                <td>{row.kind === "baseline" ? "Baseline" : "Personal skill"}</td>
                <td>
                  {row.summary?.percentage == null
                    ? "\u2014"
                    : row.summary.percentage.toFixed(1)}
                </td>
                <td>
                  {row.summary && row.summary.availablePoints > 0
                    ? `${row.summary.earnedPoints}/${row.summary.availablePoints}`
                    : "\u2014"}
                </td>
                <td>
                  {row.summary?.completed ?? 0}/
                  {row.summary?.totalPullRequests ?? 0}
                </td>
                <td>{comparisonState(row.summary)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="tableEmpty">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
