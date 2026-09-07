---
name: pr-review-benchmark
description: Configure, run, schedule, diagnose, and report blind paired evaluations of a user's GitHub Copilot pull-request review skill against the same model without that skill.
---

# PR Review Skill Benchmark

Use this skill when the user wants to evaluate a PR review skill against valued
human comments, compare it with a raw model review, schedule benchmark runs, or
inspect benchmark reports.

## Preconditions

1. Work from the repository root.
2. For GitHub, confirm `gh auth status` succeeds. For Azure DevOps, confirm the
   `azure-devops` Azure CLI extension is installed and repository Git access
   succeeds.
3. Confirm `copilot --version` succeeds and Copilot is authenticated.
4. The user review skill path must either contain a `SKILL.md` file or contain
   `.github/skills`.

## Start the application

1. Install dependencies with `npm install` when `node_modules` is absent.
2. Start the web app and durable worker with `npm run dev:all`.
3. Direct the user to the local URL printed by Next.js.

Do not start only `npm run dev` for scheduled or long-running evaluations; the
worker is responsible for repository scans, schedules, and review jobs.

## Configure an evaluation

Collect these inputs:

- GitHub repository in `owner/repository` form or an Azure DevOps repository
  URL.
- Optional comma-separated changed-folder prefixes.
- Local path to the user's PR review skill.
- Model 1, which reviews and performs final orchestration.
- Model 2, which also reviews.
- Context budget: 400K maps to `default`; 1M maps to `long_context`.

Model 2 may be `None`. In that mode, run only Model 1's skilled and baseline
reviews, skip orchestration, and score Model 1 directly.
- Number of eligible PRs, at most 100.
- Maximum number of recent merged PRs to scan.

Use the UI unless the user explicitly asks for headless operation. Explain that
the collector may scan more PRs than it keeps because only PRs with valued,
non-bot, non-author human comments are eligible.

When an Azure DevOps content URL includes a `path` query, use it as the default
changed-folder filter. A PR is eligible only when at least one changed file is
under the filter. After the PR qualifies, credited defects may be located in
other changed files; include those exact defect-bearing files in the review
snapshot so the reviewer can see every issue that can earn credit. Exclude
pathless PR-level comments while a filter is active.

Award one credit for every defect that satisfies the ground-truth policy. Do not
cap the number of available credits per PR. Keep manually curated and
owner-confirmed defects visible so reviews can be rescored against the complete
credited set.

Define the benchmark score as credit coverage:
`earned defect credits / total available defect credits * 100`. A score of 100
means the reviewer found every credited defect. Use this score, rather than F1,
to determine whether the skilled review beats the baseline; retain precision
and F1 as secondary diagnostics.

## Curate PRs and run the staged workflow

After collection, open the repository PR workspace:

1. Select individual PRs or all PRs.
2. Remove irrelevant PRs.
3. Add a PR manually by URL or number.
4. Add or update the expected-defect description for any PR.
5. Run **Setup Base Line Score** for the selected PRs.
6. Confirm baseline completion and timing in each PR row.
7. Run **Eval Skill** for selected PRs with completed baselines.
8. Open the per-PR comparison report.

The workspace must show the command shape used to expose the user skill to
Copilot. Baseline reviews must not load that skill.

## Evaluation guarantees

Preserve these controls:

- Never put `human-findings.json` inside a model-visible review workspace.
- For each model, use the same PR snapshot, prompt, context tier, reasoning
  effort, and permissions for skilled and baseline variants.
- Give only the skilled variant access to the configured skill.
- Start each variant in a fresh Copilot CLI session.
- Randomize all four model/variant review invocations for every PR.
- After the four reviews, use Model 1 to merge skilled outputs separately from
  baseline outputs without exposing human findings.
- Do not modify the matching thresholds during a run.

## Scheduling

Use the dashboard's scheduling action. A schedule is durable in SQLite but only
runs while `npm run worker` or `npm run dev:all` is active. Do not describe it as
an operating-system scheduler.

## Reports

Use `data/runs/run-<id>/summary.md` for the aggregate report and
`data/runs/run-<id>/pr-<number>/report.md` for each PR quiz.

Report:

- matched valued human findings;
- precision, recall, F1, and mean match score;
- false positives and false negatives;
- skilled, baseline, and delta metrics;
- skilled wins, baseline wins, and ties;
- elapsed time and Copilot usage records.

State clearly that automated semantic/location matching is a benchmark proxy.
Recommend human adjudication for close or high-stakes comparisons.

## Quick PR review

When the user asks what is wrong with one PR, use the repository card's
**Review one PR** action. This path does not require valued human comments:

1. Both configured models review the requested PR with the user's skill.
2. Model 1 merges and deduplicates their findings.
3. The UI exposes the resulting issue report.

Describe quick-review results as unscored because they do not have benchmark
ground truth.
