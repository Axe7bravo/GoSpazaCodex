# GoSpaza — Milestone M1 Prompt
## Authentication & Actor Foundations

You are implementing **Milestone M1 only** for GoSpaza.

Before changing anything:

1. Read repository-level `AGENTS.md` in full.
2. Read `skills/medusa-first-architecture/SKILL.md` in full and apply it throughout this milestone.
3. Inspect the completed M0 repository before editing.
4. Inspect the exact pinned Medusa versions and existing auth/CORS/configuration.
5. Use current Medusa-native authentication patterns. Do not create a parallel authentication system.
6. Do not run installs, migrations, tests, lint, typecheck, builds, Docker, dev servers, or other command-heavy verification. The user will run commands.
7. Do not begin M2 or later functionality.

# Objective

Establish GoSpaza's authentication and actor boundaries without prematurely creating merchant, driver, delivery, marketplace, or finance business domains.

The four actor classes are:

```text
customer
merchant
driver
platform user
```

Mapping:

```text
customer      -> Medusa customer actor
platform user -> Medusa native user actor
merchant      -> Medusa custom actor type
driver        -> Medusa custom actor type
```

M1 establishes authentication infrastructure, route protection, client/session behavior, and frontend authentication foundations.

Merchant business provisioning belongs to later merchant milestones.
Driver business provisioning belongs to the driver milestone.

# Important Scope Refinement

Do **not** create `Merchant`, `MerchantMember`, `Driver`, `DriverVehicle`, or other later-domain records solely to satisfy M1 authentication.

For merchant and driver actors, M1 should establish:
- supported actor-type configuration;
- authentication middleware/route-guard foundations;
- API/client conventions;
- login capability for an already-provisioned identity;
- safe behavior when no corresponding identity exists yet.

Successful business account provisioning is intentionally deferred.

# Authentication Method

Use Medusa's supported EmailPass authentication provider for M1.

Configure allowed auth methods explicitly for the relevant actor types using the pinned Medusa version's supported configuration.

Expected actor/provider intent:

```text
customer -> emailpass
user     -> emailpass
merchant -> emailpass
driver   -> emailpass
```

Be careful: when configuring `authMethodsPerActor`, Medusa treats the configured mapping as authoritative. Do not accidentally disable required actors by omission.

Do not add Google, phone, OTP-login, magic-link, or other authentication providers in M1.

# Browser Session Strategy

Prefer Medusa's native **session authentication** for the four browser-based GoSpaza applications unless inspection of the pinned Medusa version proves it unsuitable.

Do not build a custom JWT/localStorage auth layer merely for convenience.

Use the appropriate Medusa auth/session routes and configure clients to send credentials correctly.

Review and preserve secure CORS behavior for the local frontend origins.

Do not weaken CORS to `*` with credentials.

# Customer Authentication

Implement the first usable customer authentication flow in `apps/customer`.

Required:

```text
/register
/login
/account
```

Behavior:
- register a customer using Medusa's supported registration flow;
- log in using EmailPass;
- establish/persist the chosen Medusa session;
- retrieve the authenticated customer using native Medusa customer functionality;
- log out correctly;
- redirect/protect `/account` when unauthenticated;
- show useful validation/authentication errors;
- handle loading state.

Use the existing shared API-client/SDK foundation where appropriate.

Do not yet build addresses, wallet, orders, age verification, checkout, or profile editing beyond what is minimally needed to prove authentication.

# Merchant Authentication Foundation

In `apps/merchant`, add:

```text
/login
```

The page may authenticate an already-provisioned merchant actor identity.

Do not provide public merchant self-registration.

Merchant application/onboarding starts in M2.

The merchant portal's protected shell must require the `merchant` actor type.

Do not infer merchant tenancy from a request-supplied merchant ID.

At this milestone there may be no production merchant identity to log in with yet. That is acceptable.

# Driver Authentication Foundation

In `apps/driver`, add:

```text
/login
```

The page may authenticate an already-provisioned driver actor identity.

Do not provide public driver self-registration.

Driver onboarding/provisioning is deferred.

The driver protected shell must require the `driver` actor type.

# Platform Admin Authentication Foundation

Use Medusa's native `user` actor for platform-user authentication.

In `apps/admin`, add:

```text
/login
```

and protect the admin shell.

Do not provide public platform-user registration.

Do not implement the full GoSpaza capability/RBAC matrix yet.

M1 only establishes:
- authenticated platform-user boundary;
- reusable authorization foundation that later capability checks can extend.

Do not treat a customer, merchant, or driver identity as a platform user.

# Backend Actor Guards

Create clear reusable backend protection for actor-specific GoSpaza routes using the pinned Medusa middleware APIs.

Expected route families remain:

```text
/store/gospaza/*
/merchant/*
/driver/*
/admin/gospaza/*
```

For M1, add only minimal authenticated identity/probe routes needed to verify actor separation.

Examples may include:

```text
GET /store/gospaza/me
GET /merchant/me
GET /driver/me
GET /admin/gospaza/me
```

The exact response must be role-appropriate and must not expose raw auth identity/provider internals.

