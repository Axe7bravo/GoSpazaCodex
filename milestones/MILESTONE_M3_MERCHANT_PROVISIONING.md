# GoSpaza — Milestone M3
## Merchant Approval & Provisioning

Implement **Milestone M3 only**.

Follow all applicable repository instructions.

Use:
- `gospaza-milestone-implementer` for milestone scope and verification discipline.
- `medusa-first-architecture` for Medusa ownership and provisioning decisions.
- `gospaza-security-review` for admin decisions, tenant creation, and authorization boundaries.

Do not run command-heavy verification. The user will run commands.

# Objective

Turn a reviewed merchant application into a real GoSpaza merchant tenant safely and idempotently.

M3 introduces:
- controlled admin review transitions;
- request-more-information and rejection flows;
- approval;
- merchant provisioning;
- initial owner membership;
- a separate physical-store record for the merchant;
- only the native Medusa location resources appropriate for the pinned version;
- reusable server-derived merchant tenancy context.

M3 does **not** build the operational merchant portal, team management, catalogue, inventory editing, finance, orders, delivery, or settlements.

# Critical rule

```text
merchant auth identity != merchant tenancy
```

A `merchant` auth session proves only merchant-type authentication.

Operational tenant access exists only after the authenticated identity resolves through an active `MerchantMember` to a provisioned `Merchant`.

Never derive tenancy from:
- email;
- application ID supplied by the client;
- merchant ID supplied by the client;
- the existence of a merchant auth session alone.

# Medusa ownership review

Before provisioning, inspect the pinned Medusa 2.18.0 APIs and official marketplace/vendor patterns available for that version.

Do **not** assume one GoSpaza merchant maps to one native Medusa `Store`.

Codex must determine whether native Medusa `Store` is platform-level or suitable for vendor tenancy in this architecture.

Inspect whether M3 should provision:
- Stock Location;
- required fulfillment/location associations;
- Sales Channel only if genuinely required now.

If a native resource is unnecessary until M5 catalogue/inventory, defer it.

The completion report must document these decisions.

# Marketplace entities

Extend the custom marketplace domain only as required by M3.

## Merchant

Suggested fields:

```text
id
source_application_id UNIQUE
legal_name
trading_name
status
created_at
updated_at
```

Keep status intentionally small, for example:

```text
ACTIVE
SUSPENDED
```

Do not implement suspension workflows yet.

The application remains the onboarding source, but Merchant must contain the operational business snapshot needed after approval.

## MerchantStore

Keep Merchant and physical Store as separate concepts even though MVP is:

```text
1 merchant = 1 physical store
```

Suggested fields:

```text
id
merchant_id
name
structured physical address
medusa_stock_location_id nullable
created_at
updated_at
```

Enforce one store per merchant for MVP in a way that can later evolve to 1:N.

Do not hard-code Bloemfontein into schema or business logic.

## MerchantMember

Create the membership that grants merchant tenancy.

Suggested fields:

```text
id
merchant_id
auth_identity_id
member_type
status
created_at
updated_at
```

For M3, only the initial owner membership is required:

```text
member_type = OWNER
```

Do not implement M4 roles, capabilities, invitations, picker accounts, or team management.

Enforce uniqueness so duplicate memberships cannot be created accidentally.

# Application review lifecycle

M2 already defines:

```text
DRAFT
SUBMITTED
UNDER_REVIEW
MORE_INFORMATION_REQUIRED
APPROVED
REJECTED
```

M3 activates controlled transitions.

## Admin transitions

Use explicit actions, never a generic status setter:

```text
SUBMITTED -> UNDER_REVIEW
UNDER_REVIEW -> MORE_INFORMATION_REQUIRED
UNDER_REVIEW -> REJECTED
UNDER_REVIEW -> APPROVED
```

Approval succeeds only after provisioning succeeds.

Do not mark the application `APPROVED` before provisioning.

## More information

Requesting more information requires an applicant-visible reason/message.

When status is `MORE_INFORMATION_REQUIRED`:
- applicant can edit allowed application fields;
- applicant can manage allowed documents;
- applicant can resubmit.

Expected applicant transition:

```text
MORE_INFORMATION_REQUIRED -> SUBMITTED
```

Preserve the initial submission timestamp. If needed, add a separate latest/resubmission timestamp.

## Rejection

Rejection requires an applicant-visible reason.

Rejected applications are read-only.

