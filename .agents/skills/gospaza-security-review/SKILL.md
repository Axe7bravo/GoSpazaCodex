---
name: gospaza-security-review
description: Use for GoSpaza work involving authentication, authorization, merchant tenancy, uploads, sensitive data, OTPs, admin actions, payments, or actor-specific APIs. Perform a static security review without running commands unless explicitly requested.
---

# GoSpaza Security Review

Use this skill whenever a milestone touches authentication, authorization, tenant isolation, sensitive files, identity/compliance data, OTPs, payments, admin operations, or actor-specific routes.

## Core principle

Frontend state is never authorization. Every protected action must be enforced by the backend using authenticated actor context and explicit resource ownership/capability checks.

## Actor boundaries

Keep these identities distinct:

```text
customer
merchant
driver
platform user
```

Authentication proves identity. It does not automatically grant merchant tenancy or operational eligibility.

## Merchant tenancy

For merchant-owned resources:
- derive merchant identity from authenticated membership/context;
- never trust a request-supplied merchant ID as authorization;
- reject cross-merchant reads and writes;
- test known-ID attacks directly against APIs.

## Sensitive files

For merchant, driver, identity, payout, or compliance documents:
- no public static URLs;
- storage keys are server-generated;
- original filenames are display metadata only;
- validate size and allowed content type;
- do not trust file extension alone;
- prevent path traversal;
- authorize every read/download;
- use short-lived signed access or authenticated streaming where appropriate;
- clean up orphaned files after failed transactions where practical;
- do not log document contents or sensitive identifiers.

## Sensitive data minimization

Do not log passwords, auth tokens, session cookies, raw identity documents, full bank details, OTP plaintext, or provider secrets.

## Session / cookie security

Use supported Medusa auth/session behavior. Credentialed CORS must be explicit, not wildcard. Do not copy session credentials into localStorage. Protected routes must re-check backend auth state.

## Input validation

Validate body, query, params, uploaded file metadata, and enum/state values server-side.

## State transitions

Do not expose generic status mutation. Validate current state, actor permission, required preconditions, and replay/race behavior where relevant.

## Idempotency / concurrency

For sensitive or retryable mutations, identify duplicate-request behavior and use DB uniqueness/transactions/locking where appropriate.

## Error handling

Do not reveal unrelated account/resource existence, production stack traces, tokens, secrets, or sensitive configuration.

## Admin actions

High-risk admin actions later require explicit capability, confirmation, reason, audit entry, and backend validation. Do not create a generic admin bypass.

## Review output

When explicitly used for a review, report:

```text
Security review

Critical:
- ...

High:
- ...

Medium:
- ...

Low / hardening:
- ...

Verified boundaries:
- ...

Tests that should exist:
- ...
```

Do not invent findings. If a category has none, say `None identified`.

## Command policy

Follow `AGENTS.md`. Do not run installs, migrations, tests, lint, typecheck, builds, Docker, dev servers, or command-heavy verification unless explicitly requested.
