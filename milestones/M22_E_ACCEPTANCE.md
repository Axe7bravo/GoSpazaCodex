# M22-E — role UX and final acceptance

Implementation is ready for user verification. A–D are user-verified. **M22 remains open until the E checks and all three browser journeys pass.** No verification command was executed by Codex; no commit is authorized. Only source-directory creation was performed through PowerShell when the sandbox denied it.

## Implemented surfaces

| Actor | Entry / page | Data and behavior |
|---|---|---|
| Customer | Shopping/account navigation → `/notifications` | D's own IN_APP list, frozen title/body, local created time, Read/Unread, explicit authoritative mark-read, stored internal order link |
| Merchant | Existing portal navigation → `/merchant/notifications` | Same compact cards; backend selects individual members/roles. No tenant-wide payload/client finance filtering |
| Driver | Portal → `/driver/notifications` | Own notices including suspended history; native profile ID keys the component lifetime. Offer cards link to existing delivery work; no notification-based Accept |
| Platform | Admin home → `/admin/notifications` | D's separate operations + health projections. Queued/processing/retry/known failure/uncertain/suppressed/provider-accepted remain distinct; no rendered private messages or recovery mutations |

The shared components are DTO presentation primitives; role wrappers retain native authentication and established shells. Cards are mobile-friendly, with an explicit per-item unread marker rather than an invented global unread counter. Admin tables use the existing wide application layout and bounded pagination. Refresh/focus revalidation removes protected content on read failures. Older pages remain bounded and have a return-to-newest action. Failed mark-read never invents a timestamp; only the authoritative response replaces the item's DTO. Loading, empty, authorization/API error, mark uncertainty and missing-link states have bounded copy. Dynamic title/body are React text, never HTML. Customer/merchant/driver data contains no provider details; transport presentation is platform-only.

## Narrow client correction

Installed Medusa 2.18 `framework/dist/http/router.js` applies `ensurePublishableApiKeyMiddleware` to `/store`; that middleware requires `x-publishable-api-key` even on custom routes. D's generic notification client omitted it. E adds an optional customer publishable-key argument and uses it in the customer wrapper; no other actor receives that header. The public key grants no customer ownership. The client test now checks the header boundary. No backend retry, transport, mapping, financial or authorization policy changed. No DTO fields were added.

## Direct API proof, before browser acceptance

`verify-notification-surfaces.ts` uses real native auth, native session exchange, the actual HTTP middleware/routes and PostgreSQL. It covers:

- Customer/merchant/driver own list/detail, exact response allowlists, known foreign detail/mark denial and unchanged foreign read state, authoritative mark-read/replay.
- Same-store different recipient ownership and PICKER's operational-only list/no finance access.
- Real merchant team membership revocation; the same cookie loses inbox and destination access.
- Existing dispatch workflow rejects the exact terminal stale offer with HTTP 409, without assignment.
- Real driver suspension preserves historical notifications; separate native identity deletion denies customer/driver access. Framework-first 401 and fail-closed missing-identity 404 are the bounded allowed native-revocation outcomes; 5xx is not accepted.
- Explicit notification ops grant succeeds; native ordinary and finance-only users receive 403. Exact operation/health/worker DTO keys exclude message/contact/provider internals.
- The verifier restarts only its owned built backend with the API operator's ops grant removed, retaining the same cookie, database, Redis and session secrets. Native admin self-read must still return the identical user while ops returns 403. This proves actual HTTP revocation rather than changing a different process's environment and calling that live acceptance.

The verifier refuses an already-running backend on port 9000. It checks selected run/schema, pristine API notice state and fixture state before mutation. READY → RUNNING is persisted only after native sessions and selection are established; failure after that requires fresh API fixtures. VERIFIED is written only after the entire API proof succeeds. Browser actors/records are not consumed by API acceptance.

## Purpose-specific fixtures and one selection

The generator uses native Customer/User/Auth, existing merchant provisioning/team APIs and existing driver lifecycle APIs for synthetic actors. Native customer registration is explicit (`has_account=true` with native auth binding). Public domain guards remain untouched. A known foreign native Order exists solely to prove the original customer's scoped Order lookup denies notification-based navigation; it is not fabricated as a paid GoSpaza order.

