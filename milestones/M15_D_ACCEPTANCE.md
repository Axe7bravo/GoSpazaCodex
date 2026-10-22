# M15-D — acceptance, security and concurrency review

## Verdict and verification status

M15-A/B/C are complete and user-verified according to the M15-D request. This review found no confirmed CRITICAL, HIGH or MEDIUM vulnerability in the inspected M15 paths. No production behavior, schema, UI, permissions or native commerce code was changed in D.

Acceptance implementation is complete, but the new D tests have **not been executed by Codex or yet reported passing by the user**. M15 is ready for final commit/merge only after the commands below pass. Nothing has been committed or merged. M16 has not started.

The substantive coverage gap was the HYBRID phase-boundary race with an available platform candidate. Earlier C coverage raced expired acceptance with recovery, but its platform candidate was already occupied. D now checks actual platform offer creation, exclusivity and audit evidence, as well as the accepted merchant outcome. It retains all B/C assertions.

## Final architecture / ownership

- Medusa 2.18.0 remains Order, payment, inventory, Shipping Option/Method and native Fulfillment authority. The existing pinned-source reconnaissance identifies `createOrderFulfillmentWorkflow` as a commercial/inventory mutation, not driver assignment. No M15 call creates fulfillment or mutates native commerce.
- M10's successful durable completion receipt, completed CheckoutAttempt and exact native Order/cart linkage feed M11's OrderOperation. M11 acceptance and M12/M13 physical completion feed the single `dispatchReadiness` composition.
- DeliveryOperation is unique by both native Order and OrderOperation. Its immutable references bind merchant/store, picking, committed reservation and service zone. It contains operational facts, not copied Order totals or payments.
- DriverProfile and current affiliation remain M14-owned. ONLINE/OFFLINE is M15 intent; BUSY is derived from an OFFERED/ASSIGNED DispatchCommitment. One table owns both offer capacity and assignment capacity.
- Redis owns only expiring latest location and its generation/sequence fence. PostgreSQL owns commitments, generation progression, audit and due work.
- `dispatch_work` and the bounded repair cursor schedule observations. They never authorize a driver or release capacity. Picking events are acceleration hints; completed-picking evidence remains discoverable after event loss.
- Modes are platform-controlled per-store records. DISABLED/unconfigured fails closed. MERCHANT_ONLY and PLATFORM_ONLY never cross pools. HYBRID falls forward once after merchant exhaustion or its deadline. Empty pools exhaust rather than wait indefinitely for drivers to come online.

## Readiness evidence

`dispatch-readiness.ts` calls `PickingService.completedForDispatch`, which calls the existing `readOrderHandoff` and `readOperationalOrder` owners. The handoff requires SUCCEEDED/done terminal receipt, COMPLETED attempt, accepted payment evidence and native Order/cart identity. Picking requires ACCEPTED, COMPLETED with completion audit, unchanged native-line fingerprint and accounted quantities.

The dispatch layer additionally reads the exact COMMITTED reservation, active store/zone mapping, destination in zone, configured native Shipping Option in the expected shipping Fulfillment Set, and absence of existing native fulfillment. Product/variant relationships and marketplace profiles derive restricted-content presence. No browser value establishes any of these facts.

M13 `original_picked + terminal_resolved_omitted = ordered` is valid. M15 does not clear `financial_review_required` or issue/claim refunds, credits or repricing. The existing verifier checks omission evidence and unchanged native commerce.

ASAP has no additional scheduled gate. Scheduled dispatch uses slot start minus the centralized configured lead (default 30 minutes). Fresh database time is compared at start/offer/acceptance; policy tests cover immediately before, exactly at and after the boundary. Integration covers a future scheduled delivery producing no offers. Timing fixtures use database time and explicit persisted elapsed state, not sleeps or changed production clocks.

## Concurrency proof

### Structural boundary

Migration20261019000000 supplies:

