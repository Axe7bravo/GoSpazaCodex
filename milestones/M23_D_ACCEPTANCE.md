# M23-D — final acceptance and security record

**M23-D COMPLETE AND USER-VERIFIED; M23 CLOSED — 2026-11-07 (Africa/Johannesburg).** A/B/C were previously user-verified. The user confirmed all final commands below passed: lint, workspace typecheck, focused backend acceptance tests, admin operations tests, backend build, admin build, targeted M23-C rescue regression, final fixture generation, direct API acceptance and exactly three Playwright M23 journeys. Verification was executed by the user, not Codex. No commit or merge was performed. No M24 or M25 implementation was begun.

## Implementation and fixture boundary

One selected run lives under ignored `test-results/m23/<run>/{manifest,credentials}.json`; `current.json` contains only its bounded run ID. Passwords are HMAC-derived from the separate ignored credential seed and never logged. The selection fixes the existing `gospaza_m18_c2b_test`, Redis `/1`, test/test, native actors and distinct fixture groups. Conflicting explicit shell database selection fails. The shared isolated verifier safety policy is unchanged. No database is created/dropped and `.env` is not edited.

Native Medusa 2.18 User/Auth/Customer/Product/Cart/Order/Shipping/File modules and module links remain real. Merchant application provisioning and driver approval use their owner services. Native Order/Cart/graph readers are **not** substituted. Private upstream M10/M12/M13 source-contract inputs establish the already-verified committed handoff/picking prerequisite, rather than rerunning old payment journeys. They are not public paid receipts and do not create a Yoco payment, Store Credit, earning or settlement. This is M23 boundary acceptance, not new M10 financial proof.

The seven fixture groups have distinct Orders, Carts, Deliveries, drivers and request identities:

| Group | Use | Mutation / residual state |
| --- | --- | --- |
| read | API and browser overview/order reads | Immutable g1 stranded Delivery |
| apiRescue | Authorization, input integrity, replay and dispatch admission | One rescue; later normal offer/decline |
| apiRace | Two distinct HTTP rescue commands | Exactly one g2 transition |
| apiStale | Authoritative transition before stale POST | One g2; second request denied |
| apiRevoked | Rescue then same-session capability revocation | g2; replay denied after revocation |
| browserRescue | Browser journey 2 only | Single-use g1 → g2 |
| browserPrivacy | Browser journey 3 only | Read-only; unauthorized POST denied |

Private dispatch/rescue core tables copy installed checks, uniqueness and foreign keys; installed M16/M17-extended dispatch and C rescue functions and deferred triggers are retained. Upstream contract-input tables deliberately do not duplicate earlier owners' lifecycle verifiers. No public constraints or migration state are changed. Fixture records/schema persist for API/browser readback; no automatic destructive cleanup. Failed API acceptance leaves manifest RUNNING, requiring fresh fixture generation. Failed/consumed browser rescue also requires fresh generation followed by API acceptance; do not reuse a mutated manifest by editing its state.

`test:operations-final-environment` loads backend `.env` through the existing isolation helper, explicitly selects the established test database, disables recovery/dispatch/custody/notification workers and email transport, and selects local private synthetic document storage. It never starts `medusa develop`. The direct API verifier owns a **built** port-9000 backend, refuses an existing listener, checks the selected run marker, stops only its own child, restarts it with removed grants, and reuses the original native session cookies. Browser acceptance uses the same selected built-backend launcher in terminal A. Playwright owns only the admin Next frontend, fresh contexts per test, one worker, no retries/mocks, and response/state waits rather than sleeps. Startup readiness polling is infrastructure-only.

## Direct API coverage

The assertions below are executable in `verify-operations-acceptance.ts`; their direct API runtime acceptance was confirmed passing by the user on 2026-11-07.

