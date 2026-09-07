import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const repositories = db
    .prepare(`
      SELECT r.*,
        COUNT(CASE WHEN p.active = 1 THEN 1 END) AS pr_count,
        COALESCE(SUM(CASE WHEN p.active = 1 THEN p.valued_comment_count ELSE 0 END), 0) AS human_finding_count,
        scan.status AS latest_scan_status,
        scan.scanned_count AS latest_scan_scanned_count,
        scan.skipped_count AS latest_scan_skipped_count,
        scan.newest_pr_number AS latest_scan_newest_pr,
        scan.oldest_pr_number AS latest_scan_oldest_pr,
        scan.newest_source_date AS latest_scan_newest_date,
        scan.oldest_source_date AS latest_scan_oldest_date,
        scan.policy_version AS latest_scan_policy_version,
        scan.started_at AS latest_scan_started_at,
        scan.completed_at AS latest_scan_completed_at
      FROM repositories r
      LEFT JOIN pull_requests p ON p.repository_id = r.id
      LEFT JOIN dataset_scan_runs scan ON scan.id = (
        SELECT id
        FROM dataset_scan_runs
        WHERE repository_id = r.id
        ORDER BY id DESC
        LIMIT 1
      )
      GROUP BY r.id, scan.id
      ORDER BY r.updated_at DESC
    `)
    .all();
  const runs = db
    .prepare(`
      SELECT runs.*, repositories.slug,
        (SELECT COUNT(*) FROM metrics WHERE metrics.run_id = runs.id) AS completed_prs
      FROM runs
      JOIN repositories ON repositories.id = runs.repository_id
      ORDER BY runs.id DESC
      LIMIT 30
    `)
    .all();
  const schedules = db
    .prepare(`
      SELECT schedules.*, repositories.slug
      FROM schedules
      JOIN repositories ON repositories.id = schedules.repository_id
      ORDER BY schedules.id DESC
    `)
    .all();
  const quickReviews = db
    .prepare(`
      SELECT quick_reviews.*, repositories.slug
      FROM quick_reviews
      JOIN repositories ON repositories.id = quick_reviews.repository_id
      ORDER BY quick_reviews.id DESC
      LIMIT 30
    `)
    .all();
  return NextResponse.json({ repositories, runs, schedules, quickReviews });
}