Do not silently allow reapplication in M3.

## Review history

Preserve meaningful review history.

Prefer a small append-only review-history model able to represent:
- review started;
- more information requested;
- resubmitted;
- rejected;
- approved.

Capture:
- application;
- event/action type;
- responsible platform user where applicable;
- reason/message when required;
- timestamp.

Do not build the future full Audit module.

# Approval and provisioning workflow

Approval is a multi-step business mutation and should use supported Medusa workflow patterns where appropriate.

Conceptually:

```text
validate application is UNDER_REVIEW
-> protect against concurrent approval
-> create-or-resolve Merchant
-> create-or-resolve MerchantStore
-> create-or-resolve initial OWNER MerchantMember
-> create/link only appropriate native Medusa location resources
-> persist links
-> append approval history
-> mark application APPROVED
```

The operation must be retry-safe.

## Idempotency and partial failure

Protect against:
- double-click approval;
- retry after transport failure;
- two admins approving concurrently;
- partial provisioning followed by retry.

Required invariants:
- one Merchant per application;
- one MVP MerchantStore per Merchant;
- one initial owner membership for the applicant identity;
- no duplicate native resources caused by retry.

If provisioning fails:
- application must not falsely become `APPROVED`;
- retry must reconcile already-created deterministic resources where practical;
- unrecoverable partial-state errors must be visible and not silently swallowed.

Use database uniqueness plus workflow/service logic.

# Native Medusa provisioning

Use native Medusa APIs/modules/workflows for native resources rather than direct writes to Medusa-owned tables.

For any Stock Location or other native resource:
- keep the custom Merchant/MerchantStore link authoritative for tenancy;
- never use a client-supplied native resource ID as authorization;
- make retry behavior explicit.

Do not create products, variants, inventory items, shipping options, or catalogue state in M3.

# Merchant tenancy resolver

Add a reusable backend foundation:

```text
authenticated merchant identity
-> active MerchantMember
-> active Merchant
-> MerchantStore
```

It must:
- reject authenticated applicants with no approved membership;
- reject inactive/missing membership;
- reject inactive/missing merchant;
- derive IDs server-side;
- never trust `merchant_id` from body/query/header for authorization.

Do not implement M4 RBAC yet.

## Minimal merchant context

Extend the existing merchant probe/context endpoint or add the smallest coherent endpoint so an approved merchant can retrieve safe tenant context.

Example response:

```text
merchant:
  id
  legal_name
  trading_name

store:
  id
  name

membership:
  member_type
```

Do not return auth internals, documents, storage keys, secrets, or finance data.

# Admin API

Add explicit M3 review actions under the existing admin application family.

Conceptually:

```text
POST /admin/gospaza/merchant-applications/:id/start-review
POST /admin/gospaza/merchant-applications/:id/request-information
POST /admin/gospaza/merchant-applications/:id/reject
POST /admin/gospaza/merchant-applications/:id/approve
GET  /admin/gospaza/merchant-applications/:id/review-history
```

Exact naming may follow established conventions.

Rules:
- platform-user authentication required;
- strict input schemas;
- request-information requires reason;
- reject requires reason;
- no generic status mutation route.

# Applicant API changes

Allow applicant editing/document management in:

```text
DRAFT
MORE_INFORMATION_REQUIRED
```

Allow submission from:

```text
DRAFT
MORE_INFORMATION_REQUIRED
```

Applicant cannot set:
- UNDER_REVIEW;
- APPROVED;
- REJECTED.

Applicant can read applicant-visible review messages for their own application only.

# Merchant UI

## MORE_INFORMATION_REQUIRED

Show:
- status;
- review request;
- editable form;
- document management;
- resubmit action.

Preserve unsaved edits during background refresh.

## REJECTED

Show:
- read-only status;
- rejection reason;
- no merchant operations access.

## APPROVED

Show:
- approved status;
- merchant/store summary;
- restrained setup-complete state.

Do not build M4 dashboard/team/catalogue functionality.

# Admin UI

Upgrade the M2 read-only detail view into a controlled review surface.

Allow:
- start review;
- request more information;
- reject;
- approve;
- view review history.

Controls must derive from backend state.

Do not show impossible actions.

Request-information and rejection require a reason.

Approval requires confirmation and should clearly state that merchant tenancy will be provisioned.

No generic status dropdown.

# Security

Use `gospaza-security-review`.

