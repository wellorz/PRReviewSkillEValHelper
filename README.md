# Review Skill Lab

A local web application for testing whether a GitHub Copilot pull-request review
skill performs better than the same model reviewing without that skill.

The application:

- scans recent merged PRs and keeps up to 100 with substantive human review
  comments;
- stores each eligible PR as an immutable local dataset folder;
- runs skilled and baseline reviews with two models, using identical inputs per
  model;
- uses Model 1 to orchestrate and deduplicate both models after all reviews;
- matches model findings to valued human findings using file, line, and semantic
  overlap;
- records precision, recall, F1, false positives, match quality, elapsed time,
  and Copilot usage;
- writes a report for every PR quiz and an aggregate run report;
- provides a single dashboard for configuration, collection, runs, schedules,
  progress, and reports.

## Requirements

- Node.js 20 or newer
- GitHub CLI authenticated with `gh auth login` for GitHub repositories
- Azure CLI with the Azure DevOps extension for Azure DevOps repositories:
  `az extension add --name azure-devops`
- GitHub Copilot CLI authenticated and available as `copilot`

The active CLI identity needs read access to the repository and its pull
requests. Existing Git Credential Manager authentication is used for Azure
DevOps Git fetches.

## Start

```powershell
npm install
npm run dev:all
```

Open the URL printed by Next.js. `dev:all` starts both the web UI and the durable
worker. The worker must remain active for dataset scans, scheduled runs, and
Copilot evaluations.

On Windows, after installing dependencies, use `.\scripts\start-local.ps1` to
start both processes and open the browser automatically when the web app is
ready. If Review Skill Lab is already responding on port 3000, the launcher
opens that instance instead of starting another one.

## Workflow

The workspace's **Parallel Review Nums** setting controls result-unit
concurrency. A baseline result unit is one baseline profile × one PR. A skill
result unit is one named personal skill × one PR.

1. Enter GitHub `owner/repository` or an Azure DevOps repository URL.
2. Collect the dataset and open the repository's **PR workspace**.
3. Add any number of repository-scoped baseline profiles. A profile is uniquely
   identified by Model 1, optional Model 2, and context tier, with an optional
   display name. When Model 2 is enabled, both raw reviews run concurrently and
   Model 1 orchestrates them into the final baseline result.
4. Add any number of repository-scoped personal PR review skills. Each entry
   has a display name and local path. The path can point directly to a folder
   containing `SKILL.md` or to a repository containing `.github\skills`.
5. Select Model 1, optional Model 2, and the shared context budget. Both models review;
   Model 1 also performs the final orchestration pass.
   Optionally set **Local repository path** to provide full-repository context.
6. Curate the downloaded PR list:
   - select individual PRs or select all;
   - remove irrelevant PRs;
   - add a manual PR link or number;
   - add an expected-defect description to any PR.
7. Select PRs and baseline profiles, then click **Setup Base Line Score**. Only
   the selected profile × PR units run or re-run.
8. Select PRs and personal skills, then click **Eval Skill**. Only the selected
   skill × PR units run or re-run. Skill results use the current Model 1,
   optional Model 2, and context configuration.

Skill evaluation requires a completed baseline profile matching **Model 1 +
Model 2 + the current orchestration context** for every selected PR. This keeps
the model topology identical so loading the personal skill is the only
experimental variable. Other baseline profiles remain independent comparison
rows and do not satisfy this requirement.

A verified local repository path is required for every benchmark review. The
worker creates a detached worktree at the recorded PR head/source commit and
rejects the review if that commit is unavailable locally. Baseline and skilled
reviews receive the same snapshot. Their tool set is restricted to local
read/search operations; GitHub MCP, web/URL access, remote Git access, other
checkouts, branches, tags, and code after the recorded commit are unavailable.

The PR workspace displays aggregate earned/available points and percentage for
every active baseline profile and personal skill. The primary result view is a
spreadsheet with one row per PR, sticky selection/PR columns, horizontally
scrollable baseline and skill column groups, and `Review Result` / `Score`
subcolumns. Result links address the exact persisted result row or report.
Failed cells show their full error and provide a one-unit retry button. Legacy
single baseline/skill results remain as compatibility columns.