| Boundary | Required assertion |
| --- | --- |
| Overview | Order-only, Delivery-only, combined, finance-only, notification-only and ordinary identities; exact source membership and independently gated navigation |
| Source access | Test-only per-request private-table query observations; unauthorized source tables/counts are not fetched; denied attention/lookup has no source reads |
| Legacy families | Native user without exact grant denied; granted merchant detail/private PDF/driver review/service zones/dispatch configuration still work; unauthorized lifecycle/config writes denied |
| Revocation | ORDER_OPERATIONS_VIEW, DELIVERY_OPERATIONS_VIEW, DELIVERY_RESCUE and MERCHANT_REVIEW_VIEW removed on owned restart; same cookies denied, unrelated grants still work; no reauthentication |
| GET purity | Before/after fingerprints of every private source/core/evidence table, owned public application/document/review records and real native Order state across overview/detail/attention/timeline/health/lookup and representative legacy GETs |
| Legacy side effects | Opt-in test-only AsyncLocalStorage probes reject OrderOperations.ensure, Dispatch.ensure/reconcile and Financial.ensure entered from operations GET, including no-op calls; probe count must remain zero |
| Order privacy | Exact nested allowlists; no Delivery or finance payload without separate grant; no customer email/contact, documents, provider/bank/OTP/compliance evidence |
| Delivery privacy | Exact safe diagnostic shape; only existing bounded commitment identity, state/timing, custody state and persisted precheck; no GPS/OTP/payment/earnings/private compliance observations |
| Attention | Per-capability source membership, bounded row/page keys and counts; finance/driver-payment/notification counts unavailable to order/delivery actors |
| Timeline | Independent authorization; order-only decision/picking entries; finance selection denied and financial event table never read; no event bodies/evidence/actors projected |
| Lookup | Known restricted payment and notification IDs denied before source query; unsupported DOCUMENT type rejected; direct known private document download requires exact separate grant |
| Health | Noninstrumented worker stays NOT_INSTRUMENTED with bounded pending/due/cursor sample; M22 heartbeat equals persisted fixture evidence; missing signal never becomes HEALTHY |
| Rescue authorization | Both grants required; each lone grant and ordinary/finance/notification actor denied; wrong actor families denied at native boundary |
| Rescue input | driver_id, generation, mode, capacity_override, status, commitment_state rejected before workflow/economic effects |
| Stale state | Load g1, successful authoritative rescue changes state, new request with stale token conflicts; no g3 |
| Exact replay | Same request returns identical authoritative result; one receipt/audit/generation |
| Changed replay | Same request plus changed expected revision returns stable HTTP RESCUE_STATE_CONFLICT, no new generation |
| Distinct-command race | Collect both settled HTTP outcomes: exactly 200 + 409 RESCUE_STATE_CONFLICT; one receipt, one SEARCH_REOPENED audit and g2 |
| Dispatch/capacity | Rescue leaves availability and commitment rows identical; old offer acceptance fails; offline candidate is rejected by normal DispatchService; normal online/location → offer → decline remains authoritative; rescue never assigns |

HTTP rescue deliberately exposes the existing bounded `RESCUE_STATE_CONFLICT`, not internal service distinctions. No arbitrary rejected race promise passes. C's user-verified sequential g2→g3 proof is preserved by its targeted regression, not reimplemented.

## Browser acceptance — exactly three journeys

1. Order operator: bounded attention-first overview, unauthorized financial tools absent, exact-ID lookup, real Order diagnostic navigation, verified handoff and no unauthorized Delivery/finance sections, contextual return navigation.
2. Rescue operator: dedicated stranded Delivery preflight, review g→g+1 / normal dispatch / no selected driver, real POST confirmation, authoritative refetch and refresh retain g2, old-generation driver acceptance denied. No manual driver input.
3. Delivery viewer: safe diagnostics, no rescue control, forged POST denied; ordinary user separately denied the operations page; sensitive fixture values absent.

The built browser server preflights both browser records before listening: expected g1/revision/ATTENTION_REQUIRED/POOL_EXHAUSTED, no active commitment and no receipt for the Delivery or manifest request identity. The browser rechecks authoritative state before mutating. API mutation fixtures never overlap these groups. Snapshot/video/trace capture is off to avoid credentials/private evidence in artifacts.

## Diagnostic cleanup and UI scope

C successful-run scenario/direct-offer/concurrent-offer dumps are removed. Success retains its concise summary. On failure, original safe error classification, scenario, Delivery/generation/status/revision, commitment/audit counts and active-capacity evidence remain bounded; diagnostic-read failure cannot replace the original failure. Assertions, fixture semantics and concurrency calls are preserved.

The only presentation adjustment makes the already-approved rescue review explicitly show numeric current and next generation. The matching presentation assertion is updated. No production dispatch/rescue function, admission predicate, actor authorization, database constraint, API/client DTO or mutation behavior changes.

## Static security review

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

