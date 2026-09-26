# GoSpaza — Milestone M4
## Merchant Portal Foundation & RBAC

Implement **Milestone M4 only**.

Follow all applicable repository instructions.

Use:
- `gospaza-milestone-implementer` for milestone scope and verification discipline.
- `medusa-first-architecture` for Medusa auth/module decisions.
- `gospaza-security-review` for tenancy, invitations, authorization, and actor boundaries.

Do not run command-heavy verification. The user will run commands.

# Objective

Build the first operational merchant portal foundation on top of the verified M3 tenant model.

M4 introduces:
- role-based access control for merchant members;
- the merchant portal shell;
- team membership visibility;
- secure merchant-team invitations;
- invitation acceptance;
- member role/status management within strict MVP rules;
- reusable capability guards for later merchant features.

M4 does **not** implement catalogue, inventory, orders, picking, merchant delivery configuration, finance, settlements, or broad merchant settings.

# Authoritative tenancy chain

M3 established:

```text
authenticated merchant auth identity
-> active MerchantMember
-> active Merchant
-> MerchantStore
```

Keep this chain authoritative.

Never derive merchant tenancy from email, request body/query/header merchant ID, application ID, URL merchant ID, or frontend state.

An authenticated merchant actor with no active membership remains an applicant/non-operational merchant identity.

# MVP membership invariant

Keep merchant context unambiguous in MVP:

```text
one merchant auth identity -> at most one active merchant membership
```

If M3 already enforces a stronger compatible uniqueness rule, preserve it. Do not build multi-merchant account switching in M4.

# Roles

Use only:

```text
OWNER
MANAGER
PICKER
```

M3's approved applicant remains OWNER.

## OWNER

May:
- access merchant portal;
- view merchant/store summary;
- view team;
- invite MANAGER or PICKER;
- revoke pending invitations;
- change MANAGER <-> PICKER;
- deactivate/reactivate non-owner members.

## MANAGER

M4 permissions:
- access portal;
- view merchant/store summary;
- view team.

Do not grant team management unless an existing repository rule already explicitly requires it.

## PICKER

M4 permissions:
- access portal;
- view safe merchant/store context needed for the shell.

Do not implement picking operations until M12.

# Capability model

Implement a small reusable capability layer rather than scattering role string checks.

Suggested M4 capabilities:

```text
MERCHANT_PORTAL_ACCESS
MERCHANT_CONTEXT_VIEW
MERCHANT_TEAM_VIEW
MERCHANT_TEAM_MANAGE
```

Role-to-capability mapping should be code/config owned and easy to extend later.

Do not build a database-driven permission editor or predefine large M5+ permission sets.

Backend enforcement is authoritative. Frontend capability checks are presentation only.

# MerchantMember

Evolve the M3 membership model only as required.

Expected concepts:

```text
id
merchant_id
auth_identity_id
role
status
created_at
updated_at
```

Status must support at least:

```text
ACTIVE
INACTIVE
```

If M3 uses compatible naming such as `member_type`, migrate/extend carefully instead of rewriting stable data unnecessarily.

Integrity rules:
- OWNER cannot be deactivated in M4;
- OWNER cannot be demoted in M4;
- members cannot promote themselves or others to OWNER;
- invitation acceptance cannot create duplicate membership;
- an auth identity already belonging to another merchant cannot accept a second active membership under the MVP invariant.

Ownership transfer is deferred.

# MerchantInvitation

Add a custom invitation entity or equivalent with fields conceptually like:

```text
id
merchant_id
email_normalized
role
token_hash
expires_at
accepted_at nullable
revoked_at nullable
created_by_member_id
accepted_by_identity_id nullable
created_at
updated_at
```

Do not persist the raw token.

## Invite-secret security

Generate a cryptographically strong random token server-side.

Persist only a secure hash/verifier.

The raw token:
- may be returned once when the invitation is created;
- may be placed in a copyable invite URL;
- must not be logged;
- must not be stored in plaintext;
- must not be returned from normal invitation-list endpoints.

Invites must be single-use, revocable, and expiring. Keep expiry duration centralized/configurable; seven days is a sensible default if no existing rule exists.

# No fake email delivery

M22 owns notification infrastructure.

M4 must not pretend email sending exists.

Until notifications are implemented:
- OWNER creates an invitation;
- UI displays the one-time invite link immediately after creation;
- OWNER copies/shares it manually;
- page reload must not reveal the raw token again;
- lost link means revoke and create a new invite.

Document this limitation. Never log the raw invitation URL.

# Invitation creation

Only a member with `MERCHANT_TEAM_MANAGE` can create invites.

