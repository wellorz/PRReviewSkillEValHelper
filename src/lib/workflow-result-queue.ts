import type Database from "better-sqlite3";

export function queuePersonalSkillResults(
  db: Database.Database,
  options: {
    skillIds: number[];
    pullRequestIds: number[];
    model: string;
    modelSecondary: string;
    contextTier: string;
  },
) {
  const queue = db.prepare(`
    INSERT INTO personal_skill_results (
      skill_id, pull_request_id, baseline_profile_id, model,
      model_secondary, context_tier, status
    ) VALUES (?, ?, NULL, ?, ?, ?, 'pending')
    ON CONFLICT(
      skill_id, pull_request_id, model, model_secondary, context_tier
    ) DO UPDATE SET
      baseline_profile_id = NULL,
      status = 'pending',
      duration_ms = NULL,
      findings_json = NULL,
      usage_json = NULL,
      metrics_json = NULL,
      raw_output_json = NULL,
      repository_commit = NULL,
      error = NULL,
      report_path = NULL,
      completed_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const skillId of options.skillIds) {
    for (const pullRequestId of options.pullRequestIds) {
      queue.run(
        skillId,
        pullRequestId,
        options.model,
        options.modelSecondary,
        options.contextTier,
      );
    }
  }
}

export function queueBaselineProfileResults(
  db: Database.Database,
  options: {
    profileIds: number[];
    pullRequestIds: number[];
  },
) {
  const queue = db.prepare(`
    INSERT INTO baseline_profile_results (
      profile_id, pull_request_id, status
    ) VALUES (?, ?, 'pending')
    ON CONFLICT(profile_id, pull_request_id) DO UPDATE SET
      status = 'pending',
      duration_ms = NULL,
      findings_json = NULL,
      usage_json = NULL,
      metrics_json = NULL,
      raw_output = NULL,
      repository_commit = NULL,
      error = NULL,
      completed_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const profileId of options.profileIds) {
    for (const pullRequestId of options.pullRequestIds) {
      queue.run(profileId, pullRequestId);
    }
  }
}
