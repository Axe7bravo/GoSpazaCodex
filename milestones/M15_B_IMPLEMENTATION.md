# M15-B — dispatch domain implementation

Implementation prepared for user verification. No lint, typecheck, tests, migration, build or server command was executed by Codex. No M15-C worker/UI or commit is included.

## Authority and state

`DeliveryOperation` is operational only and has one immutable native Order/OrderOperation binding. `PickingService.completedForDispatch` reuses M10 terminal/native evidence and M12/M13 physical accounting. The readiness composition additionally checks accepted operation, completed picking, exact COMMITTED reservation, active store/zone mapping, destination containment, native shipping option/fulfillment-set relationship, absence of existing native fulfillment, configured dispatch mode and scheduled not-before time.

The stored delivery can be PENDING_DISPATCH before its scheduled gate opens or mode is configured. `start`, candidate admission and acceptance enforce the effective readiness gate. ASAP has no scheduled gate. Scheduled uses slot start minus configured lead. Slot-end lateness alone does not invent a cancellation policy.

M13 terminal omissions, including all-omitted accounting, are accepted when P+O=Q. Dispatch does not change `financial_review_required`, native quantities, totals, inventory, payments or refunds. Restricted presence is derived from native variant/product relationships and owned product profiles; only a boolean warning is projected.

State is PENDING_DISPATCH → SEARCHING → OFFERED → ASSIGNED, with durable ATTENTION_REQUIRED. SEARCHING has a separate MERCHANT/PLATFORM path rather than duplicate searching status fields. Decline/expiry/invalidation returns to SEARCHING unless the horizon or readiness ends. Attention does not restart automatically.

One `DispatchCommitment` progresses OFFERED → ASSIGNED; there is no second capacity system. PostgreSQL partial unique indexes cover OFFERED and ASSIGNED together for both driver and delivery. A delivery/generation/driver uniqueness constraint forbids repeat offers to historical candidates. Binding, immutable generation/deadlines, revision, terminal decisions, final delivery/commitment coherence and required audit receipts have database enforcement.

## Dynamic availability and privacy

PostgreSQL stores OFFLINE/ONLINE intent and generation. BUSY is derived from an occupied PostgreSQL commitment, even when offline, ineligible or Redis is unavailable. M14 policy remains the persistent eligibility owner. Changes to profile/affiliation revisions invalidate admission until explicit online revalidation.

Redis stores only the latest sample with a freshness TTL. A separate coordinate-free generation/sequence fence survives sample expiry. ONLINE creates a new generation; Redis restart/loss requires a new ONLINE generation before accepting samples. Old generations cannot repopulate a lost fence or poison a new sequence.

Location updates call the authenticated service directly, never the persistent workflow, so coordinates do not enter workflow input/history. They are absent from PostgreSQL models, audit payloads, customer/merchant projections and ordinary request logs. Timestamp authority is fresh database time; client timestamps/IDs are rejected. GPS remains device-supplied input, not proof of physical presence. Accuracy is bounded input, not a compliance assertion.

Redis setup and PostgreSQL intent cannot share a distributed transaction. A failed/uncertain generation setup fails closed: a fence mismatch cannot admit a driver and does not free an assignment; the driver can establish a new generation through the ordinary revision-controlled ONLINE command. No process-local recovery state is authoritative.

## Lock order and race boundary

The implementation preserves M14's existing order rather than introducing a conflicting delivery-first order:

1. Discover affiliation/target merchant IDs without treating that read as authorization.
2. Lock affected merchants in sorted ID order.
3. Lock DriverProfile and current affiliation; verify the observed affiliation has not changed.
4. Lock driver availability when a driver participates.
5. Lock OrderOperation, picking session and DeliveryOperation; read owner evidence under the same tenant transaction.
6. Lock current commitment, reread current state and database time, perform one transition and audit atomically.

Readiness takes shared locks on applicable zone/configuration/profile evidence. M14 suspension/revocation uses the same merchant/profile boundary. Two target merchants competing for one platform driver converge on its profile lock and the unique occupied-commitment index. No driver-held operation subsequently discovers/acquires another merchant lock; changed discovery returns conflict.

Acceptance rechecks M14, affiliation/path, intent/generation, location freshness/geography, current offer, readiness, revision and deadlines. Redis absence rejects acceptance but does not erase the offer. Expiry is persisted before returning its conflict. Same accepted/declined action replays its original decision; opposing or stale terminal actions conflict.