Input:

```text
email
role = MANAGER | PICKER
```

Rules:
- OWNER cannot be selected as invite role;
- normalize email consistently;
- cannot invite the current owner;
- cannot invite an existing active member of the same merchant;
- prevent duplicate active invitations for the same merchant/email unless there is an explicit safe policy;
- merchant is derived from authenticated tenancy;
- client cannot supply merchant ID or inviter member ID as authority.

# Invitation acceptance

Acceptance must support a new or existing merchant-auth identity.

Required behavior:

```text
valid invite token
+ authenticated merchant identity
+ matching normalized invited email when available from supported Medusa auth context
+ no conflicting active membership
-> create ACTIVE MerchantMember
-> mark invitation accepted
```

Acceptance must be atomic/transactional where practical.

Do not:
- create a second auth system;
- accept customer/driver/platform-user identities;
- let client choose merchant ID;
- let client choose accepted role;
- let client choose auth identity ID.

## Email-verification limitation

M1/M2 did not implement verified-email delivery.

Do not claim invite acceptance proves email ownership. M4 security relies on the high-entropy invitation secret, an authenticated merchant identity, and normalized invited-email matching. Document the limitation.

# Invitation states

Expose safe derived states:

```text
PENDING
ACCEPTED
REVOKED
EXPIRED
```

Expiry may be derived from `expires_at`; do not add a scheduled expiry job solely for M4.

# Team APIs

Add only the APIs needed by M4, conceptually:

```text
GET  /merchant/team
GET  /merchant/team/invitations
POST /merchant/team/invitations
POST /merchant/team/invitations/:id/revoke
POST /merchant/team/invitations/accept
PATCH /merchant/team/members/:id
```

Exact naming may follow current conventions.

## Team listing

Requires `MERCHANT_TEAM_VIEW`.

Return safe DTOs only. Do not expose raw auth-provider state.

Useful fields may include member ID, safe display/email identifier if supportable, role, status, and created_at.

## Invitation listing

Never return token hash or original raw token.

Return only safe metadata such as ID, email, role, state, expires_at, created_at.

## Member mutation

Requires `MERCHANT_TEAM_MANAGE`.

Allow only:
- MANAGER -> PICKER;
- PICKER -> MANAGER;
- ACTIVE <-> INACTIVE for non-owner members.

Reject:
- OWNER mutation;
- promotion to OWNER;
- deactivating OWNER;
- arbitrary role/status values;
- mutation of another merchant's member even when ID is known.

# Acceptance-route exception

Invitation acceptance requires merchant-actor authentication but **not existing merchant tenancy**, because invitees do not yet have a membership.

Structure middleware carefully so:
- anonymous callers cannot accept;
- customer/driver/platform-user sessions cannot accept;
- authenticated merchant applicants/non-members can accept a valid invitation;
- existing members cannot use an invitation to switch merchants under the MVP single-membership rule.

# Merchant portal routing

After merchant authentication:

## ACTIVE member

Route to merchant portal.

## Applicant / non-member

Continue to the M2/M3 application journey/status.

## Invitation flow

If arriving through an invitation URL, preserve the token through login/registration only as long as required to finish acceptance.

Do not persist invitation tokens permanently in localStorage or send them to analytics/logging.

# Merchant portal shell

Build the operational shell in `apps/merchant`.

Expected routes:

```text
/merchant
/merchant/team
```

Keep applicant routes separate.

The shell should show:
- merchant/store name;
- current member role;
- role-appropriate navigation;
- sign out;
- loading/error states.

Do not show links to catalogue, inventory, orders, delivery, or settlements before those routes exist.

## Portal home

Keep it intentionally light:
- merchant/store identity;
- current role;
- provisioning complete state;
- team shortcut when authorized.

Do not fabricate metrics.

# Team UI

At `/merchant/team`:

OWNER:
- view members;
- view invitation metadata;
- invite MANAGER/PICKER;
- copy newly-created one-time link;
- revoke pending invite;
- change non-owner MANAGER/PICKER role;
- activate/deactivate non-owner member.

MANAGER:
- read-only team view.

PICKER:
- team navigation may be hidden if `MERCHANT_TEAM_VIEW` is not granted.

No ownership transfer.

# Invitation acceptance UI

Provide a clear acceptance journey, for example:

```text
/invite/[token]
```

or the closest coherent route.

Anonymous:
- prompt to sign in/create merchant-auth account;
- preserve return path/token safely.

Authenticated merchant identity:
- accept invitation;
- show safe errors for expired/revoked/used/wrong-email/conflicting-membership cases;
- after success route to `/merchant`.