1. `dispatch_one_driver_commitment`: unique driver ID WHERE status IN (OFFERED, ASSIGNED).
2. `dispatch_one_delivery_commitment`: unique delivery ID over the same states.
3. Unique `(delivery_id, generation, driver_profile_id)` retaining attempted candidates.
4. Immutable Order/store and offer identity fields, terminal offer decisions, immutable search configuration/deadlines and no PLATFORM-to-MERCHANT reversal.
5. Deferred delivery/commitment consistency: OFFERED has one unassigned commitment, ASSIGNED has one assigned commitment, SEARCHING/PENDING has none, attention may retain assigned capacity but no outstanding offer.
6. Deferred audit requirement and unique target/revision audit rows. Missing required audit causes the business transaction to roll back.

The C migration only permits generation-zero attention and adds due-work storage. These constraints remain intact.

### Actual lock order

Driver-bearing mutations use `DriverService.withEligibility`: sorted affected merchant rows → DriverProfile → current affiliation → driver availability → OrderOperation → PickSession → DeliveryOperation → commitment. Readiness takes the existing picking/zone/configuration locks within that scope. Observed affiliation/commitment changes conflict instead of acquiring a newly discovered merchant lock after a driver lock.

Worker paths without a driver begin with the target merchant, then OrderOperation/picking/delivery. They do not acquire a driver after locking the delivery. A path that closes a known offer selects its driver first and follows the driver-bearing order. Due-work locks precede the domain call; domain transactions never acquire due-work locks, so there is no reverse scheduler/domain dependency. Duplicate due workers use `FOR UPDATE SKIP LOCKED`.

Cross-store requests for a platform driver serialize on that DriverProfile; the active-driver unique index remains the final backstop. Same-delivery requests serialize on the merchant/delivery scope and active-delivery unique index. M14 suspension/revocation and M15 OFFLINE changes share the eligibility/availability boundary, so discovery is never a permission lease.

### Acceptance and HYBRID

Acceptance scopes the offer by authenticated DriverProfile before locking. It checks expected revision, OFFERED state, matching generation and current delivery state; reads fresh DB time; checks offer/search expiry; revalidates readiness, M14 evidence/revisions, affiliation/path, ONLINE generation, Redis freshness, platform zone admission and absence of another active commitment. It reads DB time again before the final write. Offer creation clamps expiry to both generation and merchant-phase deadlines.

If acceptance commits first while valid, the commitment and delivery become ASSIGNED in one audited transaction. Fallback cannot transition an ASSIGNED delivery and the worker preserves it. If the merchant deadline has elapsed, the clamped offer is expired: acceptance conflicts, expiry closes only that offer, and fallback can create a platform offer after the old active commitment is gone. There is never a legitimate intermediate committed state with both active paths.

D tests both sides using separate concurrent database operations. The expired fixture's offer expiry equals its merchant deadline; no sleep is needed to cross it. The post-deadline race includes HTTP acceptance and two due workers. A subsequent scheduled observation is exercised when a worker loses its optimistic observation, without retrying acceptance. The tests assert one current commitment, one fallback audit and no merchant assignment alongside the platform offer. The before-expiry case races two accepts, a worker and a fallback observation, requiring one assignment audit and zero fallback audits.

This is deterministic boundary-state testing, not exhaustive scheduling of every machine instruction. Existing B races separately cover two deliveries competing for one driver, accept/decline, suspension and OFFLINE. Constraints protect schedules not sampled by the tests.

## Security review: SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK

| Source | Transformation / boundary | Sink and assessment |
|---|---|---|
| Driver cookie and offer ID | Native DRIVER session → immutable M14 auth-identity/Profile binding → owned offer lookup and locked eligibility | Assignment/decline only for the offered driver. Foreign and unknown IDs return inaccessible; no caller-selected driver. |
| Merchant cookie and Order ID | M4 membership/capability via M11 detail → tenant/native Order authorization | Bounded delivery status and assigned-driver name/contact. OWNER/MANAGER read; PICKER denied. No coordinate or candidate history projection. |
| Customer cookie and Order ID | Authenticated customer → existing owned completed Order projection | Status only; no driver contact, coordinates, internal generation or candidate identities. |
| Dispatch configuration body/store ID | USER authentication plus native user existence → strict revision/mode/reason schema → merchant/config locks | Platform-controlled store mode with audit. A platform user is intentionally global; a different store ID is not itself a platform BOLA. Merchant/driver/customer identities cannot use this route. |
| Driver mutation JSON/query | Strict schemas, empty query, bounded driver request body | Cannot assign status, mode, path, candidate, expiry, generation, eligibility, timestamps, actor or restricted-content flags. Location's generation is a checked fence, not permission to choose identity. |
| GPS fields | Finite coordinate/range checks, server DB receive time, current generation, increasing sequence, Redis rate fence | Latest expiring sample only. Device position is not proof of physical presence. Replay/missing location fails closed for new offers/acceptance. |
| Picking event/due row | Resource-ID validation → same internal ensure/readiness/eligibility owner | Cannot manufacture an eligible Order or bypass capacity. No public dispatch trigger. |
| Browser decision / failed response | Client sends revision and explicit choice; shared resource lifecycle refetches, never replays writes | No UI authorization, local storage state, financial claim or automatic acceptance retry. |

**CRITICAL:** none identified. **HIGH:** none identified. **MEDIUM:** none identified. **LOW:** no confirmed defect requiring a production change. **INFORMATIONAL:** accepted limitations below.

No raw coordinates enter dispatch audit, workflow input or normal request logs. Location uses the direct service boundary specifically to avoid durable workflow payload capture. Error projection uses safe client messages; scheduler persists only a bounded error code. Identifiers are schema-validated/bound query parameters. No untrusted URL fetch, HTML injection or file access is introduced by these routes.

Availability changes have a database-backed rate bound; location writes have a Redis rate bound and an 8 KB request-body limit. This is not a claim of comprehensive DDoS protection. Edge quotas and large-pool query performance remain M25 work.

## Acceptance coverage matrix

All paths below are relative to the repository. B/C passing evidence is user-reported; D additions await execution.