Only notification B/C/D tables are created in a generated private schema. Their real constraints/guards and foundation primitives persist the UI input-contract fixtures. Provider acceptance uses a controlled in-process transport; missing destination and outside-horizon ambiguous attention are persisted through B. A private historical clock allows that proof without sleeps or changing public clock/constraints. No real Resend send or invented refund/credit outcome occurs.

Two private **terminal M15 read-contract fixtures** supply stale offers for negative admission. Their SQL checks allow only EXPIRED commitments and ATTENTION_REQUIRED delivery state; they cannot be assigned. The actual dispatch HTTP workflow must reject them with 409 before performing work. This is a targeted notification/navigation admission proof, not a new claim to re-prove C's offer provenance or all M15 dispatch races. Native driver/profile/affiliation, merchant identity and session sources remain real/public. No public dispatch, payment, refund, earnings or settlement records are synthesized or weakened.

| Record group | Use | Mutability / residual state |
|---|---|---|
| `apiCustomer` notice | API own/read/replay | Consumed by API mark-read |
| `foreignCustomer` notice | API/browser known-ID denial | Remains unread; never mutated by the attacker |
| Merchant owner/foreign/assigned picker notices | API recipient/role boundaries | Owner mark consumed; foreign unchanged |
| `revokedMerchant` MANAGER | API revocation + destination denial | Public membership becomes inactive; single-use actor |
| `driver` notice/terminal offer | API stale gate + suspension | Profile becomes suspended; history still readable |
| `revokedCustomer` / `revokedDriver` | API native identity removal | Dedicated identities removed; single-use |
| `customer` browser notice | Browser mark/refresh/link | Dedicated mutable mark-read fixture; preflight read_at must be null |
| `browserDriver` notice/terminal offer | Browser live navigation + suspension | Independent profile must begin ACTIVE; then becomes SUSPENDED |
| Operator/ordinary/finance-only users | Platform authority boundaries | Separate identities/sessions; no domain financial mutation |
| EMAIL accepted/suppressed/uncertain operations | Platform status/privacy | Immutable controlled evidence, read-only in browser |

Every generation writes a fresh UUID directory under ignored `test-results/m22/` with a manifest and separate credential seed file, then updates **one** `current.json` selection pointer. The manifest contains synthetic IDs/emails and a publishable key, not passwords. The seed file is never printed, sent to the frontend or stored in shell/global environment variables. Local file mode requests private access; Windows operators should retain the normal private workspace ACL. These are disposable test credentials, not production credentials.

Fixture generator, API verifier, backend launcher, Playwright config and browser tests use that same pointer (optional explicit `M22_ACCEPTANCE_SELECTION`). No separate secret/manifest shell variables are required. Native session passwords derive from the selected matching seed; mismatched run/credential files reject. The test-only scope is deployment-selected, guarded by test/test, `_test` and Redis /1; no request/header can choose it. A public test run header/marker checks backend/manifest alignment before mutation. With no flag, production behavior is unchanged. Native authentication and domain destination guards are never bypassed.

## Three browser journeys only

1. **Customer:** real session → frozen own notice/allowlist → Unread → authoritative mark response → Read after reload → known foreign notice denied → stored link navigates to the known foreign Order and its normal ownership denial. An HTML-looking frozen reference remains text, with no img/script element.
2. **Driver:** independent ACTIVE profile → own historical offer notice → existing delivery-work page reports no current offer → no Accept control; direct stale command receives 409 → real authorized suspension through a separate operator session → original driver cookie still reads historical notice.
3. **Platform:** authorized operations table shows provider acceptance, ambiguity and suppression distinctly; workers disabled; no private contact/provider key/body; ordinary native user then receives the bounded denied state and no retained table.

