# M14-C — Driver, Merchant & Platform Admin UX

Implementation complete; user verification pending. No verification commands were executed. No commit was created. M14-D/M15 are not started.

## Implemented

- Driver /login and /register reuse native DRIVER EmailPass/session exchange. Existing-email registration instructs sign-in; it does not retry registration, replace credentials or create another password.
- Driver / restores the authenticated account using /driver/onboarding/me and /driver/profile. Only a still-authenticated missing profile offers explicit bootstrap. No browser profile ID or native driver metadata is used as authority.
- Mobile-first profile edit, affiliation selection from bounded server store pages, submit/resubmit, read-only review/active/suspended/deactivated presentation, explicit withdrawal, bounded affiliation history, loading/error/retry and focus/reload restoration.
- Merchant /merchant/drivers and /merchant/drivers/:id show tenant-scoped requests/roster and explicit confirmed, reasoned endorse/decline/revoke actions. PICKER has no navigation or management surface. Existing merchant shell revalidates membership; failures clear child data.
- Platform /admin/drivers and /admin/drivers/:id provide bounded status-filtered queue, detail/revision, approval, changes-required, suspension/reactivation/deactivation and later affiliation activation/decline/revocation.
- Shared request lifecycle ignores old/unmounted reads, synchronously guards duplicate mutations, suppresses focus reads during a write and performs authoritative readback afterward. A 409 or unknown write result never causes mutation replay; fresh controls require a new explicit action and confirmation.

## Bounded integration corrections

M14-B account DTOs lacked a server-owned eligibility summary. Added eligibility to own/admin account projections by extracting existing profile/affiliation/native-identity prerequisites from persistentEligibility. The target-store check remains mandatory in the existing dispatch eligibility method. Merchant-affiliated account summaries also check their current store. PLATFORM summary approval is explicitly not a target-store assignment or online availability.

Merchant projection lacked the information needed to hide endorsement for suspended/deactivated profiles without exposing platform review internals. Added available_actions from the existing merchant transition prerequisites, shared with the mutation boundary. The permitted transitions, replays, tenant authorization and locking remain unchanged.

No new backend route, schema, migration, dependency, native Auth metadata write, credentials store or commerce mutation was introduced. Native Medusa 2.18.0 remains Auth owner. No second frontend eligibility calculation exists.

## Coverage added / updated

| Requirement | Evidence added |
|---|---|
| DRIVER native scope, transient token, existing-email sign-in | packages/api-client/tests/drivers.test.ts |
| Same-email CUSTOMER/DRIVER separation | client actor-probe test; existing real test:drivers same-identity concurrency retained |
| Strict outbound fields, revisions, no mutation replay, safe errors | driver client tests |
| Bounded actor-specific page queries | driver client tests |
| Shared eligibility gates and merchant action projection | apps/backend/tests/driver-policy.test.ts |
| Real own/admin eligibility after approval/suspension/store deactivation; permitted actions | strengthened apps/backend/src/scripts/verify-drivers.ts |
| Bootstrap/edit/request/submit/reload, changes-required corrections | tests/browser/drivers.spec.ts |
| ACTIVE/SUSPENDED/DEACTIVATED and closed history, no automatic platform conversion | driver browser scenarios |
| Wrong-actor onboarding denied; existing-email registration; logout/login restoration | driver browser scenarios |
| OWNER/MANAGER roster + endorsement, PICKER absence, foreign detail, membership loss | merchant browser scenarios |
| Merchant revocation, empty roster, suspended endorsement hidden, conflict refetch | merchant browser scenarios |
| Admin queue/approval/require-changes/suspend/reactivate/deactivate | admin browser scenarios |
| Admin stale revision/revoked affiliation readback; no replay; duplicate-click guard | admin browser scenarios |
| API outage clears driver data and explicit refresh restores | driver browser scenario |
| Existing M1 auth journeys | auth.spec.ts driver fixture updated for verified onboarding route, all assertions retained |

Browser mocks establish UX only, not real backend authorization/concurrency. M14-B HTTP/database coverage remains required and unchanged except added projection assertions. No browser timeout increases, sleeps, retries or response-finished bypasses were added. Readiness uses only needed documents and fresh test fixtures.

## Security data flows

