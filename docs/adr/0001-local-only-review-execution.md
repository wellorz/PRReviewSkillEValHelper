# ADR 0001: Keep review execution local-only

- **Status:** Accepted
- **Date:** 2026-09-15

## Context

The benchmark must compare review quality without risking accidental comments,
approvals, votes, labels, statuses, or branch changes on real pull requests.
Review models also must not see the human findings used as scoring ground truth.

## Decision

All baseline, personal-skill, analysis, and training output remains local.
Publication flags are prohibited. Generic Copilot review subprocesses run with
network and credential access disabled and fail closed when that sandbox cannot
be established.

Native `wz-review` is the sole trusted host-sandbox exception. It receives no
publication capability, uses isolated GitHub and Azure CLI configuration, and
does not receive remote MCP or URL tools.

## Consequences

- Review results require an explicit human decision before any external use.
- Remote repository providers are read-only during collection and evaluation.
- The application cannot silently fall back to a less restricted execution
  mode.
- Local reports and SQLite state form the durable audit trail.
- Any future remote publication feature requires a new ADR and explicit human
  approval; it cannot weaken this default.

