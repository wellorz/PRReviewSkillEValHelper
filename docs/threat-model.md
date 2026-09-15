# Threat model

## Protected assets

- Credentials available to GitHub, Azure DevOps, Git, and Copilot tooling.
- Private source code in configured local repositories.
- Human review findings used as benchmark ground truth.
- Integrity of baseline, personal-skill, and training comparison results.
- Remote pull-request comments, reviews, votes, statuses, labels, and branches.

## Trust boundaries

Remote providers supply read-only PR metadata and diffs. The local application
stores snapshots and workflow state. Review subprocesses receive only immutable
review inputs and never receive human ground truth. Generic skills execute
inside the restricted Copilot sandbox. Native `wz-review` is the sole documented
host exception and receives isolated CLI configuration and no publication
flags.

## Primary threats and controls

| Threat | Control |
|---|---|
| Accidental PR publication | Publication flags are prohibited and review execution is local-only |
| Credential discovery by a review tool | Generic subprocess credentials and network access are removed; native execution uses isolated CLI homes |
| Ground-truth leakage | `human-findings.json` is excluded from model-visible workspaces |
| Reviewing newer code than the PR | Reviews use detached worktrees at the recorded historical commit |
| Concurrent skill mutation corrupting snapshots | Skill writes and snapshot creation share a one-slot mutation gate |
| Run cancellation leaves child processes active | Cancellation aborts the workflow and terminates the Windows process tree |
| Temporary model outage corrupts model identity | The exact configured model is retried; another model is never substituted |
| CI transient failure blocks changes indefinitely | Failed quality jobs receive at most one automatic rerun before human handoff |
| Automated remediation introduces unsafe code | CI recovery never mutates code or merges changes automatically |

## Residual risks

Host-native tools may discover ambient credentials outside isolated
configuration directories. Semantic finding matching is an evaluation proxy,
not proof that two findings describe the same defect. Repository administrators
must separately enforce branch protection and required status checks.

Review this model whenever a new remote write capability, credential source,
execution sandbox exception, or automated code mutation path is proposed.

