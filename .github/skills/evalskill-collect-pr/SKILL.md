---
name: evalskill-collect-pr
description: Collect an evaluation PR set after asking for the repository, target eligible PR count, scan limit, and strict-confirmed or resolved-comment selection policy.
---

# EvalSkill-CollectPR

Use this skill when the user wants to collect pull requests for a PR-review
skill evaluation.

## Collect the required inputs

Before starting a scan, explain the two available PR collection policies:

- **Strict human confirmation** (`strict_confirmed`): collect only actionable
  defects explicitly confirmed by the PR owner or by configured confirmation
  words. This produces the higher-confidence benchmark set.
- **Normal resolved comments** (`resolved_comments`): collect substantive
  resolved review threads without requiring explicit owner confirmation. Bot,
  author, test-only, formatting-only, and other low-value comments remain
  excluded. This mode currently requires Azure DevOps thread-resolution
  metadata.

Ask the user for these values together:

1. GitHub repository link/name or Azure DevOps repository URL.
2. Target number of eligible PRs to retain, from 1 through 100.
3. Maximum number of recent merged PRs to scan.
4. One of the two collection policies above.

Do not infer the collection policy. If the user does not choose one, recommend
**Strict human confirmation** but wait for confirmation. Require the scan limit
to be at least the target PR count.

## Run collection

1. Confirm the required GitHub or Azure DevOps authentication and read access.
2. Start the application and durable worker with `npm run dev:all` when they
   are not already running. Do not use `npm run dev` alone.
3. Configure the repository with the supplied target count, scan limit, and
   collection policy.
4. Start or resume the repository scan through the local application.
5. Report scan progress and the final retained count. Explain that the scanner
   may inspect more PRs than it retains because only PRs satisfying the chosen
   eligibility policy count toward the target.

Collection is read-only with respect to the remote repository. Never create,
edit, resolve, or delete PR comments, reviews, votes, statuses, labels,
branches, or other remote state.

## Preserve benchmark ground truth

Keep all eligible valued defects; do not cap credits per PR. When a changed-path
filter is configured, require at least one changed file under that filter, but
retain exact out-of-filter changed files that contain credited defects.
Exclude pathless PR-level comments while a path filter is active.

