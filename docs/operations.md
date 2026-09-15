# Agent workflow operations

## Completion signals

The `Repository Quality` workflow validates tests, type safety, repository
contracts, lint, and production build. Its `completion-signal` job always emits
the machine-readable `quality-summary` artifact containing the workflow, run,
event, revision, and validation conclusion.

`Repository Quality Report` is chained from that workflow and writes a durable
GitHub Actions run summary. A failed source run produces a failed chained
report rather than a success-shaped fallback.

`Repository Quality Recovery` contains a failed validation run by rerunning
only its failed jobs once. A second failure stops automatic action and requires
human review. Recovery never changes code or merges a pull request.

## Scheduled maintenance

Every Monday, repository quality runs the full validation path and captures an
`npm audit` dependency-health artifact. Dependabot separately checks npm and
GitHub Actions dependencies each week. CodeQL performs scheduled and PR-time
JavaScript/TypeScript analysis.

## Application observability

The local workspace at `src\app\repositories\[id]\page.tsx` displays durable
scan, review, analysis, and training state. Training progress includes each
PR's phase, earned and available credits, retry count, and error.

Generated benchmark reports are stored locally at:

- `data\runs\run-<id>\summary.md`
- `data\runs\run-<id>\pr-<number>\report.md`

The SQLite workflow tables are the operational audit trail. Completed child
reviews and applied mitigations survive cancellation and worker restart.

## Failure containment and recovery

- Workflow cancellation aborts active commands and terminates their Windows
  process trees.
- Configured-model unavailability retries the same model after bounded delays;
  another model is never silently substituted.
- Missing commits, inaccessible skill files, invalid model output, and sandbox
  failures remain visible failures.
- Failed unavailable-model training jobs are eligible for startup requeue after
  the updated worker loads.
- Skill edits are backed up and append-only. Reverting the affected skill file
  to its backup is the rollback path for an incorrect mitigation.

`npm run validate:docs` checks the versioned review/training specification,
operating policy, self-healing bounds, required documentation, and package
commands. The blocking repository-quality workflow executes this check on each
pull request.