Enforce server-side:
- applicant cannot call admin decision routes;
- merchant actor cannot self-approve;
- customer/driver sessions cannot satisfy admin routes;
- unapproved merchant identities cannot resolve operational tenancy;
- guessed merchant IDs cannot switch tenant;
- one applicant cannot access another application's review history;
- approval cannot create membership for an identity unrelated to the application;
- client cannot choose the owner identity;
- client cannot inject native Medusa resource IDs into provisioning;
- cross-merchant resolution cannot be influenced by request parameters.

# Concurrency and integrity

Add real-database coverage where appropriate for:
- concurrent approval attempts;
- repeated approval;
- one Merchant per application;
- one MVP MerchantStore per Merchant;
- unique owner membership;
- application remains non-APPROVED when provisioning fails.

Do not rely only on mocks for these invariants.

# Tests

## Review lifecycle

Cover:
- SUBMITTED -> UNDER_REVIEW;
- invalid transitions rejected;
- request information requires reason;
- MORE_INFORMATION_REQUIRED becomes editable;
- applicant resubmits;
- first-submission timestamp preserved;
- rejection requires reason;
- rejected application read-only;
- approval only from UNDER_REVIEW.

## Provisioning

Cover:
- approval creates exactly one Merchant;
- exactly one MerchantStore;
- owner membership for applicant identity;
- only selected native Medusa resources;
- application links to Merchant;
- APPROVED only after successful provisioning;
- repeated approval is idempotent;
- concurrent approval cannot duplicate resources.

## Tenant resolution

Cover:
- approved owner resolves tenant;
- unapproved applicant does not;
- request-supplied merchant ID cannot switch tenant;
- inactive/missing membership rejected.

## Admin

Cover:
- platform user allowed;
- wrong actor types rejected;
- controls match legal transitions;
- no generic status mutation exists.

## Browser

Cover:
- request-more-information -> applicant edits/resubmits;
- rejected state;
- approval -> approved merchant summary;
- admin actions appear/disappear according to state.

Keep browser coverage focused on M3.

# Medusa ownership report

The completion report must explicitly state:
- native Medusa `Store` decision;
- Stock Location decision;
- Sales Channel decision;
- native APIs/workflows used;
- why custom Merchant / MerchantStore / MerchantMember are necessary;
- what is authoritative for tenant resolution;
- what native links are persisted for future M5 inventory work.

# Explicitly out of scope

Do NOT implement:
- merchant employee invitations;
- picker accounts;
- M4 RBAC/capability matrix;
- team management;
- bank details;
- commission calculations or finance;
- MerchantCommissionRule unless an already-established architecture absolutely requires only a non-financial placeholder; prefer deferral;
- catalogue/product management;
- inventory editing;
- service-zone configuration;
- customer discovery;
- carts/checkout;
- Yoco;
- orders/picking/substitutions;
- driver onboarding;
- dispatch/delivery/OTP;
- alcohol delivery verification;
- refunds;
- merchant ledger;
- settlements;
- driver earnings;
- notifications;
- broad audit/reporting.

# Command / quota policy

Do not execute installs, migrations, Docker, lint, typecheck, tests, builds, dev servers, or command-heavy verification.

If runtime output is genuinely required:
- give the user one minimal command;
- explain exactly what output is needed;
- stop until the user returns it.

At completion provide ordered `Commands for user to run`.

All PowerShell commands provided to the user must be single-line commands.

# Completion report

When implementation is complete, STOP and return:

```text
MILESTONE M3 COMPLETE

1. Implemented
- ...

2. Medusa ownership decisions
- Native Store decision:
- Stock Location decision:
- Sales Channel decision:
- Native APIs/workflows used:
- Custom tenancy state introduced:

3. Review lifecycle
- ...

4. Merchant provisioning
- ...

5. Schema / migrations
- ...

6. API routes / workflows
- ...

7. Merchant tenancy resolution
- ...

8. UI
- ...

9. Authorization / security
- ...

10. Tests added
- ...

11. Verification status
- Commands were not executed by Codex unless explicitly requested.
- User-supplied results already reviewed:
  - ...
- Still requiring user verification:
  - ...

12. Commands for user to run
1. `<single-line command>`
   - Purpose:
   - Expected result:
   - Stop on failure: yes/no

13. Explicitly NOT implemented
- ...

14. Known limitations
- ...

15. Files/modules materially changed
- ...
```

Stop after M3.
