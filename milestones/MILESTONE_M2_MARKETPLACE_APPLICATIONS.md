# GoSpaza — Milestone M2
## Marketplace Core & Merchant Applications

Implement **Milestone M2 only**.

Follow all applicable repository instructions.

Use:
- `medusa-first-architecture` for Medusa/domain decisions.
- `gospaza-security-review` for applicant ownership, private uploads, actor boundaries, and admin document access.

Do not run command-heavy verification. The user will run commands.

Do not begin M3.

# Objective

Create the first GoSpaza marketplace domain: merchant applications.

M2 allows a prospective merchant to create an authenticated applicant identity, complete an application, upload private supporting documents, submit the application, and view its status.

Platform admins can securely list and inspect submitted applications and their documents.

M2 does **not** approve/provision merchants.

No `Merchant`, `MerchantMember`, Medusa Store, Stock Location, commission rule, merchant team, or operational merchant tenancy is created yet.

# Authentication vs Merchant Authorization

This distinction is mandatory:

```text
merchant auth actor != approved merchant
```

M1 established the `merchant` custom actor type.

In M2, a prospective merchant may create/login to a merchant actor identity for the purpose of applying.

That identity does not grant access to operational merchant APIs.

Only later merchant provisioning/membership establishes merchant tenancy.

# Marketplace Module

Introduce the initial GoSpaza custom marketplace module using the pinned Medusa version's supported module patterns.

M2 owns only application-related state.

Do not add future marketplace entities merely because the module now exists.

## MerchantApplication

Model only fields M2 requires, such as:

```text
id
applicant identity reference
legal_name
trading_name
contact_name
contact_email
contact_phone
structured address fields
intends_to_sell_alcohol
notes (optional)
status
submitted_at
created_at
updated_at
```

Do not hard-code Bloemfontein into domain logic.

## Status

Support the enum shape:

```text
DRAFT
SUBMITTED
UNDER_REVIEW
MORE_INFORMATION_REQUIRED
APPROVED
REJECTED
```

M2 may only perform transitions required for creation/submission and read-only admin review.

Final approval/rejection/provisioning belongs to M3.

Do not expose a generic status setter.

## Ownership

Ownership must use authenticated identity, not email address.

An applicant can access only their own application and documents.

For MVP, keep one current merchant application per merchant applicant identity unless the existing architecture provides a better non-speculative pattern.

Enforce the invariant in the database where practical.

# Merchant Applicant Registration

Extend the merchant frontend so a prospective merchant can create an applicant login using the existing Medusa `merchant` EmailPass actor configuration.

Public applicant registration is now allowed specifically for the application journey.

It must not create:
- Merchant;
- merchant membership;
- Medusa Store;
- Stock Location;
- operational merchant access.

Existing merchant login remains.

After authentication:
- no application -> begin application;
- draft -> continue editing;
- submitted -> status view.

# Merchant Application UI

Implement a responsive application experience in `apps/merchant`.

Expected routes may include:

```text
/apply
/application
/application/documents
```

Use the most coherent route structure for the existing app.

The application form should include:
- legal name;
- trading name;
- contact name;
- contact email;
- contact phone;
- structured physical address;
- whether the store intends to sell alcohol;
- optional notes.

Do not represent any field/document as legally sufficient for South African regulatory compliance unless that requirement has been explicitly provided.

# MerchantApplicationDocument

Add private application-document metadata associated with the application.

Suggested metadata:

```text
id
application_id
document_type
display_name/original_filename
storage_key
mime_type
size_bytes
created_at
```

Do not store file bytes in PostgreSQL.

Document type may include organizational categories such as:

```text
BUSINESS_REGISTRATION
REPRESENTATIVE_ID
LIQUOR_DOCUMENT
OTHER
```

These are organizational metadata only in M2; do not hard-code legal sufficiency.

# Private File Storage

Before creating custom storage, inspect whether the pinned Medusa File Module/provider APIs satisfy GoSpaza's private-document requirements.

If native Medusa file handling can provide private storage, authorized retrieval, non-public/signed access, and production-compatible provider abstraction, prefer it.

Otherwise implement the smallest private document-storage abstraction required by M2.

Development may use private local filesystem storage.

Production-facing design must be compatible with private S3-compatible object storage.

Do not expose application documents through public/static frontend paths.

## Upload validation

Use:

```text
PDF
JPEG
PNG
maximum 10 MB per file
```

Validate server-side.

Do not rely only on browser MIME metadata or file extensions.

Generate server-side storage keys.

Never use the raw uploaded filename as a filesystem/object-storage path.

# File lifecycle consistency

When upload succeeds but persistence fails, clean up the new object where practical.

When removing/replacing a draft document, clean up safely.

Never delete before establishing actor authorization.

Do not silently swallow storage cleanup failures.

# Applicant API

Create only APIs required for the M2 journey.

Conceptually:

```text
POST /merchant/applications
GET  /merchant/applications/me
PATCH /merchant/applications/:id
POST /merchant/applications/:id/documents
DELETE /merchant/applications/:id/documents/:documentId
POST /merchant/applications/:id/submit
GET /merchant/applications/:id/documents/:documentId/access
```

Exact route naming may follow project conventions.

Rules:
- merchant actor authentication required;
- ownership derived from authenticated actor;
- draft editable;
- submitted generally read-only;
- submit validates required fields;
- repeat submit is safe/idempotent where practical;
- document access is authorized.

Do not accept applicant actor ID from the client as ownership authority.

# Admin API

Add read-only M2 admin capabilities:

```text
GET /admin/gospaza/merchant-applications
GET /admin/gospaza/merchant-applications/:id
GET /admin/gospaza/merchant-applications/:id/documents/:documentId/access
```

Platform-user authentication required.

Support practical list behavior such as status filter, basic search, and pagination.

Do not implement approve/reject/provisioning.

# Admin UI

Implement:

```text
/admin/merchant-applications
/admin/merchant-applications/[id]
```

Admin can inspect application details and securely access document metadata/content.

The UI is read-only in M2.

# Applicant state behavior

```text
no application -> create/start
DRAFT -> editable
SUBMITTED -> read-only status
```

If later-state values are encountered, render safe read-only status rather than allowing edits.

# Security

Enforce server-side:

- applicant A cannot read/mutate applicant B application;
- applicant A cannot read/delete applicant B document;
- submitted application cannot be edited through normal applicant APIs;
- applicant cannot set status directly;
- applicant cannot create an approved Merchant;
- wrong actor types cannot satisfy applicant/admin authorization;
- private files are not accessible at predictable public URLs.

Do not expose auth internals, password hashes, secrets, storage credentials, or unrelated actor metadata.

# Audit boundary

M2 does not build the full Audit module.

Application submission must retain immutable submission timestamp/state information.

# Tests

Add focused coverage for:

## Application domain
- create draft;
- retrieve own;
- update draft;
- required submission validation;
- submit;
- repeat submit behavior;
- submitted edit rejection.

## Ownership
- applicant A cannot read/mutate applicant B application;
- applicant A cannot read/delete applicant B document;
- guessed IDs do not bypass ownership.

## Files
- PDF/JPEG/PNG accepted;
- unsupported type rejected;
- over-size rejected;
- generated storage path/key safety;
- authorized/unauthorized access;
- cleanup behavior when persistence fails where practical.

## Admin
- platform user can list/read;
- non-platform actors rejected;
- no final-decision mutation exists in M2.

## Frontend
Cover important applicant states and admin read-only states at an appropriate level.

# Medusa Ownership Decision

Completion report must state:
- Medusa-native capabilities inspected for auth and file storage;
- custom marketplace state introduced;
- why `MerchantApplication` is custom rather than a duplicate Medusa entity;
- how application ownership relates to Medusa auth identity;
- which component owns file metadata and bytes.

# Documentation

Update only as needed for:
- merchant applicant registration;
- M2 application lifecycle;
- private document storage configuration;
- local development storage;
- new environment variables;
- manual verification.

# Explicitly Out of Scope

Do NOT implement:
- approved Merchant;
- MerchantMember;
- merchant team/pickers;
- approval/rejection;
- merchant provisioning;
- Medusa Store/Stock Location provisioning;
- commission rules;
- merchant bank details;
- catalogue/inventory;
- service zones;
- customer discovery/cart/checkout;
- Yoco/orders/picking/substitutions;
- drivers/dispatch/delivery/OTP;
- alcohol delivery verification;
- finance/settlements/notifications.

# Command / Quota Policy

Do not execute installs, migrations, Docker, lint, typecheck, tests, builds, dev servers, or other command-heavy verification.

If runtime output is genuinely required, give the user one minimal command, explain exactly what output is needed, and stop.

At completion provide ordered `Commands for user to run`.

All PowerShell commands provided to the user must be single-line commands.

# Completion Report

When implementation is complete, STOP and return:

```text
MILESTONE M2 COMPLETE

1. Implemented
- ...

2. Medusa ownership decisions
- Native concerns inspected:
- Marketplace custom state introduced:
- Auth ownership boundary:
- File ownership/storage boundary:

3. Schema / migrations
- ...

4. API routes / workflows
- ...

5. UI
- ...

6. Authorization / security
- ...

7. Tests added
- ...

8. Verification status
- Commands were not executed by Codex unless explicitly requested.
- User-supplied results already reviewed:
  - ...
- Still requiring user verification:
  - ...

9. Commands for user to run
1. `<single-line command>`
   - Purpose:
   - Expected result:
   - Stop on failure: yes/no

10. Explicitly NOT implemented
- ...

11. Known limitations
- ...

12. Files/modules materially changed
- ...
```

Do not continue to M3.
