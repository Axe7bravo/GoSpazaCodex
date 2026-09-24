# GoSpaza — Milestone M0 Prompt
## Repository & Platform Foundation

You are implementing **Milestone M0 only** for the GoSpaza project.

Before changing anything:

1. Read the repository-level `AGENTS.md` in full.
2. Inspect the entire existing repository structure and relevant configuration.
3. Determine whether this repository is empty, partially initialized, or already contains any reusable GoSpaza code.
4. Preserve valid existing work where it is compatible with the milestone and `AGENTS.md`.
5. Do not implement any business feature assigned to later milestones.

# Objective

Create a clean, production-oriented monorepo foundation for GoSpaza.

At the end of this milestone:

- the repository structure exists;
- all applications compile;
- the Medusa backend starts;
- PostgreSQL and Redis connectivity are configured;
- the frontend apps start;
- shared packages are usable;
- environment validation exists;
- health checks exist;
- baseline automated testing and CI-friendly commands exist;
- no GoSpaza marketplace business functionality has been implemented yet.

# Target Repository Structure

Create or adapt the repository toward:

```text
apps/
  backend/
  customer/
  merchant/
  driver/
  admin/

packages/
  ui/
  contracts/
  api-client/
  config/
  test-utils/
```

Use a workspace-based monorepo appropriate for the current project tooling.

Do not introduce unnecessary repository-management complexity.

If an existing package manager/workspace convention already exists and is reasonable, keep it.

# Backend

Create/configure:

```text
apps/backend
```

using the current supported MedusaJS v2 project structure.

Requirements:

- TypeScript.
- PostgreSQL configuration.
- Redis configuration suitable for later Medusa event/workflow/locking usage.
- Environment-variable validation.
- Development/test/production environment separation.
- Migration support.
- Structured logging baseline.
- Health endpoint.
- Test setup.
- Lint/typecheck/build commands.
- Docker-friendly configuration.

Do not add custom GoSpaza business modules yet.

Do not add:
- Merchant
- Driver
- Delivery
- Settlement
- Substitution
- Compliance
- Marketplace finance
- Yoco integration

Those belong to later milestones.

# Frontend Applications

Create/configure:

```text
apps/customer
apps/merchant
apps/driver
apps/admin
```

using Next.js + TypeScript.

Each app must:

- start independently;
- compile successfully;
- have strict TypeScript enabled;
- use the shared project configuration;
- have a minimal placeholder landing page identifying the app;
- be ready to consume shared packages.

Do not implement actual GoSpaza screens yet beyond minimal shell/placeholders needed to prove the apps work.

Do not create fake business data or speculative APIs.

# Shared Packages

## `packages/ui`

Create the shared UI foundation only.

Include minimal primitives/tokens sufficient to prove cross-app sharing, such as:

- design tokens / CSS variables;
- typography tokens;
- spacing/radius tokens;
- a simple shared Button;
- a simple shared status/badge primitive if useful.

Use the approved GoSpaza visual direction:

- warm off-white / cream surfaces;
- charcoal / black typography;
- orange primary action color;
- green success/availability color.

Do not build role-specific composites yet.

Do not redesign or invent a new GoSpaza logo.

If no logo asset exists in the repository, use text-only `GoSpaza` branding as a placeholder.

## `packages/contracts`

Create the package structure for shared API/domain TypeScript contracts.

Do not define speculative business-domain models yet.

It may contain only basic shared infrastructure types if needed.

## `packages/api-client`

Create a typed API-client foundation.

Do not add merchant/order/driver APIs yet.

It should be ready for later actor-specific clients.

## `packages/config`

Centralize reasonable shared configuration such as:

- TypeScript base config;
- lint config;
- shared tooling config where appropriate.

## `packages/test-utils`

Create only the baseline testing utility structure needed by the monorepo.

Do not create future-domain fixtures.

# Docker / Local Infrastructure

Provide a local-development setup for:

```text
PostgreSQL
Redis
```

Docker Compose is acceptable.

Requirements:

- deterministic local service names;
- persistent development volumes where appropriate;
- documented ports;
- environment-variable examples;
- health checks where practical.

The application should not require cloud services to run M0 locally.

# Environment Management

Provide example environment files, but never commit real secrets.

At minimum document/configure:

```text
DATABASE_URL
REDIS_URL
backend base URL(s)
frontend public API URL(s)
```

Use environment validation so missing required values fail clearly.

Prepare clean separation for:

```text
development
test
staging
production
```

Do not add Yoco, SMS, email, maps, or age-verification credentials yet.

# Health Checks

Implement a backend health route suitable for infrastructure monitoring.

It should report at least application health and, where practical, dependency readiness for:

```text
PostgreSQL
Redis
```

Do not expose secrets or sensitive environment details.

Keep liveness/readiness concerns clean enough to extend later.

# Logging

Set up structured logging suitable for later request/workflow correlation.

Where reasonable, establish a request ID / correlation ID convention.

Do not overbuild observability or introduce paid providers in M0.

# Testing

Set up baseline automated testing for the repository.

At minimum verify:

- backend basic test command runs;
- shared package test command runs if relevant;
- each application can typecheck;
- each application can build;
- a basic backend health test exists;
- environment/config validation is testable.

Tests should not depend on future marketplace entities.

# Root Commands

Provide clear root commands/scripts for common development operations.

Expected capabilities:

```text
install
dev
lint
typecheck
test
build
```

If the chosen workspace tooling supports filtered app commands, document them.

A developer should not need to guess how to start the project.

Define/document these commands, but do not execute them unless explicitly requested by the user.

# Documentation

Update or create a root README that explains:

- GoSpaza repository layout;
- prerequisites;
- local environment setup;
- how to start PostgreSQL/Redis;
- how to install dependencies;
- how to run all applications;
- how to run individual applications;
- how to run migrations;
- how to run tests;
- how to lint/typecheck/build;
- important M0 architecture decisions.

Do not write documentation for features that do not yet exist.

# CI Readiness

The repository must be suitable for CI even if no specific CI provider is configured yet.

Root commands must return non-zero on failure.

Avoid scripts that only work interactively.

If a CI workflow already exists, update it only as necessary for M0.

Do not add deployment pipelines yet unless the repository already has one that needs adaptation.

# Command Execution / Verification Handoff

To conserve Codex quota, **do not run command-heavy verification yourself unless the user explicitly asks you to**.

Do not run:
- package installation;
- Docker / Docker Compose;
- database migrations;
- dev servers;
- lint;
- typecheck;
- tests;
- builds;
- other long verification scripts.

You may inspect files and edit code normally.

If you need information that requires command execution, give the user the exact minimal command to run and request the relevant output instead of guessing.

Before declaring the implementation portion of M0 complete, prepare an ordered **Commands for user to run** section.

The verification sequence should cover at least:

```text
dependency installation
local PostgreSQL / Redis startup
database migration/setup as required
backend health/readiness
lint
typecheck
tests
build
```

For each command:
- specify the working directory if necessary;
- give the exact command;
- state the expected successful outcome;
- say whether the user should stop the sequence if it fails.

Prefer cheap/fast checks before expensive checks where practical.

Do not claim any command passed unless the user has returned successful output from that command.

When the user returns failures, inspect them and make targeted fixes, then provide only the minimal commands that need to be rerun.

# Explicitly Out of Scope

Do NOT implement:

- Customer authentication flows.
- Merchant authentication.
- Driver authentication.
- Admin RBAC.
- Merchant applications.
- Merchant entities.
- Products/catalogue beyond Medusa defaults/scaffolding.
- Inventory workflows.
- Service zones.
- Customer location flow.
- Customer storefront.
- Cart business rules.
- Scheduling.
- Yoco.
- Orders.
- Picking.
- Substitutions.
- Drivers.
- Dispatch.
- OTP.
- Alcohol verification.
- Store credit workflows.
- Refunds.
- Finance ledgers.
- Settlements.
- Driver earnings.
- Notifications.
- Realtime business events.
- Full admin screens.

Future-friendly foundations are allowed.

Future business features are not.

# Completion Report

When M0 is complete, STOP and return exactly this structure:

```text
MILESTONE M0 COMPLETE

1. Implemented
- ...

2. Schema / migrations
- ...

3. API routes / workflows
- ...

4. UI
- ...

5. Authorization / security
- ...

6. Tests added
- ...

7. Verification status
- Commands were not executed by Codex unless explicitly requested.
- User-supplied verification results already reviewed:
  - ...
- Still requiring user verification:
  - ...

8. Commands for user to run
1. `<command>`
   - Purpose:
   - Expected result:
   - Stop on failure: yes/no
2. ...

9. Explicitly NOT implemented
- ...

10. Known limitations
- ...

11. Files/modules materially changed
- ...
```

Do not continue to M1.

Wait for review.
