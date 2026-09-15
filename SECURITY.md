# Security policy

## Reporting a vulnerability

Do not open a public issue for credentials, sandbox escapes, unintended network
access, publication of review comments, or exposure of benchmark ground truth.
Use GitHub's private vulnerability reporting feature for this repository.

Include the affected revision, reproduction steps, expected boundary, observed
behavior, and whether any remote repository state or credentials were exposed.
Do not include live credentials or private source data.

## Supported version

Security fixes are applied to the current `main` branch. This project is under
active development and does not currently maintain older release branches.

## Critical invariants

- Review and training execution must remain local-only.
- Generic review subprocesses fail closed when their sandbox cannot be applied.
- Native `wz-review` runs without publication flags and with isolated GitHub
  and Azure CLI configuration.
- Human benchmark findings remain unavailable to review models.
- Cancellation terminates the complete active subprocess tree.