Assigned invalidation retains the commitment and surfaces ATTENTION_REQUIRED. There is no assignment-release/cancellation API in B. Native privileged Order cancellation is outside GoSpaza row locks: current native readback rejects known invalid state, but a concurrent privileged native write is not claimed to be serialized. M16 must revalidate before custody; cross-boundary operational coordination remains M25 work.

## Internal primitives and C boundary

Internal `ensure`, `start`, `candidatePage`, `candidate`, `offer`, `advance` and `reconcile` are available to the later orchestrator. No public candidate/dispatch endpoint, subscriber, timer or worker is installed.

Candidate pages are bounded and ranked by available_since then driver ID. C must establish bounded scan/exhaustion semantics and must not interpret one filtered page as the whole pool. `offer` always revalidates the selected driver. `advance(exhausted)` is trusted orchestration input, never browser authority. C owns real search scheduling, due-work repair, crash/restart orchestration and its tests.

MERCHANT requires exact active store affiliation and fresh location; PLATFORM also requires current point inside the order zone. HYBRID advances only merchant → platform. Default freshness/offer/merchant phase/search/lead are 120/30/120/300/1800 seconds, centrally configured and validated. Offers are clamped to both applicable phase and generation deadlines.

## APIs

| Actor | API | Authority |
|---|---|---|
| DRIVER | GET /driver/availability | M14 native identity → own profile |
| DRIVER | POST /driver/availability/online | Strict expected_revision; current M14 eligibility |
| DRIVER | POST /driver/availability/offline | Own intent; assigned commitment retained |
| DRIVER | PUT /driver/location | Own generation/sequence; no driver/tenant/mode/timestamp authority |
| DRIVER | GET /driver/dispatch/current | Own commitment; minimal status/warning, no coordinates |
| DRIVER | POST /driver/offers/:id/accept | Own current offer plus locked revalidation |
| DRIVER | POST /driver/offers/:id/decline | Own offer; deterministic terminal receipt |
| platform user | GET/PUT /admin/gospaza/stores/:id/dispatch-configuration | Existing native user boundary, strict mode/revision/reason |

No merchant/customer mutation or manual driver selection API was added. Existing origin/session/actor protections apply. Driver mutation bodies are limited to 8 KB, location updates are limited in Redis, and intent churn is bounded by durable audit evidence. Unknown extra fields are rejected before workflow invocation.

## Security trace

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Evidence |
|---|---|
| Driver session + offer ID → M14 profile binding → owned commitment and current locked eligibility → assignment | Foreign driver acceptance, actor confusion, forged identity, accept/decline race |
| GPS payload → shared coordinate validator + server time + sequence → own ONLINE generation → expiring Redis sample | Range/extra-field rejection, replay, stale sample, lost fence, new generation |
| Platform session + store → native user check + strict revision/mode → tenant-locked configuration → audit | Merchant/customer/PICKER denial and forged-field rejection |
| Native Order → M10/Picking owner contracts → accepted/completed/committed/readiness evidence → DeliveryOperation | Pending rejection, real completed Order, terminal omission, scheduled gate |
| Internal candidate → locked M14/store/zone evidence → unique current commitment → offer/assignment | Two deliveries/one driver; two drivers/one delivery; suspension/offline races |

No browser-provided driver, merchant, store, dispatch mode or order metadata becomes dispatch authority. The internal service's discovery IDs are not public authorization APIs.

## Coverage added

`apps/backend/tests/dispatch-policy.test.ts` covers defaults/configuration rejection, ASAP/scheduled gating, phase/horizon clamp, freshness boundary/future samples, exclusive pools, hostile schemas and omission accounting.

`apps/backend/src/scripts/verify-dispatch.ts` uses the existing real M10/M11 fixture chain, actual PostgreSQL and Redis, native auth sessions and HTTP routes. External Yoco transport remains substituted by the existing reconciliation fixture; native Order creation is real.

