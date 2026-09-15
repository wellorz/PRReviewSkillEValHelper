# Copilot repository instructions

Use `AGENTS.md` and the project skills under `.github\skills` as the primary
agent interface.

## Required workflow

1. Read the relevant installed Next.js guide under
   `node_modules\next\dist\docs` before changing Next.js code.
2. Preserve the permanent local-only review boundary. Never introduce PR
   publication, approval, voting, label, status, branch, or comment mutation.
3. Keep `human-findings.json` outside every model-visible workspace.
4. Make surgical changes, preserve cancellation and persisted workflow state,
   and add or update targeted tests for behavior changes.
5. Run `npm test`, `npx tsc --noEmit`, and `npm run lint`. Run
   `npm run build` when application or workflow behavior changes.
6. Record meaningful Copilot contributions with the repository's
   `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
   commit trailer.

## Human supervision

Do not change remote repository state or weaken a safety boundary without an
explicit human decision. Treat failed validation, unavailable configured
models, missing historical commits, and inaccessible skill files as visible
blocking errors rather than success-shaped fallbacks.