- Credentials → existing native driver client → DRIVER-scoped session exchange → backend onboarding/profile resolution. Tokens remain transient; no local/session storage authority.
- Driver fields/selected server store reference → client allowlist → existing strict API/domain validation and profile/tenant locking → approved own-profile/request mutations only.
- Merchant known affiliation ID + reason/revision → current M4 capabilities → tenant-scoped backend decision → same audited lifecycle. IDs never authorize; wrong tenant remains inaccessible.
- Platform decision + expected revision → native user boundary → existing current-revision policy → explicit audited state transition. Conflict readback is GET-only, not automatic retry.
- Server DTO → React text rendering → role-specific views. No raw Auth metadata, provider errors, sensitive review diagnostics or credentials in logs/UI.

No new credible critical/high/medium vulnerability identified by static review. Runtime verification is pending. Existing platform-user granularity/MFA belongs to M23/M25; this slice does not invent grants. Dispatch-time locked eligibility remains M15's responsibility.

## Commands for user to run

All commands start at repository root. Stop on every failure and return its output. Expected results are no lint warnings/errors, no TypeScript errors, all selected tests passing, and successful production builds. Stop Next dev processes before typecheck/build so generated .next files are not concurrently written.

### A. No dev servers

1. pnpm run lint — static checks, zero warnings.
2. pnpm run typecheck — all workspace types pass.
3. pnpm --filter @gospaza/api-client run test — existing auth/client and new driver-client suites pass.
4. pnpm --filter @gospaza/backend run test — existing policy/provider tests and added driver projection tests pass.
5. pnpm run build — production builds, including shared auth UI consumers, succeed.

### B. Backend only (PostgreSQL/Redis and local backend available)

No migration added by C. Use the already-verified M14-B schema/configuration. No Next apps are required.

1. pnpm --filter @gospaza/backend run test:drivers — real actor/tenant/lifecycle/race tests plus own/admin projection assertions pass.
2. pnpm --filter @gospaza/backend run test:integration — existing four-actor native Auth regression passes.

### C. Playwright-managed driver/merchant/admin stack

1. pnpm exec playwright test --config=playwright.m14.config.ts — new M14 browser journeys pass; only driver/merchant/admin servers start, one worker.
2. pnpm exec playwright test — full earlier-milestone regression; this command intentionally uses the full four-app browser stack, including customer.

Browser backend requests are mocked. No live payment/provider operation is needed.

## Known limitations and exclusions

- Own/admin accounts expose no review reason text in M14-B; changes-required shows safe generic correction guidance rather than inventing reviewer feedback.
- Closed merchant affiliations become inaccessible to merchants, as designed in B. After successful close, UI clears details and presents the existing safe unavailable state plus the mutation result; driver history retains the closed state.
- PLATFORM approval summary does not grant a concrete store assignment; future dispatch must invoke the existing locked target-store eligibility boundary.
- No online/offline, live location, offers, assignment, route/ETA, delivery, documents, earnings, customer courier projection or realtime notifications.
- M14-D acceptance/security work is not started. No M15 implementation.

## Files materially changed

- packages/contracts/src/drivers.ts
- packages/api-client/src/auth.ts
- packages/api-client/src/drivers.ts (new)
- packages/api-client/src/index.ts
- packages/api-client/tests/drivers.test.ts (new)
- packages/ui/src/auth.tsx
- packages/ui/src/driver-resource.ts (new)
- packages/ui/src/drivers.tsx (new)
- packages/ui/src/drivers.css (new)
- packages/ui/package.json
- apps/driver/app/auth-client.ts
- apps/driver/app/page.tsx
- apps/driver/app/login/page.tsx
- apps/driver/app/register/page.tsx (new)
- apps/driver/app/globals.css
- apps/merchant/app/driver-client.ts (new)
- apps/merchant/app/merchant/drivers/page.tsx (new)
- apps/merchant/app/merchant/drivers/[id]/page.tsx (new)
- apps/merchant/app/merchant/shell.tsx
- apps/merchant/app/globals.css
- apps/admin/app/driver-client.ts (new)
- apps/admin/app/admin/drivers/page.tsx (new)
- apps/admin/app/admin/drivers/[id]/page.tsx (new)
- apps/admin/app/page.tsx
- apps/admin/app/globals.css
- apps/backend/src/modules/marketplace/driver-policy.ts
- apps/backend/src/modules/marketplace/driver-service.ts
- apps/backend/tests/driver-policy.test.ts
- apps/backend/src/scripts/verify-drivers.ts
- tests/browser/drivers.spec.ts (new)
- tests/browser/auth.spec.ts
- playwright.m14.config.ts (new)
- milestones/M14_C_IMPLEMENTATION.md (new)
