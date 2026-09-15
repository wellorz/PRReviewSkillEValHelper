# Contributing

## Set up

Use Windows and Node.js 24, matching `.nvmrc`:

```powershell
.\scripts\setup.ps1
```

Start both the Next.js application and durable worker:

```powershell
npm run dev:all
```

Running `npm run dev` alone is insufficient for scans, scheduled work,
evaluations, analysis, or training.

## Validate a change

Run the smallest relevant test first, followed by the repository checks:

```powershell
npm test
npx tsc --noEmit
npm run validate:repository
npm run validate:docs
npm run validate:workflows
npm run lint
npm run build
```

The wrappers under `scripts\agent` provide concise success output and preserve
full command output on failure.

## Pull requests

Use the pull request template and request review from the code owner. Describe
the user-visible outcome, validation performed, safety impact, and rollback
path. Keep changes focused and do not combine unrelated cleanup.

Copilot-assisted commits should include:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Review safety boundary

All benchmark and training reviews are permanently local-only. Contributions
must not add PR publication flags or remotely mutate comments, reviews, votes,
statuses, labels, branches, or approvals. Never place `human-findings.json`
inside a model-visible review workspace.