The primary score is a per-comment point score. Each substantive valued human
comment contributes one available point, while minor formatting, naming, typo,
and style comments contribute zero. A review that matches two of three scored
comments receives 2/3 points; aggregate totals sum earned and available points
across PRs. Catching every scored valued comment is 100%.

**Save report** creates one immutable comparison snapshot named
`YYYYMMDDHHmmss`, such as `20260906122500`. **HistoryReports** lists these
snapshots, rather than separate entries for every model or skill. Open a
snapshot to see the saved comparison matrix: configuration, type, score,
credits, completed PRs, and state. Select a configuration to inspect its saved
per-PR results.

Snapshots preserve the workspace's current changed-path PR filter, visible
personal skills, model configuration, scores, and states. Later reviews,
rescoring, renames, or filter changes do not update saved snapshots. Save
timestamps include a time zone in the UI. Earlier per-configuration reports are
grouped by their original save time without changing their contents or links;
their original filter settings were not recorded.

**Eligible PRs** controls the maximum number added to the dataset. **Search
safety limit** controls how many recent PRs may be inspected while looking for
eligible entries. Collection stops early when the eligible target is reached.
High-volume monorepositories commonly need a search limit of 2,000 or more.

For an unscored review of one specific PR, enter its number on the repository
card and select **Review one PR**. Both models review with the configured skill,
then Model 1 produces a focused "what is wrong with this PR" report.

## Folder filtering

The optional changed-path filter accepts one or more comma-separated folder
prefixes. Only PRs that modify at least one matching file are collected, and
only matching file changes are included in model review inputs. When a filter is
active, PR-level comments and comments from other folders are excluded from the
ground truth because they cannot be attributed to the selected code area.

Azure DevOps content URLs are supported directly. For example, a URL containing
`path=/sources/dev/Management/src/ServiceHost/Servicelets` automatically uses
`sources/dev/Management/src/ServiceHost/Servicelets` as the filter unless the
UI field overrides it.

## Data layout

```text
data/
  benchmark.sqlite
  datasets/
    owner__repository/
      manifest.json
      pr-123/
        pr.json
        files.json
        diff.patch
        human-findings.json
  runs/
    run-1/
      summary.json
      summary.md
      skill-root/
      pr-123/
        model1-skilled.json
        model1-baseline.json
        model2-skilled.json
        model2-baseline.json
        orchestration.json
        metrics.json
        report.md
  quick-reviews/
    review-1/
      model1-review.json
      model2-review.json
      result.json
      report.md
  workflow/
    task-42/
      profile-3/
        pr-123-baseline/
      skill-7/
        pr-123-model1-skill/
        pr-123-model2-skill/
        pr-123-orchestration/
        pr-123-report.md
```

`human-findings.json` is never copied into a model workspace, so no review or
orchestration pass can read the ground truth. Each Copilot invocation starts a
new session. The four benchmark reviews are randomized per PR.

## Optional local repository context

The repository workspace accepts an optional **Local repository path**. The
setting is repository-scoped and is not part of dataset collection. The path
must exist and resolve to a Git worktree. Its `origin` is compared with the
configured GitHub or Azure DevOps repository; a missing or different remote is
shown as a warning rather than rejected.

For every baseline profile × PR and personal skill × PR result unit, the worker:

1. reads the recorded head/source commit from the immutable `pr.json`;
2. verifies that commit exists in the configured local repository;
3. serializes only `git worktree add`, creating a unique detached worktree under
   that workflow task;
4. gives every baseline, Model 1, Model 2, and orchestration pass access to the
   same historical worktree;
5. removes that exact worktree with `git worktree remove --force` after the
   result unit, while other model reviews continue in parallel.