| Invariant / risk | Executable evidence | Review limit |
|---|---|---|
| Authoritative creation, duplicate ensure, one Order/Delivery | `verify-dispatch.ts`: concurrent ensure; not-accepted rejection; native evidence snapshot | Reuses real M10 completed Orders, not mocked commerce |
| M13 omission/restricted fact | B `completed("one", true)`, financial-review rows, product profile flag | No M17 compliance claim |
| Scheduled/ASAP and exact boundary | `dispatch-policy.test.ts`; B future start rejection; C scheduled worker | Real DB future gate plus pure exact-time policy boundary |
| One driver / two deliveries | B concurrent `offer` calls, explicit active-driver index violation | Real independent transactions |
| One delivery / two drivers | D explicit `dispatch_one_delivery_commitment` violation; active-count assertions | No trigger/constraint disabling |
| HYBRID accept/fallback | D `phase-accept-wins`, `phase-fallback-wins` | Available platform driver; before and elapsed phase fixtures |
| Duplicate accept/decline | D simultaneous same-action calls and unique audit counts | Original receipt; no second effect |
| Opposite/expired/superseded decision | B/C expire races; D repeated accept/decline of expired merchant offer and accept after decline | HTTP checks plus immutable DB terminality |
| Pool isolation / geography | B merchant out-of-zone admission, foreign merchant exclusion, platform polygon rejection, exclusive mode tests | Source is M14 affiliation / ServiceZone, no distance |
| Suspension/revocation/OFFLINE | B discovery then revoke; suspension race; OFFLINE/accept race | Assignment winner remains occupied and attention is surfaced |
| Missing/stale Redis / replay | B injected absence, stale sample, deleted fixture sample/fence, old generation/sequence attacks | Only fixture-owned Redis keys affected |
| Duplicate workers / restart | C scoped duplicate `runBatch`, new orchestrator instance, expired persisted offers, SEARCHING/fallback progression, assigned resume | Does not kill a real OS process |
| Missed event / repair | Source review of completed-picking keyset cursor + idempotent ensure | Existing tests prove ensure/restart; no destructive worker-kill or shared scan manipulation added |
| Search horizon / attention | C expired generation creates no replacement; online does not restart; disabled readiness; assignment retained | Dependency outages may defer observation, never authorize or release |
| BOLA / actor separation | B/C real HTTP wrong driver, foreign merchant/customer, PICKER; D unknown IDs and foreign decline | Browser mocks are not counted as backend security proof |
| Mass assignment / mode authority | D hostile-field loop and cross-actor mode writes; B config/coordinate attacks; D stale config revision | Invalid fields rejected before mutation |
| Transactional audit | D omitted-audit transaction rejected and revision unchanged; single decision/fallback audit counts | No disabling constraints or broad cleanup |
| Native commerce unchanged | B baseline + D repeated comparison of native Orders, payments/captures/refunds, inventory reservations, fulfillment links | M15 has no native mutation call |
| M9 synchronization boundary | B policy update asserts PENDING, explicitly synchronizes; mode update deep-compares M9 configuration | No stale checkout retry/suppression |
| Driver UX | `tests/browser/dispatch.spec.ts`: online/location/offline, denial, explicit accept, duplicate-click guard, conflict readback, expired/foreign offer, platform offer, reload; D adds lost acceptance response after server assignment with no second write | Presentation mocks; server authority covered separately |
| Merchant/customer UX/privacy | Same browser suite: phase/status restoration, attention/unavailable state, no mutation controls/coordinates; C API allowlists | No live tracking or customer driver contact |
| Client authority/no replay | `packages/api-client/tests/dispatch.test.ts` | Outbound allowlists, safe errors, actor routes and no write retry |

## Worker, failure and recovery boundaries

Worker crashes before domain commit leave no business change. Crashes after domain commit but before due-row commit leave old scheduling metadata; the next pass reads durable domain state and cannot create a duplicate current commitment. Expired offers remain capacity-protecting rows until closed; acceptance checks expiry independently of worker timeliness.

Attention is terminal for M15 search. A subsequent ONLINE event does not restart it. For an assigned delivery with lost readiness/eligibility/configuration, the assignment stays ASSIGNED while Delivery enters attention; BUSY still follows the retained commitment. No financial or native inventory release occurs.

Infrastructure errors defer observation and store `OBSERVATION_DEFERRED`; they do not create a new search generation or make a driver eligible. Persistent infrastructure outages can delay processing indefinitely. Operational monitoring/recovery is required; the system must not release uncertain commitments merely to improve apparent liveness. M25 must add alerting/metrics and tune bounded repair throughput.

Logout does not erase persisted ONLINE intent or an assignment. With no new samples, freshness expires and prevents new admission. Session loss is not evidence of delivery cancellation.

## Accepted limitations / deferred work

- M25: device-GPS spoofing cannot be ruled out; no claim of trusted physical position. Latest sample only, no location history.
- M25: candidate offset pagination is a changing discovery view, not a stable fairness snapshot; commitment revalidation/uniqueness protects safety, but contention/churn can affect fairness. Large candidate pools, merchant-wide locking and nested worker/domain connection usage require load testing and pool sizing.
- M25: native privileged Admin cancellation/fulfillment operations do not share the GoSpaza dispatch transaction. Existing native readback detects changes, but it is not an atomic cross-module cancellation guarantee. Restrict privileged operations operationally; M16/M18 must define supported coordinated transitions before exposing them.
- M25: worker outages, malformed native data and Redis outages fail closed; readiness/repair latency and persistent-error alerts need production hardening. No real process-kill chaos test was performed in D.
- M23: controlled attention/re-dispatch tooling. No automatic generation restart.
- M16: pickup, native fulfillment integration, custody transitions and safe assignment release. M17: age/recipient compliance. M18: omitted-value/cancellation financial resolution. No M15 refund implication.