| Invariant | Verification |
|---|---|
| One delivery per authoritative Order | Concurrent ensure + unique count |
| One occupied commitment per driver | Two-delivery offer race + direct unique-index rejection |
| One current commitment per delivery | Two-driver offer race |
| Authoritative readiness | Pending operation rejection, real completed picking, scheduled future gate |
| Omission/restricted content | All-omitted completed picking, retained financial-review evidence, server-derived warning |
| Pool/geography | Foreign merchant denial, merchant outside polygon allowed, platform outside polygon denied, exclusive modes |
| HYBRID/horizon foundation | One-way fallback, exhaustion attention, no automatic restart; deadline clamp unit tests |
| Intent/location authority | HTTP actor/body checks, generation/sequence replay, stale/missing Redis sample/fence |
| Commitment decisions | Foreign offer denial, mass assignment, accept/decline race, exact replay, no reoffer |
| Current M14 state | Revocation between offer/accept, suspension after discovery, suspension-versus-accept race |
| Offline/Redis safety | Offline-versus-accept race, BUSY while assigned/offline, injected Redis absence retains assignment |
| Expiry | Valid historical expired-offer fixture, HTTP rejection and durable EXPIRED receipt, no sleeps |
| Configuration loss | Assigned delivery retains commitment/BUSY and enters attention |
| Native ownership | Native Order/items/shipping, inventory reservations, Payment/Capture/Refund and fulfillment readback unchanged |
| Privacy | Driver current DTO excludes coordinates/internal identity/financial fields |

These tests have not been run by Codex. Worker lifecycle/browser acceptance remains C/D, not a claim of B runtime verification.

## Files materially changed

- `milestones/MILESTONE_M15_DELIVERY_AUTOMATIC_DISPATCH.md`; this report.
- `packages/contracts/src/dispatch.ts`, `packages/contracts/src/index.ts`.
- `apps/backend/src/modules/marketplace/models/{dispatch-configuration,driver-availability,delivery-operation,dispatch-commitment,dispatch-event}.ts`.
- `apps/backend/src/modules/marketplace/migrations/Migration20261019000000.ts`.
- `apps/backend/src/modules/marketplace/{service,driver-service,dispatch-policy,dispatch-rows}.ts`.
- `apps/backend/src/lib/{picking-service,dispatch-service,dispatch-readiness,dispatch-location,dispatch-http}.ts`.
- `apps/backend/src/links/delivery-operation.ts`; `apps/backend/src/workflows/dispatch-command.ts`.
- Driver availability/online/offline/location/current/offer accept/decline routes and admin store dispatch-configuration route listed above.
- `apps/backend/src/api/middlewares.ts`, `apps/backend/medusa-config.ts`, `.env.example`, `apps/backend/package.json`.
- `apps/backend/tests/dispatch-policy.test.ts`, `apps/backend/src/scripts/verify-dispatch.ts`.

## Commands for user to run

All commands run from repository root. Stop on any failure and return the full underlying error. No Next apps/browser stack are needed for B.

### A. No dev servers

1. `pnpm --filter @gospaza/backend run lint` — no lint errors/warnings.
2. `pnpm run typecheck` — all workspace typechecks succeed; stop Next dev processes first to avoid concurrent generated `.next` writes.
3. `pnpm --filter @gospaza/backend run test` — backend policy/unit suites pass.
4. `pnpm --filter @gospaza/backend run build` — backend production build succeeds.

### B. PostgreSQL/Redis available; backend stopped for migration

5. `pnpm --filter @gospaza/backend run db:migrate` — migration and native read-only link synchronization complete successfully.

### C. Backend only, PostgreSQL and Redis running

Start the normal configured backend separately and wait for its ready message. Use the existing safe local M10 verification configuration; do not enable live Yoco. Keep the approved default dispatch timings for the integration fixture.

6. `pnpm --filter @gospaza/backend run test:drivers` — M14 identity/eligibility regression passes.
7. `pnpm --filter @gospaza/backend run test:dispatch` — prerequisite suites and M15-B pass, including real database/HTTP races and scoped cleanup.
8. `pnpm --filter @gospaza/backend run test:picking` — existing picking regression passes.
9. `pnpm --filter @gospaza/backend run test:shortages` — existing omission/shortage regression passes.

## Explicit exclusions and residual work

No automatic search worker, event trigger, UX, browser tests, customer/merchant location, distance/ETA ranking, batching, native fulfillment, pickup/tracking/OTP, age verification, refunds, earnings, realtime push or recovery UI. No commit.

M16 owns native fulfillment and commitment release; its integration must account for the current readiness guard against pre-existing fulfillment. M17 owns restricted handoff. M18 owns financial-review outcomes. M23 owns controlled rescue/redispatch. M25 owns GPS attestation, Redis availability/connection efficiency, cross-store platform-driver contention, durable fence retention, native Auth deletion and privileged cancellation coordination. None is represented as solved by this slice.
