# Architecture

## Purpose

PR Review Skill Eval Helper builds a curated pull-request benchmark, compares a
personal review skill with an unskilled baseline, scores both against valued
human defects, and can improve the personal skill through bounded local
training.

## Runtime components

| Component | Location | Responsibility |
|---|---|---|
| Next.js application | `src\app` | Repository setup, PR curation, workflow controls, progress, reports, and human confirmations |
| Durable worker | `scripts\worker.ts` | Claims persisted scans, reviews, analyses, schedules, and training jobs |
| Workflow engine | `src\lib\workflow.ts` | Creates immutable review inputs and executes baseline and personal-skill evaluations |
| Copilot boundary | `src\lib\copilot.ts` | Constructs prompts, permissions, sandboxing, cancellation, and same-model recovery |
| Ground-truth collectors | `src\lib\github.ts`, `src\lib\azure-devops.ts` | Read-only collection and normalization of eligible human review findings |
| Scoring | `src\lib\scoring.ts` | Matches model findings to valued defects and calculates coverage diagnostics |
| Skill analysis | `src\lib\skill-analysis.ts` | Classifies missed findings and applies evidence-grounded append-only mitigations |
| Training | `src\lib\skill-training.ts` | Runs bounded per-PR review, analysis, mitigation, and retry pipelines |
| Persistence | `src\lib\db.ts` | Owns the local SQLite schema and durable workflow state |

## Data flow

1. A repository scan stores normalized PR snapshots and valued human findings
   under local `data` state.
2. Baseline and skilled variants receive the same immutable PR snapshot and
   historical repository revision. Human findings are excluded.
3. Fresh Copilot sessions produce local structured review output.
4. The evaluator matches those findings to ground truth only after review
   execution finishes.
5. Training analyzes zero-credit PRs, optionally refreshes repository-backed
   code-reading graphs, applies append-only skill changes, and reruns up to five
   times per PR.
6. The UI and reports read persisted state, allowing cancellation and worker
   restarts without discarding completed work.

## Concurrency and mutation

Repository-configured concurrency bounds independent per-PR pipelines. Skill
snapshot creation and mitigation writes pass through one mutation gate so no
snapshot is copied while the skill is changing. Reviews using completed
immutable snapshots can continue in parallel.

## Trust boundaries

Remote providers are read-only inputs. Review subprocesses cannot publish PR
feedback or receive benchmark ground truth. Generic skills run in a restricted
sandbox; native `wz-review` is the documented trusted host exception with
credentials isolated and publication options prohibited.

See `docs\adr\0001-local-only-review-execution.md` for the permanent local-only
decision and `.github\agent-review.yml` for the executable operating contract.