## Frozen M16 handoff

M16 may use the immutable Delivery ID and its native Order/OrderOperation/merchant/store binding, the single ASSIGNED DispatchCommitment, assigned DriverProfile, dispatch path, commitment and delivery revisions, assigned_at, and server-derived restricted-content flag.

An ASSIGNED commitment on an ATTENTION_REQUIRED delivery remains occupied but is **not permission to start pickup**. M16 must revalidate current operational eligibility and its own prerequisites. Expired offer timestamps do not expire an accepted assignment. Driver/session claims, Redis availability, browser state and Order metadata do not replace this handoff.

The flag is only a warning, not age approval or handoff authorization. M16 must use native supported fulfillment APIs at its approved integration point and preserve M13 physical omission evidence without silently changing commercial totals. Tracking, grocery OTP and delivered completion belong to M16, not this slice.

## Files changed in D

- `apps/backend/src/scripts/verify-dispatch.ts`: opt-in D checks, retaining B/C assertions and fixture-scoped cleanup; accurate suite failure label.
- `apps/backend/src/scripts/verify-dispatch-acceptance.ts`: D entry point composing B/C/D.
- `apps/backend/tests/dispatch-policy.test.ts`: exact phase/search expiry boundaries.
- `apps/backend/package.json`: `test:dispatch-acceptance` script.
- `tests/browser/dispatch.spec.ts`: lost-response readback and neutral operational-attention presentation.
- `milestones/MILESTONE_M15_DELIVERY_AUTOMATIC_DISPATCH.md`: D status/handoff reference.
- This acceptance document.

No production/schema/UI changes; no migration required for D.

## Commands for user to run

Working directory for every command: repository root. **Stop on any failure.** Do not claim D verified from earlier B/C runs.

### A. No dev servers — lint/typecheck/unit/build

Stop Next dev processes before typecheck/build to avoid concurrent generated `.next` writes.

1. `pnpm run lint` — zero warnings/errors.
2. `pnpm run typecheck` — all workspace checks pass.
3. `pnpm run test` — static/unit/policy/API-client suites pass.
4. `pnpm run build` — production builds pass.

### B. Backend / PostgreSQL / Redis

Use already-migrated M15-C database and current backend on port 9000. Keep `DISPATCH_WORKER_ENABLED` false/absent in both backend and verifier environments. Retain the safe local M10 test-payment configuration required by the existing real-Order harness. No Next apps needed.

1. `pnpm --filter @gospaza/backend run test:dispatch-acceptance` — all B/C assertions and the new D race/security checks pass. It already composes the B/C verifiers; rerunning those separately is unnecessary unless isolating a failure.

### C. M15 browser suite

1. `pnpm exec playwright test --config=playwright.m15.config.ts --workers=1` — all M15 browser cases pass. Playwright starts only customer/merchant/driver; browser backend fixtures are mocked.

### D. Full regression

Backend/DB/Redis only for the following commands, with fixture workers disabled as above:

1. `pnpm --filter @gospaza/backend run test:scheduling-foundation`
2. `pnpm --filter @gospaza/backend run test:delivery-reservations`
3. `pnpm --filter @gospaza/backend run test:checkout-foundation`
4. `pnpm --filter @gospaza/backend run test:payment-reconciliation`
5. `pnpm --filter @gospaza/backend run test:order-decisions`
6. `pnpm --filter @gospaza/backend run test:picking`
7. `pnpm --filter @gospaza/backend run test:shortages`
8. `pnpm --filter @gospaza/backend run test:drivers`

Expected: each verifier passes. Then `pnpm exec playwright test --workers=1` — full browser regression passes with Playwright's configured app stack. No sleeps, automatic test retries or global timeout changes were introduced in D.