For merchant/driver, do not fabricate a domain profile that does not exist yet. If only authenticated actor context is available at M1, return only the minimal safe actor context.

# Actor Separation

Server-side enforcement is mandatory.

Prove in tests that:
- unauthenticated access to protected actor routes is rejected;
- customer credentials cannot access merchant routes;
- customer credentials cannot access driver routes;
- customer credentials cannot access platform-admin routes;
- merchant actor cannot access driver/platform-user protected routes;
- driver actor cannot access merchant/platform-user protected routes;
- platform user is distinct from customer/merchant/driver actors.

Do not rely on frontend routing for security.

# Registration Boundaries

Customer self-registration: allowed.

Merchant self-registration as a business/operator account: not allowed in M1.

Driver self-registration as an operational driver account: not allowed in M1.

Platform-user public registration: forbidden.

If Medusa exposes generic actor registration-token endpoints for configured custom actor types, do not build public UI or GoSpaza routes that turn those tokens into merchant/driver business accounts before the correct milestone.

# API Client

Extend `packages/api-client` only as required for M1.

Keep actor-specific authentication concerns explicit enough that later merchant/driver/admin clients cannot accidentally reuse customer identity.

Do not create giant speculative clients for future APIs.

# Frontend Auth UX

Use the approved GoSpaza design system established in M0.

Customer:
- mobile-first and fully responsive.

Merchant:
- desktop/tablet oriented login.

Driver:
- mobile-first login.

Admin:
- desktop-first login.

Keep M1 UI intentionally focused. Do not build marketplace/business dashboards early.

Required states where relevant:
- idle;
- submitting;
- invalid credentials;
- validation error;
- backend unavailable;
- authenticated redirect.

# CORS / Cookies / Session Security

Inspect existing M0 `storeCors`, `adminCors`, and `authCors` configuration.

Update only as needed so all four local frontend applications can authenticate safely.

Do not:
- use wildcard credentialed CORS;
- expose cookie secrets;
- weaken production defaults;
- invent cross-origin workarounds that bypass Medusa's supported session model.

Document any production-domain assumptions that will need configuration later.

# Secrets

Do not commit credentials, test passwords, session tokens, or generated secrets.

Test users/credentials may exist only in test fixtures or documented local setup steps as appropriate.

# No Email Infrastructure Yet

Do not implement:
- forgot-password email delivery;
- email verification delivery;
- transactional email provider setup.

Those depend on later notification infrastructure.

Do not fake successful email sending.

# No MFA Implementation Yet

Do not implement MFA in M1.

Keep the platform-user auth boundary compatible with adding admin MFA later.

# Tests

Add the tests appropriate to the code added.

Expected coverage includes:

## Backend/API
- protected route rejects anonymous request;
- correct actor can access its route;
- wrong actor cannot access another actor's route;
- auth configuration includes intended actor/provider mapping;
- response DTOs do not leak sensitive auth data.

## Customer
- registration validation;
- login success behavior;
- login failure behavior;
- authenticated account retrieval;
- logout;
- unauthenticated account redirect/protection.

## Merchant/Driver/Admin
- login form behavior;
- protected shell behavior;
- incorrect actor/session handling.

Prefer real integration coverage for actor-boundary behavior where practical.

Do not weaken the tests merely because merchant/driver business entities are intentionally deferred.

# Documentation

Update README/docs only as necessary to explain:
- actor mapping;
- session-auth strategy;
- local auth CORS/origins;
- which actor types can self-register in M1;
- which identities are provisioned only in later milestones;
- how the user can manually verify M1.

Do not document future business workflows as if implemented.

# Explicitly Out of Scope

Do NOT implement:

- Merchant applications.
- Merchant entity/business profile.
- Merchant approval/provisioning.
- Merchant teams or picker roles.
- Merchant tenant data.
- Driver profile/domain entity.
- Driver vehicle/documents.
- Driver approval.
- Platform capability matrix/full RBAC.
- Products/catalogue.
- Inventory.
- Customer addresses.
- Service zones.
- Cart.
- Checkout.
- Yoco.
- Orders.
- Picking.
- Substitutions.
- Dispatch.
- Delivery OTP.
- Alcohol age verification.
- Store credit/refunds.
- Finance.
- Settlements.
- Driver earnings.
- Notification providers.
- MFA.
- Social login.
- Phone login.

# Command / Quota Policy

Do not execute command-heavy verification.

If implementation requires runtime information you cannot determine statically:
1. give the user the exact minimal command;
2. explain the output needed;
3. stop until they return it.

At completion, provide an ordered **Commands for user to run** section.

Prefer the minimum sequence necessary to verify M1.

Because migrations may or may not be required depending on the final implementation, do not invent a migration command if no schema change occurred.

# Completion Report

When the implementation portion of M1 is complete, STOP and return:

```text
MILESTONE M1 COMPLETE

1. Implemented
- ...

2. Medusa ownership decisions
- Native concerns inspected:
- Custom state introduced:
- Source-of-truth boundaries:

3. Schema / migrations
- ...

4. API routes / authentication
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
1. `<command>`
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

Do not continue to M2.

Wait for review.
