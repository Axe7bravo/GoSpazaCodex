# M14-B implementation — pending user verification

## Implemented

Metadata-free DRIVER-scoped native identity → immutable unique DriverProfile.auth_identity_id. Native Auth owns email, credentials and sessions; Marketplace owns profile review, affiliation, audit and persistent eligibility. No app_metadata.driver_id writes, native customer association changes, native Auth SQL or compatibility patch.

Driver registration extends the existing EmailPass anti-reclaim guard and rejects additional registration fields. Existing same-email users authenticate with existing credentials. Exact onboarding identity/bootstrap routes admit authenticated DRIVER identities before profile creation; all business routes additionally resolve a valid profile. /driver/me retains its actor envelope with the server-resolved profile ID.

Profile lifecycle, strict edit/submit/review input, current revision checks, one open affiliation, tenant endorsement, platform activation, suspension/reactivation/deactivation and append-oriented audit are implemented. Initial profile + affiliation activation commits atomically. Same-action replay returns its durable receipt and current account; opposite/stale changes conflict. Merchant mutation responses expose only receipts, never private account fields. Closed affiliation detail reads return not found; an authorized old revoke replay cannot touch a later generation.

## Schema

Migration20261018000000 adds driver_profile, driver_affiliation, driver_event. Immutable identity and affiliation binding guards, unconditional identity uniqueness, composite merchant/store FK, one-open partial unique index, lifecycle/revision checks, audit update guard and deferred profile/audit/activation checks are database enforced. No Medusa-owned tables are modified.

## Locking and eligibility

Bootstrap: identity-scoped PostgreSQL advisory lock, native identity revalidation, custom insert/audit transaction.

Merchant-affiliated changes: merchant → profile → affiliation, with active staff/capability revalidation for merchant callers. Platform-only changes: profile → affiliation. Generation discovery is rechecked under locks; changed generations conflict without blind retries. Native customer association does not share a mutable metadata write with bootstrap.

withEligibility provides an internal locked callback for future M15 commitment. eligibility is a point-in-time read, not a permission lease. It checks native identity validity, ACTIVE profile, ACTIVE affiliation, active target store/merchant and matching merchant affiliation. Online state, GPS, workload and dispatch do not exist here.

## Coverage added (not executed)

| Invariant | Coverage |
|---|---|
| Actor scope and same-email identity | verify-drivers: CUSTOMER/MERCHANT/user bootstrap denied; DRIVER customer routes denied; native customer creation races DRIVER bootstrap on same identity |
| Anti-reclaim | Public DRIVER existing-email registration denied; old password remains valid, hostile password invalid |
| One immutable profile | Concurrent/duplicate HTTP bootstrap, SQL uniqueness and immutable binding rejection; deactivated bootstrap returns original profile |
| Customer preservation | Native customer creation, customer login/read, customer_id and unrelated metadata preserved; no driver_id |
| Review lifecycle | Incomplete submit, pending edit rejection, changes-required/edit/resubmit, stale review, duplicate approval, suspension/reactivation/deactivation |
| Affiliation authority | PLATFORM activation; MERCHANT OWNER/MANAGER endorsement and platform activation; picker denial; merchant cannot activate |
| Tenant isolation | Real foreign affiliation IDs, equal foreign/unknown detail response, bounded tenant list, forged tenant filter/body, foreign driver withdrawal |
| Concurrency | Different-store affiliation requests, endorsement vs decline, endorsement vs review, opposing reviewers, resubmission vs stale review, activation vs suspension, revocation vs eligibility |
| Atomic activation | Readback requires ACTIVE profile and ACTIVE affiliation; deferred audit guard; rollback without audit |
| Eligibility | Valid platform/matching merchant, foreign store, disabled store, pending/suspended/deactivated, revoked affiliation, removed native identity; policy tests cover half-active combinations |
| Replay | Duplicate approval/revoke creates one event; old revoke after new affiliation leaves new generation unchanged |
| Staff revalidation | Inactive manager cannot read or replay known-ID mutation |
| DTO privacy | Pending contact redacted; active affiliation contact allowed; auth identity not projected; closed detail inaccessible |
| M1/M4 preservation | verify-auth now uses real driver bootstrap; exact team-policy capability assertions extended without dropping prior permissions/assertions |

## Static security review

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:
- Native session → strict DRIVER scope + native identity validation → immutable profile lookup → own onboarding/business operation.
- Body/known affiliation ID → strict allowlist and current revision → tenant-first capability/ownership revalidation → atomic affiliation/audit transition.
- Platform session → live native User lookup and confirmed bounded reason → locked current profile/affiliation → review decision.
- Candidate/profile + target → current relationships and native identity → locked eligibility callback → bounded persistent eligibility, never dispatch.