* Native session → current native platform identity/current grants → per-source authorization before query and after read → allowlisted operations DTO. Direct wrong-actor, known restricted-ID, count and timeline tests protect BOLA/BFLA/privacy.
* Browser command → strict rescue parser → dual grants/current revision/generation/source readiness/ordered owner locks → one receipt + new generation + audit/work in the existing transaction. Injection, stale/replay/race and old-offer tests cover escalation/TOCTOU.
* Environment selector → exact test database/Redis/test/schema/run validation + DB marker → request-scoped private GoSpaza connection and test-only probes → real owner services/native modules. No request header/query/body selects schema or grants. Absent selector means no hook, query tracing header or probe behavior in ordinary runtime.
* Local pointer → bounded fixed directory/validated run and credential match → selected backend run response marker → API/browser assertions. Separate actors, drivers and single-use mutation groups prevent order dependence.
* Exact IDs → owner lookup type allowlist → current independent source capability → bounded fixed local admin link; arbitrary URLs/provider/document lookup are not supported. Response tests reject unsafe deep links and private sentinel values.

Critical: none identified by static inspection. High: none identified. Medium: none identified. The user confirmed final direct API security/privacy/purity/revocation acceptance and all three browser journeys passed on 2026-11-07. No confirmed unresolved Critical/High/Medium issue remains recorded for M23. This does not extend the tested scope to all historical domain paths or general performance; pg deprecation and Windows/HMR hardening remain M25 exclusions, with no M25 work begun.

Static operations route/client/UI mutation review found only the explicit Delivery rescue. Existing owner-console links do not confer owner authority; no generic resolve/repair/force/assignment/status/paid/refunded operation was added. The read-side text “no repair was performed” is explanatory, not a mutation API.

## Files materially changed

* Backend: `package.json`, `src/api/middlewares.ts`, `src/lib/operations-acceptance-scope.ts`, `scripts/m23-environment.ts`, `scripts/m23-acceptance-server.ts`, `scripts/m23-port.ts`.
* Verification: `src/scripts/verify-dispatch-rescue.ts` (failure-only diagnostic cleanup and database-timestamped controlled location fixture correction), `verify-operations-fixtures.ts`, `verify-operations-acceptance.ts`, `src/scripts/fixtures/operations-{acceptance,schema,allowlists}.ts`, `tests/operations-acceptance.test.ts`.
* UI/browser: `apps/admin/app/operations-presentation.tsx`, `apps/admin/tests/operations.test.ts`, root `playwright.m23.config.ts`, `tests/acceptance/m23/operations.spec.ts`.
* Records: this file and `MILESTONE_M23_OPERATIONS.md`.

## Commands for user to run

Working directory for every command: repository root. Run one at a time; **stop on the first failure**. Do not start a competing backend on 9000. Existing A/B/C migrations are already user-verified; D requires no new migration. Preserve existing environment credentials. No broad M8–M22 regression or dispatch-regression is requested.

1. `pnpm run lint` — zero warnings/errors.
2. `pnpm run typecheck` — all workspace typechecks pass.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/operations-acceptance.test.ts` — focused selector/DTO/privacy/health checks pass.
4. `pnpm --filter @gospaza/admin exec tsx --tsconfig tsconfig.test.json --test tests/operations.test.ts tests/operations-rescue.test.ts` — presentation and rescue refresh assertions pass.
5. `pnpm --filter @gospaza/backend run build` — builds updated test-only backend scope/routes.
6. `pnpm --filter @gospaza/admin run build` — admin build passes.
7. `pnpm --filter @gospaza/backend run test:operations-environment -- gospaza_m18_c2b_test rescue` — smallest C logging regression passes with concise success output. No dispatch-regression because production behavior is unchanged.
8. `pnpm --filter @gospaza/backend run test:operations-final-environment -- gospaza_m18_c2b_test fixtures` — native fixtures/private source schema and a new selected READY manifest are generated.
9. `pnpm --filter @gospaza/backend run test:operations-final-environment -- gospaza_m18_c2b_test api` — owned built backend runs direct HTTP acceptance/revocation, stops, and marks selected manifest VERIFIED.
10. Terminal A: `pnpm --filter @gospaza/backend run acceptance:m23-server` — refuses other listeners, verifies pristine browser records, starts selected built backend; leave running.
11. Terminal B: `pnpm exec playwright test --config=playwright.m23.config.ts --workers=1` — exactly three real-API journeys pass. Then stop terminal A with Ctrl+C.

Final verification status: every command above passed, as confirmed by the user on 2026-11-07; D and M23 are complete and verified. The sequence is retained unchanged for reference. For any future failure, return its bounded first leaf failure; do not edit migration tables, manifest state, grants or fixtures to force reuse. No next-milestone implementation is authorized.