Do not reveal private merchant data to an unauthenticated caller merely because a token-shaped value was supplied.

# Security

Use `gospaza-security-review`.

Required protections:
- tenancy always derived from active membership;
- backend capability enforcement;
- manager/picker cannot call owner-only mutation routes;
- inactive member cannot resolve operational tenancy;
- known member/invitation IDs cannot cross tenant boundaries;
- client cannot choose merchant, inviter, accepted role, or accepted identity;
- raw token not persisted/logged/listed;
- token hash never sent to browser;
- revoked/expired/accepted invite cannot be reused;
- invitation acceptance cannot create duplicate membership;
- wrong actor type cannot accept invite;
- OWNER protections cannot be bypassed by direct API calls;
- safe DTOs do not leak auth-provider internals.

# Concurrency and integrity

Add real-database coverage where appropriate for:
- simultaneous acceptance of one invitation -> one membership;
- repeated acceptance -> no duplicate membership;
- duplicate invitation creation where relevant;
- cross-merchant known-ID member mutation rejection;
- unique active membership invariant;
- revoked invitation cannot race into accepted state;
- deactivated member loses tenant access.

Use database constraints plus service/workflow logic.

# Tests

## RBAC

Cover OWNER/MANAGER/PICKER capability mapping and backend rejection when capability is missing.

## Invitations

Cover:
- owner creates MANAGER/PICKER invite;
- cannot invite OWNER;
- raw token only returned at creation;
- list does not expose raw/hash;
- expiry;
- revocation;
- accepted/revoked/expired token cannot be reused;
- email mismatch rejected;
- wrong actor rejected;
- concurrent acceptance creates one membership.

## Membership

Cover:
- invited identity gets correct role;
- duplicate membership rejected;
- MANAGER <-> PICKER;
- non-owner deactivate/reactivate;
- OWNER cannot be demoted/deactivated;
- cross-merchant mutation rejected;
- inactive member cannot resolve merchant tenant.

## Portal/API

Cover:
- approved owner reaches portal;
- manager reaches portal;
- picker reaches allowed shell;
- applicant without membership remains in application journey;
- team route capability behavior;
- safe DTOs.

## Browser

Cover critical M4 journeys:
- owner creates invite and receives one-time copyable link;
- invited user authenticates/accepts and reaches portal;
- manager/picker cannot use owner controls;
- owner mutation protections;
- inactive member loses operational access.

Keep browser coverage focused and deterministic.

# Medusa ownership report

Completion report must state:
- how merchant EmailPass identities are reused for invited members;
- whether any new Medusa-native entity was required;
- what remains authoritative for tenancy;
- how invitation acceptance links auth identity to MerchantMember;
- how capability checks are implemented;
- why no second auth system was introduced.

# Documentation

Update only what M4 requires:
- roles/capabilities;
- invitation lifecycle;
- manual one-time invite-link sharing limitation;
- single-membership MVP invariant;
- portal routing;
- owner protection rules;
- verification commands.

Do not document M5+ features as implemented.

# Explicitly out of scope

Do NOT implement:
- ownership transfer;
- custom role/permission editor;
- multi-merchant account switching;
- email sending/notification provider;
- verified-email flow unless independently existing;
- MFA;
- catalogue/product management;
- inventory management;
- stock-location provisioning solely for future inventory;
- orders/picking/substitutions;
- delivery configuration;
- driver management;
- service zones;
- customer marketplace work;
- checkout/Yoco;
- finance/commission;
- settlements;
- broad audit/reporting.

# Command / quota policy

Do not execute installs, migrations, Docker, lint, typecheck, tests, builds, dev servers, or other command-heavy verification.

If runtime output is genuinely required:
- give the user one minimal command;
- explain exactly what output is needed;
- stop until the user returns it.

At completion provide ordered `Commands for user to run`.

All PowerShell commands provided to the user must be single-line commands.

# Completion report

When implementation is complete, STOP and return:

```text
MILESTONE M4 COMPLETE

1. Implemented
- ...

2. Medusa ownership decisions
- Auth identity reuse:
- New native Medusa entities:
- Tenancy authority:
- Invitation-to-membership linkage:

3. RBAC
- Roles:
- Capabilities:
- Backend enforcement:

4. Invitation lifecycle
- Creation:
- Secret storage:
- Expiry/revocation:
- Acceptance:
- Email-verification limitation:

5. Membership integrity
- ...

6. Schema / migrations
- ...

7. API routes / workflows
- ...

8. Portal / UI
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

Stop after M4.