No confirmed vulnerability remains identified by this static review. This is not an executed acceptance result. Fine-grained platform grants/MFA and operational scaling remain M23/M25 concerns.

## Commands for user to run

All commands run from repository root. Stop on any failure. No commands were executed by Codex.

### No dev servers running

Stop Next dev processes before typecheck/build to avoid concurrent generated .next writes.

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — all workspace typechecks succeed.
3. `pnpm --filter @gospaza/backend run test` — backend unit/policy tests pass, including driver and unchanged earlier coverage.
4. `pnpm --filter @gospaza/backend run build` — backend production build succeeds.

### Database/Redis available; backend stopped for migration

5. `pnpm --filter @gospaza/backend run db:migrate` — M14 migration completes without errors.

### Backend only running, local development/test configuration

Use the existing backend startup setup; customer/merchant/driver/admin Next servers are not needed.

6. `pnpm --filter @gospaza/backend run test:drivers` — M14-B native-auth/HTTP/database/concurrency verifier passes and removes only its fixtures.
7. `pnpm --filter @gospaza/backend run test:integration` — M1 actor/session/CSRF/CORS verification passes with real driver bootstrap.
8. `pnpm --filter @gospaza/backend run test:team` — M4 tenancy, membership, invitation and anti-reclaim regression passes.

No new browser journey is implemented in B; M14-C owns UI and its browser coverage.

## Limits and exclusions

Reviewed profile fields can only be edited INCOMPLETE/CHANGES_REQUIRED. Revocation deliberately leaves an ineligible gap; no automatic PLATFORM affiliation. Authenticated suspended/deactivated drivers retain own-status access. Platform authority remains the approved native user trust class. Ten new affiliation requests per profile per database-clock hour bounds churn.

No document uploads, separate credentials, customer provisioning changes, M14-C UI, M15 dispatch, online/offline, location, assignment, delivery or earnings. No commit or merge.

## Files materially changed

- `milestones/MILESTONE_M14_DRIVER_ACCOUNTS_ELIGIBILITY.md`
- `milestones/M14_B_IMPLEMENTATION.md`
- `packages/contracts/src/drivers.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/applications.ts`
- `apps/backend/package.json`
- `apps/backend/src/api/middlewares.ts`
- `apps/backend/src/lib/auth-http.ts`
- `apps/backend/src/lib/registration-guard.ts`
- `apps/backend/src/lib/driver-auth.ts`
- `apps/backend/src/lib/driver-http.ts`
- `apps/backend/src/modules/marketplace/service.ts`
- `apps/backend/src/modules/marketplace/team-policy.ts`
- `apps/backend/src/modules/marketplace/driver-policy.ts`
- `apps/backend/src/modules/marketplace/driver-service.ts`
- `apps/backend/src/modules/marketplace/models/driver-profile.ts`
- `apps/backend/src/modules/marketplace/models/driver-affiliation.ts`
- `apps/backend/src/modules/marketplace/models/driver-event.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261018000000.ts`
- `apps/backend/src/workflows/update-driver.ts`
- `apps/backend/src/scripts/verify-drivers.ts`
- `apps/backend/src/scripts/verify-auth.ts`
- `apps/backend/tests/driver-policy.test.ts`
- `apps/backend/tests/team-policy.test.ts`
- `apps/backend/src/api/admin/gospaza/drivers/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/affiliations/[affiliationId]/activate/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/affiliations/[affiliationId]/decline/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/affiliations/[affiliationId]/revoke/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/approve/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/deactivate/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/reactivate/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/require-changes/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/route.ts`
- `apps/backend/src/api/admin/gospaza/drivers/[id]/suspend/route.ts`
- `apps/backend/src/api/driver/affiliation-targets/route.ts`
- `apps/backend/src/api/driver/affiliations/route.ts`
- `apps/backend/src/api/driver/affiliations/[affiliationId]/withdraw/route.ts`
- `apps/backend/src/api/driver/me/route.ts`
- `apps/backend/src/api/driver/onboarding/me/route.ts`
- `apps/backend/src/api/driver/profile/bootstrap/route.ts`
- `apps/backend/src/api/driver/profile/route.ts`
- `apps/backend/src/api/driver/profile/submit/route.ts`
- `apps/backend/src/api/merchant/drivers/route.ts`
- `apps/backend/src/api/merchant/drivers/[id]/decline/route.ts`
- `apps/backend/src/api/merchant/drivers/[id]/endorse/route.ts`
- `apps/backend/src/api/merchant/drivers/[id]/revoke/route.ts`
- `apps/backend/src/api/merchant/drivers/[id]/route.ts`
