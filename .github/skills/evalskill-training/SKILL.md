---
name: evalskill-training
description: Preflight a local repository and personal PR-review skill, confirm invocation and model requirements, then run the durable local-only zero-credit mitigation and retry workflow.
---

# EvalSkill-Training

Use this skill when the user wants to train or improve a personal PR-review
skill against an already collected benchmark set.

## Access preflight

Ask the user for:

1. The local repository folder containing the source code for the evaluated
   pull requests.
2. The personal skill folder to train.

Resolve both paths and confirm that:

- the repository folder exists, is readable, and is a Git worktree containing
  the required historical PR commits;
- the skill folder exists, is readable, and contains either `SKILL.md` or a
  `.github\skills` directory;
- every intended mitigation target is writable.

Use non-destructive reads for access checks. If a reliable write check is
needed, create and remove one uniquely named temporary marker inside the skill
folder without changing existing files. If access is denied, stop and ask the
user to grant the required read or write permission. Never bypass an
organization content-exclusion policy or attempt to read a restricted file
through another tool.

## Understand the personal skill

Scan the skill folder before starting training. Follow references from its
`SKILL.md` files to the implementation files needed to answer all of these:

1. How is the skill invoked to review a PR? Record its command or trigger,
   required and optional parameters, defaults, output location and format,
   base/head or diff semantics, and error/cancellation behavior.
2. Which configured review model or models should execute it? Check the skill
   documentation and the repository's saved Model 1, Model 2, context tier,
   and reasoning settings. If the required model is absent, ambiguous, or
   conflicts with the saved configuration, ask the user to confirm the exact
   model before training.
3. How can the skill be improved safely? Map each review rule and instruction
   to its source file, identify which files may receive append-only
   mitigations, and confirm read/write access to those files. Generated
   `Reviewers\CodeReading` knowledge graphs are evidence only and must never be
   selected as mitigation targets.

Do not begin training until invocation, parameters, model selection, editable
files, and permissions are all known. Summarize this preflight for the user and
confirm the personal skill name and number of PRs that will be trained.

## Run the current training methodology

Use the application's durable **Train Personal Skill** workflow:

1. Require exactly one selected personal skill and at least one selected or
   path-matching PR with a compatible completed baseline.
2. Review each PR from an immutable detached worktree at its recorded commit.
3. Only PRs earning exactly zero available credits enter gap analysis.
   Partial-credit PRs are not training targets, and PRs with no available
   credit are complete.
4. For unsupported or ambiguous comments, use the configured local repository
   to read the relevant code and build or refresh a knowledge graph covering
   the symbol's purpose, callers and usages, similar implementations,
   inputs/outputs and valid values, error swallowing, and related
   classes/structures/static methods. Save it under
   `Reviewers\CodeReading\<project>\<symbol>\knowledge-graph.html`, then
   adjudicate the gap again.
5. Apply only evidence-grounded, append-only mitigations to approved skill
   files. Back up an existing file before changing it. Never weaken, replace,
   or delete existing instructions automatically.
6. Restage an immutable skill snapshot and rerun that PR.
7. Repeat analysis, mitigation, and rerun independently for each still
   zero-credit PR, stopping when it earns credit or reaches five retries.

Run up to the repository's configured review concurrency as independent per-PR
pipelines. Serialize skill mutation and skill-snapshot creation through one
gate, while reviews using already-created snapshots continue in parallel.
Persist per-PR phase, score, errors, and retry count so **View Progress** and
**Cancel Training** remain reliable across worker restarts.

## Safety and failure handling

All reviews and training are permanently local-only. Never pass publication
flags or create, update, delete, resolve, approve, or otherwise modify remote
PR comments, reviews, votes, statuses, labels, branches, or other remote state.
Never expose `human-findings.json` to a review model.

If Copilot reports that the configured model is unavailable, retry that exact
model after bounded 15, 30, 60, 120, and 240 second delays. Never silently
substitute another model. If recovery is exhausted, stop the affected training
execution with a clear infrastructure error rather than recording a misleading
review result.

Cancellation must stop future iterations, propagate an abort signal to running
review and analysis commands, and terminate their process trees. Preserve
completed reviews and mitigations already applied.