The user working tree and checked-out branch are never changed. Snapshot
workspaces still contain only `pr.json`, `files.json`, `diff.patch`, and a
generated `repository-context.json`; ground truth remains excluded. If the
recorded commit is unavailable locally, that result unit fails with the commit
and repository path in its persisted error. Leaving the setting blank preserves
the previous diff-only behavior.

Normalized workspace results are stored in `baseline_profiles`,
`baseline_profile_results`, `personal_review_skills`, and
`personal_skill_results`. Removing a profile or skill deactivates it so its
historical result rows are retained. Existing `pull_requests.baseline_*` and
`pull_requests.skill_*` data is not deleted or overwritten by matrix runs.

## Import a legacy workflow task

If a legacy task failed only while parsing preserved Copilot JSON, recover the
completed inference first without making any new model calls:

```powershell
npx tsx scripts\recover-workflow-json.ts --task 5
```

The recovery parser handles hard-wrapped JSON keys, paths, numbers, unescaped
quotes, control characters, and multiple draft JSON objects. When orchestration
was never reached, the helper deterministically deduplicates the completed
Model 1 and Model 2 findings, writes a recovery report, recomputes metrics, and
updates only the failed legacy result rows.

To copy an existing legacy `skill_eval` task into the normalized matrix without
changing or re-running the task:

```powershell
npx tsx scripts\import-legacy-workflow-results.ts --task 5 --skill-name "wz-review" --skill-path "Q:\src\PRReviewSkill\skills\wz-review"
```

The helper creates/reactivates the matching Model 1 baseline profile and named
skill, copies legacy baseline and skill statuses/results, and captures any raw
task output and usage files that are still present. It does not modify the
workflow task itself.

When upgrading while a worker is already running, preserve or import its
current legacy task first, then restart only the worker once. Matrix task APIs
reject new profile/skill jobs until the restarted worker advertises the matrix
workflow version, preventing the old process from consuming a new payload as a
legacy single-result task.

## Models and context

- **Model 1:** performs skilled and baseline reviews, then orchestrates the
  outputs from both models.
- **Model 2:** performs skilled and baseline reviews.
- **Model 2 = None:** skips Model 2 and orchestration. Model 1 alone performs
  the skilled and baseline reviews. Quick PR review results come directly from
  Model 1.
- **400K:** maps to Copilot CLI's `default` context tier.
- **1M:** maps to Copilot CLI's `long_context` context tier.

The UI labels are benchmark configuration names. The actual context capacity is
controlled by the selected model and Copilot CLI tier.

## Valued comment heuristic

The collector excludes bots, PR-author comments, empty comments, simple
approvals, thanks, and other low-information reactions. It scores comments using
inline code location, substantive length, actionable language, code or
suggestion content, and trusted repository association. A PR is eligible when
at least one comment reaches the value threshold.

This produces useful benchmark labels but not perfect ground truth. Human
adjudication is recommended before drawing high-stakes conclusions.

## Matching and metrics

A human finding and model finding can match when their file paths agree, their
lines are close, and their normalized review text has meaningful token overlap.
Matches are one-to-one. The application calculates:

- **Recall:** valued human findings recovered by the model.
- **Precision:** model findings matched to valued human findings.
- **F1:** harmonic mean of recall and precision.
- **Mean match score:** average strength of accepted matches.
- **Time:** wall-clock duration of each Copilot CLI review.

Unmatched model findings count as false positives for automated scoring. Some
may be valid novel findings, so per-PR reports preserve them for manual review.

## Scheduling

Schedules are stored in SQLite. They are application schedules, not Windows Task
Scheduler jobs, and execute only while the worker is running. The dashboard
currently provides a daily schedule; the API accepts intervals from 15 minutes
to one year.

## Copilot skill

This repository includes `.github\skills\pr-review-benchmark\SKILL.md`. It helps
Copilot configure, run, schedule, diagnose, and explain this benchmark without
weakening the blind-evaluation controls.

## Commands

```powershell
npm run dev        # UI only
npm run worker     # durable job and schedule worker
npm run dev:all    # UI and worker
npm test
npm run lint
npm run build
```
