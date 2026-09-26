---
name: gospaza-milestone-implementer
description: Use when implementing or correcting a GoSpaza milestone. Enforces milestone scope, user-run verification, static review, and consistent completion reporting.
---

# GoSpaza Milestone Implementer

Use this skill for GoSpaza milestone implementation and milestone-scoped corrections.

## Operating model

The active milestone file is the implementation contract. Repository instructions and relevant domain/security skills remain authoritative.

Before editing:
- inspect the current repository state;
- inspect the active milestone;
- inspect pinned dependency versions relevant to the work;
- preserve verified behavior from earlier milestones.

Do not infer or implement the next milestone.

## Scope discipline

Implement only what is required for the active milestone. Do not add speculative future entities, build future UI flows, create broad abstractions without a current requirement, rewrite working previous-milestone code unnecessarily, or duplicate Medusa-owned concerns.

When a future requirement affects today's architecture, leave a clean extension point rather than implementing the future feature.

## Medusa discipline

For Medusa-sensitive work, use `medusa-first-architecture`.

Prefer, in order:
1. native Medusa capability;
2. supported Medusa configuration;
3. workflow/module-link extension;
4. small custom module linked to native concepts;
5. fully custom replacement only when necessary.

Inspect the pinned Medusa version instead of assuming APIs from memory.

## Security discipline

For authentication, authorization, tenancy, uploads, identity/compliance data, OTPs, payments, admin actions, or actor-specific APIs, use `gospaza-security-review`.

Frontend state is never authorization.

## Command / quota policy

Codex does not run dependency installs, migrations, Docker, lint, typecheck, tests, builds, development servers, or command-heavy verification unless the user explicitly asks.

If runtime output is genuinely required:
- provide the exact minimum command;
- explain what output is required;
- stop and wait.

Never claim a command passed without user-provided output.

All PowerShell commands provided to the user must be one line.

## Verification model

```text
implementation complete
-> user verification
-> targeted fixes if required
-> verified milestone complete
```

For verification failures, diagnose the smallest observed failure. Do not restart the milestone, rerun already-passing work unnecessarily, or hide failures with sleeps, larger timeouts, weakened assertions, or swallowed errors.

## Completion report

Use the active milestone's required completion report. If none is supplied, use:

```text
MILESTONE <N> COMPLETE

1. Implemented
2. Medusa ownership decisions
3. Schema / migrations
4. API routes / workflows
5. UI
6. Authorization / security
7. Tests added
8. Verification status
9. Commands for user to run
10. Explicitly NOT implemented
11. Known limitations
12. Files/modules materially changed
```

## Stop condition

After the active milestone is implemented and its completion report is returned, stop. Do not begin future milestone work.
