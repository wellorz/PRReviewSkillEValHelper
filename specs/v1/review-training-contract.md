# Review and training contract — version 1

## Compatibility

This contract describes the externally observable invariants for benchmark
review and personal-skill training. A change that weakens an invariant requires
a new version, migration notes, and explicit human approval.

## Review invariants

1. Baseline and skilled variants use the same immutable PR snapshot, historical
   repository revision, prompt parameters, context tier, and model identity.
2. Only the skilled variant can access the configured personal skill.
3. Human findings remain unavailable until model review output is complete.
4. Review output is local-only and cannot publish or mutate remote PR state.
5. Failed sandboxing, missing commits, invalid output, and unavailable models
   remain explicit failures.

## Training lifecycle

Mitigation candidates move through these states:

| State | Meaning | Required evidence |
|---|---|---|
| `candidate` | A zero-credit review produced a supported gap hypothesis | Missed finding, review output, and gap classification |
| `verified` | Repository-backed analysis confirms the gap | Historical code context or refreshed knowledge graph |
| `active` | An append-only mitigation was applied | Target file, backup path, exact edit, and retry association |
| `effective` | A later review earns credit | Completed retry result and matched credit |
| `retired` | The rule is obsolete or harmful | Human decision and replacement or rollback reference |

Only `verified` candidates may become `active`. Automated training may append
an evidence-grounded mitigation but may not delete or weaken existing rules.
Generated CodeReading graphs are evidence, never mitigation targets.

## Retry and handoff

Each PR receives at most five mitigation/review retries. Configured-model
unavailability uses bounded same-model delays. Transient service, output,
filesystem, and analysis failures receive up to two same-configuration
execution retries; timeouts receive one. Missing immutable commits, sandbox
failures, and genuine artifact identity mismatches remain explicit without
blind retries. Unsafe mitigation edits are never applied; analysis may
regenerate an append-only proposal up to two times. Cancellation or exhausted
retries hand control to the user while retaining completed reviews, backups,
and already-applied mitigations.

## Proof of change

Every behavior-changing pull request must provide targeted tests and pass:

```text
npm test
npx next typegen
npx tsc --noEmit
npm run validate:repository
npm run validate:docs
npm run validate:workflows
npm run lint
npm run build
```