Each test gets a fresh Playwright context/page, no shared storage state or request interception. Response-oriented waits avoid binding to a superseded aborted request. Semantic locators are scoped and specific, including the named error alert (not Next's route announcer). No retries, artificial sleeps, browser timeout increase or generic button selection. Existing 180-second journey/15-second assertion limits are retained. Frontend servers use their normal Next dev command; built backend behavior is preserved. Known filesystem/HMR debt stays M25.

Consumed browser fixtures fail their own authoritative preflight. If customer mark-read or browser driver suspension succeeded, generate a fresh selection before rerunning that journey/full suite. A failed read-only ops journey can reuse its selection. Do not regenerate merely because an unchanged read-only assertion failed; diagnose its output first. Old backend processes must be stopped before switching selections.

## Static security review

SOURCE (D actor DTO / safe ops DTO / stored link) → TRANSFORMATION (literal React text, fixed bounded transport labels and internal path validation) → TRUST BOUNDARY (native session + frozen recipient + current backend membership/grant and original destination API) → SINK (own inbox/read timestamp / separate safe ops table / existing destination workflow).

Reviewed cross-customer/member/driver access, foreign mark-read, ops BFLA, current revocation, suspended-history access, stale dispatch action, route injection, XSS, provider/contact leakage and fixture credentials. Concrete issue found/fixed: missing required customer publishable header. No confirmed unresolved Critical/High/Medium finding was identified in static review. This is not a runtime security certification; API/browser results are still required. No generic send/reset/grant/test mutation HTTP endpoint exists. No new channel, kind, mapping, retry policy or M23 work was added.

## Commands for user to run

Repository root, PowerShell; **one at a time, stop on every failure**. Existing M22-D migrations must already be applied (user-verified). E requires no new production migration.

1. `pnpm run lint` — zero warnings/errors.
2. `pnpm run typecheck` — workspace checks pass.
3. `pnpm --filter @gospaza/ui exec tsx --test tests/notifications.test.ts` — focused frozen/read/empty/error/escaping/link/status presentation tests pass.
4. `pnpm --filter @gospaza/api-client exec tsx --test tests/notifications.test.ts` — route/key/header tests pass; no network.
5. `pnpm --filter @gospaza/backend run build` — built backend includes the E acceptance scope/scripts.
6. `pnpm --filter @gospaza/customer run build` — customer build succeeds.
7. `pnpm --filter @gospaza/merchant run build` — merchant build succeeds.
8. `pnpm --filter @gospaza/driver run build` — driver build succeeds.
9. `pnpm --filter @gospaza/admin run build` — admin build succeeds.
10. `pnpm --filter @gospaza/backend run test:notification-environment -- fixtures gospaza_m18_c2b_test` — fresh selection/credential files, real synthetic actors and private notice schema created; sanitized summary identifies the established database/Redis 1, no email.
11. **Stop any existing backend on port 9000 first.** `pnpm --filter @gospaza/backend run test:notification-environment -- verify-surfaces gospaza_m18_c2b_test` — verifier owns both built-backend phases, waits for actual readiness, proves API/privacy/revocation, stops only its own child and marks the manifest VERIFIED. Startup health polling is infrastructure readiness, not retrying business commands.
12. In **terminal A**, `pnpm --filter @gospaza/backend run acceptance:m22-server` — stays running; selected isolated built backend, notification workers/email disabled. Wait for backend readiness. No shell seed/database setup required.
13. In **terminal B**, `pnpm exec playwright test --config=playwright.m22.config.ts --workers=1` — exactly **3 passed**. Stop on failure; inspect output before rerunning or regenerating.

No broad M8–M21 or B/C/D verifier rerun is needed. The only D-adjacent production correction is the customer client's required header, covered by client + live E API/browser acceptance. No real Resend calls. No database create/drop, .env modification, medusa develop, commit or merge.

## Closure and material files

M22 is **ready for final user verification**, not yet closed. After all commands pass, review the API/browser outputs and close M22 only if no confirmed Critical/High/Medium security issue remains. Residual truthful limits remain those frozen by A–D: no globally exactly-once human email guarantee; outside-window ambiguity requires attention; notification read state is not business state. No production policy decision blocks E verification.

- Shared UI: `packages/ui/src/notifications.tsx`, `notification-presentation.ts`, `notifications.css`, UI package exports and `tests/notifications.test.ts`.
- Role pages: customer `/notifications`, merchant `/merchant/notifications`, driver `/driver/notifications`, admin `/admin/notifications`; existing navigation and four app global style imports.
- Customer API-client header support and its existing notification test.
- Backend fixture/surfaces scripts, `src/scripts/fixtures/notification-acceptance.ts`, test-only `notification-acceptance-scope.ts`/middleware and `scripts/m22-acceptance-server.ts`.
- Backend script registration/notification environment modes; `playwright.m22.config.ts`, `tests/acceptance/m22/notifications.spec.ts`.
- UX specification, M22 milestone status/handoff and this acceptance record.
