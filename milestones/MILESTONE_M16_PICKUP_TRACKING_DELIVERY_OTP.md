# M16 — Pickup, Tracking & Delivery OTP

## M16-D implementation status — 2026-10-24

The user reports A/B/C complete and verified. D adds driver pickup/arrival/handoff UX, owned customer tracking/code UX and read-only merchant physical delivery presentation. Implementation/static review are complete; D runtime verification remains pending. The authoritative acceptance record, security traces, exact changed files and grouped user-run commands are in [M16_D_ACCEPTANCE.md](M16_D_ACCEPTANCE.md). Earlier slice status statements below are historical, not a replacement for this gate.

D adds bounded authenticated `GET /driver/deliveries/latest` for active/most-recent completed state restoration; it is not a public history or reassignment API. Customer tracking adds server-derived sample expiry; code reads add server-derived regeneration eligibility/cooldown and restricted prerequisite presentation. Shared owner projections keep unresolved/exhausted handoff fail-closed across driver, customer and merchant surfaces. No new schema, native side effect, capacity authority, compliance bypass or financial behavior is introduced. Browser state is display-only; mutations perform one write then authoritative readback. Sensitive customer state is cleared when hidden/unavailable/terminal.

M16 is ready for final commit/merge **only after** all D acceptance commands pass and blocking findings are resolved. No commands, commit or merge were executed by Codex. M17 is not implemented.

## Status, authority and scope

### Approved M16-B implementation policy

M16-A is approved. M16-B is authorized only: prepare native fulfillment before pickup from physically picked quantities, derive pickup readiness, let only the assigned authenticated driver confirm pickup, and commit IN_TRANSIT only after verified native shipment. No merchant co-sign, QR/barcode, tracking, arrival, OTP, handoff or delivered implementation in B.

Terminal omitted quantities are excluded from fulfillment; financial_review_required and native remaining reservations are preserved. An all-omitted manifest records NO_PHYSICAL_ITEMS_TO_DELIVER attention and retains assignment/capacity. Current M14 eligibility is required before preparation and pickup; loss blocks pickup without releasing/reassigning. Native create and shipment use stable operation identity, at-most-one dispatch, authoritative readback and fail-closed recovery, never blind replay. Native fulfillment is not physical pickup evidence.

Future C defaults are approved but not implemented in B: six digits, ten-minute expiry, five failed guesses/generation, fifteen/Delivery, three generations, sixty-second regeneration cooldown. Approved direction is server-secret keyed derivation using immutable Delivery identity and a high-entropy generation nonce/number/domain separator; no stored plaintext, no expiry/attempt reset on redisplay. Detailed cryptographic/security implementation remains C. This section supersedes the approval-pending wording retained in the original A report below.

Original M16-A reconnaissance and proposed durable contract, 2026-10-22. M15 is complete, user-verified, committed and merged according to the current user instruction; its older document status is not evidence to the contrary. The approved B policy above supersedes the original approval gate. Remaining C/D proposals do not authorize their implementation. Inspection was static against local source, not runtime verification.

### M16-B implementation record (pending user verification)

- `PickupService` is the operational owner. `dispatchReadiness` now accepts an explicitly verified fulfillment reference for the M16 handoff; its default M15 behavior still rejects existing fulfillments. The picking owner exposes physical P/O quantities without duplicating omission accounting.
- `pickup_operation` retains one immutable PREPARE and one SHIP operation per Delivery, stable workflow transaction identity, immutable native input/fingerprint, dispatch evidence and durable terminal receipt. PostgreSQL enforces identity, uniqueness, audit presence and occupied assignment. Native calls happen only from the caller that committed the designation. Subsequent callers inspect; they never run another native workflow.
- `delivery_operation.pickup_managed` hands reconciliation to M16 before native side effects. Native fulfillment identity and physical pickup timestamp are immutable when recorded. IN_TRANSIT is derived from `picked_up_at`; the existing M15 ASSIGNED commitment remains occupied rather than introducing a second driver-capacity status. Operational attention takes precedence in the DTO while retaining any physical pickup evidence.
- Preparation calls pinned `createOrderFulfillmentWorkflow`; pickup calls `createOrderShipmentWorkflow`. Validation reads the exact native Order/Fulfillment link, marker, location, shipping option/provider, original/component quantities, native fulfillment/shipment counters and remaining reservations. Stock adjustment remains exclusively native. A workflow `done` observation alone is insufficient; readback is mandatory.
- An observed `done` result is stored before final readback. A later fresh service instance can finalize from this durable observation and current authoritative native relationships. Missing/ambiguous execution history remains RECOVERY_REQUIRED with no replay or release. Stable transaction IDs are correlation, not an exactly-once native execution guarantee. Attention caused by invalidation never resumes automatically.
- `GET /driver/deliveries/current` and `POST /driver/deliveries/:id/pickup` use native DRIVER sessions, M14 binding and the current assigned commitment. The only mutation field is `expected_revision`. The API client exposes these methods; no UI was added. Driver DTOs contain no coordinates, workflow IDs, native fulfillment IDs or financial claims.
- Native Admin Order fulfillment/cancellation mutations and linked Fulfillment shipment/cancellation mutations cannot bypass the GoSpaza guard. Unlinked native fulfillment entities bearing a retained pickup-operation marker are also protected. Raw `/admin/fulfillments` creation is blocked because it accepts arbitrary line references and prepopulated shipment/delivery dates; internal native workflows remain usable. Admin guards require an authenticated platform-user session.
- `PICKUP_WORKER_ENABLED=true` intentionally enables the ten-second scheduler. Each pass handles at most 25 due rows and uses a sixty-second due interval. Work is durable, SKIP LOCKED and restart-safe. The default is disabled; disable in both backend and verifier during isolated tests. No public preparation/repair endpoint exists.
- Lock order remains sorted merchant(s) → DriverProfile/current affiliation → availability → OrderOperation → picking session → Delivery → commitment → pickup operations. Native calls occur after committed designation; post-call revalidation prevents publishing pickup when eligibility/readiness was lost. Assignment is retained even when native shipment finished during that invalidation window.

#### B coverage and security traces

All coverage below is implemented but **not executed by Codex**.

| Invariant | Coverage |
| --- | --- |
| P-only quantities; omissions and all-omitted attention | `pickup-policy.test.ts`; `verify-pickup.ts` partial 5/3/2 and all-omitted native fixtures |
| Native inventory changes exactly once; omitted reservations retained | Real native level/reservation reads before/after concurrent preparation and shipment; no mock inventory implementation |
| Wrong actor/driver/Delivery; forged fields; stale revision | Hostile HTTP calls in `verify-pickup.ts`; strict schema unit tests |
| Native relationship ownership and stale assignment | Wrong-Order readback rejected; commitment reassignment rejected by PostgreSQL; native route bypass calls |
| Duplicate/concurrent preparation/pickup | Concurrent service preparation plus simultaneous HTTP confirmations; one operation/link/shipment/audit assertions |
| Preparation/shipment readback outage | Real native writes with injected readback failure, followed by a fresh service instance using the persisted `done` observation |
| Lost response/history ambiguity | Real native writes followed by injected lost response and unavailable execution observation; repeated calls do not dispatch again or publish pickup |
| Suspension/revocation/invalidation | Suspended before prep/pickup; merchant affiliation revoked before pickup; controlled suspension between native shipment return and operational finalization |
| Restricted presence and capacity | Server-derived restricted flag survives pickup; assignment remains occupied, including OFFLINE and attention paths |
| Client authority and uncertainty | API-client test submits only revision to driver domain and performs no automatic retry |

Security trace: DRIVER session → M14 profile → current PostgreSQL assigned commitment → locked native preparation/shipment operation. Delivery IDs select candidates only; they never grant authority. Revision is a stale-write token, not identity. Native quantities originate in the picking owner's authoritative completion evidence. The external/native boundary receives only the immutable server-resolved manifest. Native response → durable lifecycle observation → exact native readback → guarded operational receipt; uncertainty cannot cross that boundary as success.

The verifier composes the existing M15 and M10/M11 fixture lifecycles through a bounded callback. It explicitly re-enables its fixture dispatch configuration after the M15 verifier's intentional disablement. Existing prerequisite assertions remain. Teardown checks exact fixture Order and operation markers, uses supported native module/link APIs, and deletes only those synthetic fulfillments. Shipped fixture teardown resets `shipped_at` through the native update API solely to satisfy pinned cancel-before-delete requirements; this is never a production recovery path. No SQL writes target Medusa-owned commerce tables.

Residual limitation: a native write followed by process loss before durable terminal observation may remain indefinitely RECOVERY_REQUIRED. B intentionally provides no manual recovery, cancellation, inventory rollback, refund or capacity-release command. Full OS-kill recovery and multi-process scheduling stress remain acceptance/hardening work; fault-boundary integration coverage does not claim to simulate every crash location.

#### B material file inventory

- `apps/backend/.env.example`, `apps/backend/package.json`
- `apps/backend/src/modules/marketplace/pickup-policy.ts`
- `apps/backend/src/modules/marketplace/models/pickup-operation.ts`
- `apps/backend/src/modules/marketplace/models/delivery-operation.ts`
- `apps/backend/src/modules/marketplace/dispatch-rows.ts`
- `apps/backend/src/modules/marketplace/service.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261022000000.ts`
- `apps/backend/src/lib/picking-service.ts`
- `apps/backend/src/lib/dispatch-readiness.ts`, `apps/backend/src/lib/dispatch-service.ts`
- `apps/backend/src/lib/pickup-native.ts`, `apps/backend/src/lib/pickup-service.ts`, `apps/backend/src/lib/pickup-http.ts`
- `apps/backend/src/links/delivery-fulfillment.ts`
- `apps/backend/src/workflows/pickup.ts`, `apps/backend/src/jobs/pickup.ts`
- `apps/backend/src/api/middlewares.ts`
- `apps/backend/src/api/driver/deliveries/current/route.ts`
- `apps/backend/src/api/driver/deliveries/[id]/pickup/route.ts`
- `apps/backend/src/scripts/verify-dispatch.ts`, `apps/backend/src/scripts/verify-pickup.ts`
- `apps/backend/tests/pickup-policy.test.ts`
- `packages/contracts/src/pickup.ts`, `packages/contracts/src/index.ts`
- `packages/api-client/src/dispatch.ts`, `packages/api-client/tests/dispatch.test.ts`
- This milestone contract.

#### B user-run verification order

All commands run at repository root; stop on any failure. No commands below were executed by Codex.

**A — no dev servers:** stop Next dev processes before typecheck/build to avoid concurrent `.next` generation. Run `pnpm run lint` (zero warnings), then `pnpm run typecheck` (no diagnostics), `pnpm --filter @gospaza/backend run test` (all unit/policy tests pass), `pnpm --filter @gospaza/api-client run test` (all client tests pass), and `pnpm --filter @gospaza/backend run build` (successful backend build).

**B — PostgreSQL/Redis, backend stopped:** `pnpm --filter @gospaza/backend run db:migrate` must apply the new schema successfully.

**C — backend only, PostgreSQL/Redis:** retain the already verified local M10 test-only Yoco configuration and `APP_ENV=development`; no live credentials. In both backend and verifier environments set `PAYMENT_RECONCILIATION_WORKER_ENABLED=false`, `DISPATCH_WORKER_ENABLED=false`, `PICKUP_WORKER_ENABLED=false`. Start only the backend with `pnpm --filter @gospaza/backend run dev`; wait for port 9000 ready. In another terminal run `pnpm --filter @gospaza/backend run test:pickup`. Expected: all prerequisite assertions plus the final M16-B pass line. It composes M15-B and the existing real checkout/Order fixture verification, not a mocked Order/stock fixture. Then `pnpm --filter @gospaza/backend run test:dispatch-acceptance` preserves the M15 orchestration/security boundary after the readiness handoff change.

**D — browser regression (no new B UI):** stop manually running Next apps and let the existing config manage only its required app stack. `pnpm exec playwright test --config=playwright.m15.config.ts --workers=1` must pass. Full browser acceptance belongs to M16-D; B adds no new UI journey. No prerequisite suite has been removed or weakened.

Goal: extend the existing assigned Delivery through physical pickup, transit, arrival and secure grocery handoff, using native Medusa fulfillment. Do not introduce another Order, inventory, payment, shipping-price or driver-capacity authority. No M17 compliance implementation, M18 cancellation/refunds, M21 earnings, M22 push, M23 recovery UI, routing service, batching or durable GPS history.

## 1. Source evidence and repository findings

Installed backend dependencies pin Medusa to 2.18.0 (`apps/backend/package.json`). Pinned source roots inspected:

- CF: `node_modules/.pnpm/@medusajs+core-flows@2.18.0_6818f4adc6c9c57dc8e4f7d26a6cf835/node_modules/@medusajs/core-flows/dist`.
- F: `node_modules/.pnpm/@medusajs+fulfillment@2.18._bbdbb9afb7f6d43a5b3f42fdc5f153d6/node_modules/@medusajs/fulfillment/dist`; package.json confirms 2.18.0.
- O: `node_modules/.pnpm/@medusajs+order@2.18.0_@med_ef14fc98ef791e3e0cecfdcc8d6bcce2/node_modules/@medusajs/order/dist`.
- SDK: `node_modules/.pnpm/@medusajs+workflows-sdk@2.1_b31906113b3e8ea9aa1ff781d2b34b0e/node_modules/@medusajs/workflows-sdk/dist`.
- Engine: `node_modules/.pnpm/@medusajs+workflow-engine-r_ed45de22fcd9189288d3d0e3772f5fa4/node_modules/@medusajs/workflow-engine-redis/dist`.
- Orchestration: `node_modules/.pnpm/@medusajs+orchestration@2.1_0367a79445e2b0cc76309cc9960b35f0/node_modules/@medusajs/orchestration/dist`.

| Existing owner / inspected source | M16 implication |
| --- | --- |
| `lib/scheduling-native.ts`, `dispatch-readiness.ts` | M9 already links the installed manual provider to the Stock Location and uses native shipping profiles/options/zones. Resolve these existing relationships; do not create parallel shipping configuration. Delivery-slot capacity is distinct from driver capacity. |
| `modules/marketplace/order-operation-repository.ts`, `lib/completion-native.ts`, `order-operation-native.ts` | M10 successful terminal receipt, completed attempt, committed reservation, exact Order/cart/customer relationship and native Order are the authority. Reuse this handoff; do not rerun payment reconciliation or derive payment from browser IDs. |
| `lib/picking-service.ts:load/completedForDispatch`, revised M13 contract section 19 | ACCEPTED OrderOperation, completed picking/audit and native line fingerprint are checked together. Per line, P + terminal O = Q. The current handoff does not expose the physical manifest; extend the picking owner's contract rather than reading/reimplementing its accounting elsewhere. |
| `modules/marketplace/driver-service.ts:withEligibility` | Sorted merchant locks precede DriverProfile/current affiliation locks and current M14 eligibility. Assignment history is not a current permission lease. |
| `lib/dispatch-service.ts`, `dispatch-rows.ts`, migrations `Migration20261019000000.ts`, `Migration20261020000000.ts` | PostgreSQL commitment is capacity authority. ASSIGNED is currently immutable, Delivery ASSIGNED can only remain or become ATTENTION_REQUIRED. M16 needs explicit audited forward transitions and corresponding constraint changes, not trigger removal. |
| `lib/dispatch-readiness.ts`, `DispatchService.reconcile/current` | Existing readiness rejects ANY native fulfillment. Reconcile calls it for assigned deliveries. M16 must provide an explicit lifecycle handoff before creating fulfillment; otherwise normal M16 work would become ASSIGNMENT_REVIEW. |
| `lib/dispatch-location.ts`, `DispatchService.location` | Latest Redis sample has availability generation, increasing sequence, server receipt time and TTL. Current location admission is tied to M14/ONLINE availability evidence; it is not yet an assignment-scoped tracking API. |
| `lib/dispatch-orchestrator.ts`, jobs/subscribers/workflows | Durable bounded due work, authoritative rereads and event acceleration are established patterns. No event-only completion chain. |
| `lib/dispatch-projection.ts`, `packages/contracts/src/dispatch.ts`, `packages/api-client/src/dispatch.ts` | Customer/merchant ownership is checked through OrderOperationsService before projection. Current customer projection contains no GPS. Extend actor-specific DTOs, not ORM serialization. |
| `apps/driver/app/dispatch-panel.tsx`, merchant order-detail and customer order-view | Existing refresh, mutation-busy, bounded polling and stale-result protection can be reused. Driver currently manually shares location; no continuous tracking exists. |
| `api/middlewares.ts`, `lib/auth-rate-limit.ts`, `request-logging.ts` | Auth-specific Redis throttling exists; it is not generic OTP throttling. Request logger allowlists method/status/duration and excludes bodies/query/secrets. New secret routes need their own bounded limits and no-store responses. |

## 2. Pinned native fulfillment findings

### Create

`CF/order/workflows/create-fulfillment.js`, workflow `create-order-fulfillment`:

1. Queries native Order/items/variants/shipping relationship and reservations for supplied original line IDs. Rejects canceled Orders, missing lines, invalid shipping grouping and empty items.
2. Resolves native shipping option/provider/location; validates shipping profile. Creates fulfillment items, converting original line quantity into inventory-component quantity with native MathBN and required_quantity.
3. Calls nested `createFulfillmentWorkflow`; sets packed_at. F module creates the native entity, calls the provider, updates provider data/labels; on a caught provider failure it deletes the just-created entity. A process death is not equivalent to that caught failure.
4. For selected managed items requires reservations, rejects quantity beyond reserved stock, subtracts picked quantities from stocked inventory and reduces or soft-deletes consumed reservations.
5. Registers native Order fulfillment quantities, creates Order–Fulfillment link, updates/deletes reservations and emits `order.fulfillment_created` in a parallel group. Inventory/reservation update events follow; a hook runs afterward.

This is several module mutations, not one Marketplace SQL transaction. Inventory adjustment uses native inventory-item locking; reservation steps lock separately. M16 must not reinterpret this as a transaction-coupled global inventory boundary or patch the previously rejected M13 inventory architecture.

Compensations inspected: fulfillment-create step calls native cancel; inventory step applies inverse adjustments; deleted reservations are restored; Order registration uses `revertLastVersion`. Compensations can themselves be interrupted. Native side effect before StepResponse/checkpoint remains ambiguous after process loss.

### Shipment

`CF/order/workflows/create-shipment.js`, `create-order-shipment`: queries Order and linked fulfillment, checks canceled Order/line membership/fulfillment relationship, then runs native shipment update and Order shipment registration in parallel. Emits `shipment.created` after that group.

Nested `fulfillment/workflows/create-shipment.js` validates no shipped_at, no canceled_at and a shipping option, then sets shipped_at. An already-shipped fulfillment is an error, not an idempotent replay receipt. Native Order registration creates/confirms SHIP_ITEM actions (`O/services/actions/register-shipment.js`). No stock/reservation mutation is invoked by this workflow. Order registration compensation reverts last version; fulfillment update compensation restores prior selected values, with a source TODO that newly created relationships are not fully reverted.

### Delivered

`CF/order/workflows/mark-order-fulfillment-as-delivered.js`, `mark-order-fulfillment-as-delivered-workflow`: validates the Order/fulfillment relationship, derives delivered original-line quantities from fulfillment components, acquires an Order lock, invokes nested native delivered update, releases the Order lock, THEN registers native Order delivery quantities and emits `delivery.created`.

Nested `fulfillment/workflows/mark-fulfillment-as-delivered.js` takes a fulfillment lock (timeout 2s, TTL 10s), rejects canceled/already-delivered state, writes delivered_at. It does NOT require shipped_at. The outer Order query also does not select status although its validation calls the canceled-Order helper. GoSpaza must explicitly load/check current Order status and shipment prerequisites; do not infer sufficient validation from a function name.

`O/services/actions/register-delivery.js` creates/confirms DELIVER_ITEM actions. Native delivered_at and Order delivered quantities are separate writes. No inventory adjustment is invoked here. A delivered timestamp alone is insufficient proof that the whole workflow succeeded; replay is rejected and may duplicate Order effects if bypassed manually.

### Cancel (inspection only; not an M16 command)

`CF/order/workflows/cancel-order-fulfillment.js`, `cancel-order-fulfillment`: rejects canceled Order, canceled fulfillment and shipped fulfillment. Adds fulfilled stock back, recreates/increases reservations, registers Order cancellation and emits `order.fulfillment_canceled`; native provider cancellation is last because its step has no compensation. This is not a refund. The F module's cancel method skips repeat provider cancellation once canceled_at exists, but that does not make the entire Order cancellation workflow replay-safe.

No M16 cancellation endpoint, automatic native cancel, inventory release or financial action is authorized. Interrupted compensation is operational recovery, not permission to retry or refund.

### Native models, persistence and recovery

`F/models/fulfillment.js` owns packed_at/shipped_at/delivered_at/canceled_at, native provider/option/address/items. `O/models/order-item.js` owns versioned fulfilled/shipped/delivered quantities. GoSpaza does not independently write these columns or maintain a competing quantity ledger.

SDK `helper/workflow-export.js` accepts stable identity as `.run({ input, context: { transactionId } })`; engine `services/workflow-orchestrator.js` accepts transactionId in engine run options and forwards it. They are different call shapes. Stable identity is correlation, not evidence of business-effect idempotency.

Orchestration `transaction/transaction-orchestrator.js` enables forced synchronous checkpoints for explicitly stored/async/retry/timeout steps; these native mutation definitions do not establish an atomic checkpoint with their commerce write. Engine storage `utils/workflow-orchestrator-storage.js` persists execution state separately and can delete finished root history when no retentionTime is configured. Do not assume M10's retention configuration applies to these workflows.

Design conclusion: use at-most-one GoSpaza dispatch per operation, stable identity, native readback and durable receipts. Missing history after dispatch is ambiguous. A wrapper cannot close the native write/checkpoint gap. Do not build a Medusa compatibility extension or blindly resume/replay interrupted native mutation steps.

## 3. Ownership and smallest state model

Extend the existing Delivery aggregate, not a second operational delivery table. Keep search history and assigned identity immutable. Separate courier phase from native-operation recovery state so attention does not erase known physical facts.

Proposed courier phase: ASSIGNED → IN_TRANSIT → ARRIVED → DELIVERED. Existing pre-assignment M15 states remain. PICKUP_READY is a derived predicate. Physical pickup confirmation is an immutable action timestamp/receipt; PICKED_UP is not another independently editable status. During shipment uncertainty show pickup reported / confirmation pending, not verified IN_TRANSIT. HANDOFF_PENDING is a projection of ARRIVED plus OTP/native-operation state, not another generic status setter.

Native operation state: PREPARED → DISPATCHED → SUCCEEDED, or RECOVERY_REQUIRED. A proven terminal native failure is retained with evidence and remains operationally blocked; it does not automatically authorize another run. These receipts coordinate native mutations; they are not a fulfillment store.

Minimal additional persistence (future B/C migrations, none created in A):

- Delivery courier phase/revision, current fulfillment reference, physical pickup/arrival timestamps, attention reason; no commercial totals or copied address authority.
- Per-delivery native operation records unique by delivery + action (CREATE_FULFILLMENT, SHIP, DELIVER): immutable input/fingerprint, workflow/transaction identity, dispatch claim, native correlation/reference, observed execution/run/step state, terminal validated receipt. Retain evidence after workflow history expiry.
- One current handoff generation/verifier per Delivery, expiry, counts, key version, consumed receipt and bounded generation history; no plaintext code.
- Existing commitment gains a narrowly constrained ASSIGNED → COMPLETED transition, allowed only with matching terminal delivery evidence in the same SQL transaction. Active uniqueness remains OFFERED/ASSIGNED; no second capacity mechanism.
- Extend existing delivery audit conventions for courier/handoff transitions; OTP guesses never appear in audit.

M16-B must update M15 worker/read reconciliation to recognize the claimed courier lifecycle BEFORE native create. Pre-handoff dispatch rules remain unchanged. A recognized M16 operation permits only its exact native fulfillment; unrelated fulfillment or missing/ambiguous evidence still fails closed. M15 worker must never restart search or release courier-owned capacity.

## 4. Physical manifest and omission boundary

Expose one picking-owner handoff returning native original line IDs, Q/P/O, terminal omission references, completion audit/fingerprint and financial_review_required. Freeze its fingerprint for native fulfillment. Do not reuse ordered Q as physically fulfilled quantity.

For each line fulfill only P > 0. Example Q=5, P=3, O=2: send original line quantity 3; native workflow reduces stock/reservation by 3, retains reservation for 2, and native fulfilled/shipped/delivered counters reach 3, not 5. Retain financial_review_required=true. Native commercial Order may remain partially fulfilled despite completed operational delivery; UI must explain omitted goods and unresolved financial adjustment. No write-off, price adjustment, replacement SKU or refund is fabricated.

All P=0 is a genuine policy edge: M12/M13 may complete and M15 may assign, but native create rejects an empty manifest. Proposed outcome: NO_PHYSICAL_ITEMS attention, no native fulfillment/pickup/OTP, retain existing commitment until explicit safe operational recovery. Do not revoke M15 omission admission or manufacture zero-item shipment. Approval required; future cancellation/financial resolution is M18, release/reassignment recovery is later operations scope.

## 5. Pickup readiness and native integration sequence

One reusable pickup predicate, composed through existing owners, must prove:

1. Current authenticated DriverProfile owns the exact ASSIGNED commitment; Delivery has no blocking attention/recovery and immutable Order/store relationships match.
2. M10 terminal successful handoff and current native uncanceled Order/cart/customer/shipping relationship remain valid; M11 ACCEPTED; exact M9 COMMITTED reservation. Do not expire a committed reservation just because the scheduled window has passed.
3. M12 COMPLETED and audited physical manifest; every Q=P+O with no unresolved shortage, compatible original native line fingerprint and at least one P>0.
4. Current merchant/store validity and M14 eligibility/affiliation revalidated under locks. Proposed policy: suspension/revocation before pickup blocks pickup, preserves commitment and records attention. It does not silently redispatch.
5. Expected existing Stock Location/provider/shipping profile/option relationship and compatible native reservations/items. Before create there must be no conflicting fulfillment. After create there must be exactly the designated validated fulfillment, unshipped and uncanceled.

ONLINE intent, GPS freshness and distance are NOT new pickup authority. OFFLINE must not orphan an assignment. Driver authentication and current eligibility are still required. Current M15 configuration changes already causing attention cannot be bypassed by M16.

Proposed sequence:

- Bounded due work after assignment evaluates readiness, claims CREATE_FULFILLMENT and uses `createOrderFulfillmentWorkflow` for the frozen picked manifest. GET readiness never silently creates commerce state. Readiness can show preparing while native creation is unresolved.
- After validated create receipt, show Pickup ready. Only assigned driver explicitly confirms physical pickup; no merchant acknowledgement, QR or barcode in MVP (proposal requiring approval).
- Persist pickup intent/evidence and SHIP dispatch guard, then call `createOrderShipmentWorkflow` with server-derived Order/fulfillment and exact items. Publish IN_TRANSIT only after terminal native success plus relationship/quantity readback.
- Driver explicitly marks arrival; GPS does not infer arrival. ARRIVED enables the handoff process but proves neither delivery nor legal identity.
- Valid grocery OTP authorizes one guarded native DELIVER operation. Only validated terminal native delivery permits operational DELIVERED and capacity release.

Native packing occurs at preparation, not physical pickup; shipment represents pickup departure. No driver may select native fulfillment, quantity, provider, stock location or shipping option.

## 6. Locking, dispatch guards and recovery

Preserve actual M15 order: sorted affected merchant rows → DriverProfile → current affiliation → availability if needed → OrderOperation → PickSession/physical lines in deterministic order → Delivery → current commitment → native-operation row → handoff row. Extend existing owner callbacks; never acquire a merchant/profile lock after a Delivery lock. Candidate-free customer OTP operations resolve immutable assignment first and acquire the same prefix before revalidation. Scheduler rows use the existing scheduler→domain ordering; domain transactions never acquire scheduler rows in reverse.

Fresh database time after locks governs expiry. Unique constraints and conditional revision writes serialize duplicate pickup, two devices, issue/regenerate/verify races and completion. No SQL transaction is held across the native workflow call: persist/commit a DISPATCHED claim before invocation, then release locks. All competing GoSpaza operations observe that durable claim and refuse another dispatch. Later native readback/finalization reacquires locks in the same order. This avoids pretending native module transactions join Marketplace or holding cross-module locks indefinitely.

For each native operation:

| Observed state | Action |
| --- | --- |
| PREPARED, provably not dispatched | One worker may atomically claim and dispatch. |
| Exact run returns terminal success | Validate native identity, Order link, items/components, quantities and appropriate timestamps/Order change evidence; persist SUCCEEDED receipt. |
| Exact persisted execution done | Same readback/finalization, no new native run. |
| Invoking/waiting/compensating, missing history after dispatch, conflicting references or unproven write | RECOVERY_REQUIRED; preserve physical facts/commitment, no replay, cancellation or refund. |
| Reverted/failed | Inspect actual commerce/compensation result; no automatic success, retry, capacity release or refund. |
| Durable GoSpaza terminal receipt exists | Exact replay returns original safe result, independent of native history retention. |

Readback must include native Order fulfillment/shipment/delivery quantities and reference-bearing change evidence, not timestamps alone. Save baseline/native version and immutable expected manifest before dispatch. Do not use aggregate inventory-level equality as proof of this operation: unrelated sales may change it. If per-operation evidence cannot establish required stock/reservation effect, remain recovery-required.

Crash examples: fulfillment created before link/stock checkpoint; stock adjusted before reservation write; shipped_at updated before Order registration; delivered_at updated before Order DELIVER_ITEM; OTP consumed before native completion; native done before local receipt. Each is covered by the same operation identity and observation path. A crash just after dispatch claim but before actual invocation is conservatively ambiguous too. No second run to resolve it.

No exactly-once native execution claim. Guarantee: at-most-one GoSpaza dispatch per designated operation + one accepted terminal outcome + fail-closed ambiguity. Native privileged Admin writes are outside GoSpaza locks; M16 must block direct native fulfillment mutations for GoSpaza Orders through application middleware (including generic fulfillment routes resolved to Order), while trusted supported service/workflow calls remain possible. This does not claim protection against database administrators or arbitrary privileged internal scripts.

## 7. Tracking and privacy

Reuse the latest-location Redis owner/validation, but distinguish assignment-scoped tracking from ONLINE candidacy. An assigned driver may be OFFLINE for new work and still submit delivery tracking. Do not weaken M15 candidate freshness/eligibility rules to achieve this.

Add a delivery/commitment-bound tracking generation and increasing sequence to the same location infrastructure, with separate purpose/key namespace from general dispatch location. This is one location owner with purpose-scoped samples, not a second GPS authority. It prevents customer reads accidentally exposing a driver's later assignment or an unrelated ONLINE sample. Reset requires explicit authenticated server generation establishment; Redis loss fails tracking closed and never frees capacity.

Proposed defaults: foreground update at most once per 15 seconds, server cap 60/minute, freshness/TTL 120 seconds; bounded customer poll every 15 seconds for 10 minutes, then explicit refresh/focus continuation. Stop watch/poll on hidden/unmounted/logged-out/terminal state; mobile browser background tracking is not guaranteed. No GPS persistence in localStorage/sessionStorage/PostgreSQL, analytics or ordinary logs. Browser geolocation is untrusted device evidence, not proof of physical position.

Customer coordinates only for authenticated owning Order while courier phase IN_TRANSIT or ARRIVED, current commitment still matches, no blocking attention, sample generation matches, and sample remains fresh. No pre-pickup, foreign, post-delivery or historic coordinates. Return freshness/unavailable state instead of stale coordinates; no fabricated ETA or route. Merchant receives operational status only, no coordinates. Driver sees own tracking health; platform access remains minimum necessary, no history UI in M16.

Read authority both before and after Redis fetch if lifecycle may have changed; linearize projection with current locked/revalidated state. Terminal SQL state immediately revokes future location reads even if Redis deletion fails. Best-effort compare-generation deletion plus TTL removes old samples without deleting a newer assignment's sample. A response already authorized/in flight cannot be remotely erased from a recipient; do not claim otherwise.

Stale/missing GPS does not block grocery OTP handoff. Tracking quality is separate from handoff authentication. Redis outage must not reset PostgreSQL OTP counters or capacity.

## 8. OTP design and policies requiring approval

OTP proves possession of a delivery secret, not legal identity. The customer may share it with a trusted grocery recipient. Only assigned authenticated driver submits it; no customer account-holder-presence claim.

Proposed defaults (central server policy, not yet approved): six decimal digits; 10-minute generation lifetime; maximum five failed guesses per generation and fifteen per Delivery lifetime; maximum three issued generations total; regeneration cooldown 60 seconds. Lifetime budgets never reset via regeneration, ONLINE changes, sessions or Redis loss. Exhaustion is durable handoff attention with commitment retained; no generic reset endpoint. Expiry alone allows bounded customer-requested regeneration. These conservative limits trade recovery convenience for bounded guessing probability (at most 15/1,000,000 blind guesses across proposed budgets, assuming uniform secrets; social engineering is separate).

Issue only after explicit ARRIVED and unrestricted/compliance-eligible handoff. Customer explicitly requests/reveals through authenticated owned-order page; no SMS/push dependency. Refresh reveals the same unexpired generation without extending expiry; it must not regenerate automatically.

Storage alternatives:

- Random code + hash + one-time plaintext reveal minimizes recoverability but lost responses/reloads force regeneration; unsuitable for durable repeated presentation without extra complexity.
- Random code + encrypted ciphertext supports re-display but introduces recoverable per-delivery secrets and encryption lifecycle.
- Recommended: cryptographic derivation from a dedicated versioned server secret, random per-generation nonce and canonical delivery/commitment/generation/expiry context; store a separately domain-separated keyed verifier, nonce, key version and expiry, never plaintext. Deterministic recomputation permits authenticated re-display without expiry renewal. Use HMAC-SHA-256 with unbiased decimal extraction/rejection sampling, not ad hoc modulo/truncated timestamps. This is keyed derivation, not an unkeyed hash of a six-digit secret.

The deriving key makes code recovery possible for authorized server code; do not describe it as irreversible storage. Database-only leakage must not enable offline million-code enumeration. Keep keys out of database/client/logs, validate dedicated cryptographically random production configuration, retain required key versions only while generations are live and fail closed on missing key. Use a distinct verifier context/key derivation, constant-time fixed-length comparison and numeric-string validation. Never reuse Yoco/session secrets. Key compromise is a deployment incident, not solved by short-code hashing.

Regeneration locks Delivery/handoff, invalidates prior generation atomically, increments generation, preserves lifetime attempt count and audits. Never issue another generation once verification/completion is pending or delivered. Prevent accidental equality with prior retained-generation codes during the bounded generation window so a superseded visible code cannot pass as the next code by chance.

Verify under locks: correct actor/current assignment and courier state; no recovery; current unrestricted/compliance prerequisite; current generation; fresh DB expiry; attempt budget; constant-time code check. Wrong valid-format guess commits counters/audit BEFORE returning failure (do not throw inside a transaction and roll back the counter). Foreign-driver/foreign-resource guesses reveal no existence and cannot consume the victim's budget. Malformed payloads fail strict validation and request throttling. Never echo submitted digits.

Success consumes the generation and records a single immutable verification authorization plus DELIVER operation claim in the same PostgreSQL transaction. Do not send plaintext through a persisted workflow input: verify in the domain transaction, then workflow receives only the authorization/operation reference. Duplicate request after consumption returns authorized receipt/current completion state, not a second verification/native run. Raw code is absent from error logs, audit, workflow checkpoints, URL and browser storage. Secret response is no-store/private and is cleared from UI on expiry, logout, regeneration and completion.

Implement dedicated issue/reveal/verify endpoint throttles in C, plus PostgreSQL authoritative counters. Existing auth throttling does not cover these endpoints. Redis throttling can be supplementary; missing Redis must not open unlimited guesses. Broader ingress/DDoS hardening remains M25, not an excuse to defer OTP limits.

## 9. Delivery completion and driver capacity

After OTP authorization, dispatch native `markOrderFulfillmentAsDeliveredWorkflow` once. On validated native terminal result, atomically persist local receipt, courier DELIVERED, consumed handoff evidence, commitment COMPLETED, and audit. Only this transaction removes the driver from the active-capacity partial index. Replays return the original result. Do not physically delete commitment history.

Do not release driver capacity at pickup, arrival, OTP issue, incorrect code, expiry, accepted OTP with uncertain native result, suspension, Redis loss or native cancellation evidence alone. Existing commitment remains ASSIGNED during every nonterminal/recovery state. M9 reservation remains COMMITTED historical scheduled capacity; M16 does not reinterpret driver release as M9 cancellation/reopening or native inventory release.

Local delivery completion means the actual picked manifest was handed over with native fulfillment recorded. It does not mean omitted items were delivered or financial_review_required resolved. No M18 or earnings side effect is emitted as a financial fact.

## 10. Restricted-content prerequisite and invalidation

Server-derived restricted_content_present is retained; at handoff revalidate authoritative evidence and never downgrade a true restriction from browser/current mutable labels alone. Define a single owning handoff-prerequisite policy: unrestricted satisfies inherently; restricted requires future M17 evidence bound to Delivery, current commitment and handoff generation. In M16 no such approval is manufactured, so restricted final OTP completion is blocked. Pickup/transit/arrival remain possible. UI states verification not yet available, never age verified.

M17 receives immutable Delivery/Order/store/assigned-driver/native-fulfillment references, physical phase/arrival, handoff generation/revision and restricted flag. It supplies recipient eligibility/evidence (including permitted alternate adult) through that prerequisite, not a browser boolean. Failed restricted handoff remains undelivered and capacity retained pending M17 return policy; no partial grocery handoff.

Before pickup: invalid assignment/eligibility/Order/store/readiness blocks pickup and records bounded attention. After pickup: suspension/revocation/cancellation or incompatible native state preserves commitment/physical history, blocks further ordinary completion and surfaces attention; no automatic release, financial cancellation or invented return path. Revalidate at final completion. Later resolution needs explicitly authorized operations policy, not M16 administrator status editing.

## 11. Proposed API/RBAC and UX boundaries

Routes are proposed repo-conventional additions; existing delivery reads should be extended rather than duplicated.

| Actor | Minimum capability / routes | Allowed projection |
| --- | --- | --- |
| DRIVER | Own `/driver/deliveries/current`; POST `/:id/pickup`, `/:id/arrive`, `/:id/handoff/verify`; PUT `/:id/location` and explicit tracking-generation establishment | Own assignment, native-derived pickup/destination needed for this delivery, phase/readiness, restricted warning, expiry/remaining-attempt guidance; NEVER valid OTP, provider/workflow secrets or other driver location. |
| CUSTOMER | Owned `/store/gospaza/orders/:id/delivery`; GET `/tracking`; POST `/handoff-code` reveal/issue and `/handoff-code/regenerate` | Own active tracking only after pickup; own eligible code; neutral completion/attention and unchanged omission-financial notice. |
| MERCHANT | Existing OWNER/MANAGER owned order-delivery read | Pickup readiness/phase/delivered/attention only, existing bounded assigned-driver projection; no GPS/OTP/private compliance. PICKER gets no new capability implicitly. |
| SYSTEM | Bounded due observation/preparation/recovery | No public candidate, fulfillment or delivered mutation endpoint. |

Strict commands accept only action-specific revision/idempotency context and OTP or validated location fields. Driver/customer/merchant/store/fulfillment IDs, quantities, timestamps, delivered=true, compliance=true and capacity state are never mass-assigned. Known Delivery/Order IDs are selectors, not authorization. Foreign and unknown resources have indistinguishable unavailable responses. Platform native fulfillment routes must not bypass GoSpaza-owned Order safeguards.

Driver UI: assigned/not ready → pickup ready → explicit pickup → confirmation pending or transit → explicit arrived → enter code → authoritative completion. Disable duplicate submissions and refetch after uncertainty; no blind mutation replay. Customer/merchant UI derives state from backend, no optimistic delivered claim. Use bounded focus/poll/manual refresh and real URL plus destination-state browser synchronization. No external map/routing dependency; coordinates/freshness presentation can be minimal. No browser-local correctness requirement.

## 12. Audit, security traces and acceptance requirements

Reuse append-oriented delivery audit. Record actor, scoped Delivery/commitment, prior/resulting phase, revision, DB timestamp and bounded reason/operation reference for readiness-established, native-create receipt, pickup report, shipment receipt, arrival, issue/regenerate, failed-attempt count, successful verification, native-delivery receipt, completed capacity release and attention/recovery. Never raw OTP, high-frequency coordinates, full provider/workflow payload or unnecessary customer PII. No repeated no-op polling audit.

These are design threats/tests, not claims of discovered production vulnerabilities:

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Required proof |
| --- | --- |
| Delivery ID → authenticated M14 binding + current commitment → own pickup/arrival | Foreign known IDs, stale assignment, revoked/suspended actor, two devices, duplicate pickup; no foreign existence leak. |
| Order ID → authenticated native customer/OrderOperation ownership → lifecycle/sample-generation gate → tracking/code | Cross-customer and merchant BOLA, no pre-pickup/post-delivery coordinates, no OTP in driver/merchant responses, no cached secret response. |
| Location → strict ranges/generation/sequence + server receipt time → assigned tracking owner → Redis | Replay, wrong generation, new assignment, Redis restart, out-of-range/NaN, freshness; no claim GPS proves arrival. |
| OTP input → strict schema + current handoff/actor + DB counters + keyed comparison → consumed authorization | Distributed guessing, counter persistence on failure, max attempts, expiry boundary, regen-vs-verify race, old-code replay, wrong-driver budget attack, no logs/checkpoints containing code. |
| Restricted flag/evidence → authoritative prerequisite → final native delivery | OTP alone cannot complete restricted Order; forged compliance/state rejected. |
| Pickup/verify requests → unique guarded operation + fixed manifest → native workflow | Lost response, duplicate workers, post-write/pre-checkpoint crash, missing history, terminal success/local crash, compensation ambiguity; no second fulfillment/shipment/delivery run. |
| Native terminal receipt → exact readback + current locked state → SQL delivery/commitment/audit | No timestamp-only completion, no double capacity release, rollback leaves occupied capacity, duplicate replay same receipt. |
| Native Admin fulfillment/cancel/ship/deliver route → GoSpaza-owned relationship gate → native mutation | Direct bypass denied including generic native fulfillment routes and hostile known IDs; trusted workflow path stays functional. |

Real-database/native integration coverage must include all-picked and partial-omission manifests; missing/excess/wrong-location reservation; unchanged commercial totals and retained omitted reservation; zero-picked attention; native quantity/readback mismatch; driver/cancellation races; M15 worker concurrent with fulfillment creation; assignment single-capacity through transit/recovery; successful completion releases exactly once. Source review does not substitute for these tests.

Clock-controlled tests: pickup/arrival replay, OTP just-before/at expiry, tracking freshness, generation invalidation and stale reads. Browser tests: reload during native pending, code reveal without expiry extension, tracking unavailable but valid grocery handoff, restricted completion blocked, no secret/GPS leakage, foreign actors, offline assigned driver, expired/exhausted/regenerated code, delivered refresh. Preserve M9–M15 suites.

## 13. Slice boundaries and approval gates

Keep the requested four slices; no hidden extra milestone:

- **M16-A:** this reconnaissance/contract only. No production, migration, UI or runtime tests.
- **M16-B:** native fulfillment preparation and pickup/shipment domain, exact physical manifest owner handoff, readiness/RBAC, guarded native operations/readback, migration constraints and M15 lifecycle reconciliation handoff; focused real-DB/native race/failure tests. No tracking disclosure/OTP/UI.
- **M16-C:** assignment-scoped tracking, arrival/handoff prerequisite, OTP issue/reveal/regeneration/verification, native delivered reconciliation and atomic driver-capacity completion; focused security/concurrency tests. No M17 approval implementation.
- **M16-D:** driver/customer/merchant UX, API-client contracts and final acceptance/security/regression; preserve all earlier gates and browser synchronization conventions.

Before B, approve: (1) create native fulfillment at validated preparation, driver-only pickup acknowledgement; (2) fulfill only picked quantities and retain omitted native reservations/financial review; (3) zero-picked manifest goes to attention with no fabricated fulfillment/release; (4) M14 invalidation blocks pickup/further handoff with commitment retained; (5) at-most-one native dispatch and fail-closed recovery, including claim-before-call crash gap. These choices are recommendations, not silently approved policy.

Before C, approve OTP defaults/derivation and key management, explicit ARRIVED issuance threshold, assignment-scoped tracking/freshness/privacy and no M16 restricted final completion. A later policy amendment must not weaken the irreversible commercial/ownership/capacity invariants.

M16-B is technically feasible using supported native workflows and bounded GoSpaza operation evidence, without direct commerce-table writes or a Medusa patch. It is **not yet authorized to start** until A/policy gates are approved. Native quantity/readback behavior and failure injection must be proven during B before claiming runtime safety; if the proof fails, stop at that gate rather than inventing native table repair.

## 14. Verification status and later handoffs

Only this document was created. No production files, schema, migrations or tests changed. No verification commands, dev servers, migrations, commits or merges were run. PowerShell file inspection used the previously authorized repository-access workaround. No test commands are needed for this documentation-only slice; user review/approval is the next gate. Future slice reports must use scripts actually present at implementation time, grouped by no-dev-server, backend/DB/Redis and browser environments, not invented script names.

M17 owns compliance, alternate-adult recipient eligibility and restricted failed-handoff/return semantics. M18 owns omitted-item and failed-delivery financial resolution, cancellation/refunds/store credit. M21 may consume a durable delivery-completed event/receipt for its own idempotent earnings rules; M16 creates no earnings. M23 owns explicit operational recovery UI. M25 owns broad ingress controls, performance/retention tuning and privileged out-of-band operational hardening; OTP limits and native ambiguity safeguards are required now, not deferred.

## 15. M16-C approved implementation contract — 2026-10-24

The user approved A/B and the C policies below. This section supersedes the earlier proposed C defaults and API spellings. C implements domain/API/client contracts only. M16-D UI and M17 compliance remain excluded. Implementation is subject to user-run verification; no runtime pass is claimed.

### Operational ownership and terminality

M15 `ASSIGNED` remains the occupied dispatch state through transit/arrival. Verified `picked_up_at` and `arrived_at` derive the physical phase without adding a second persisted phase state machine. Final `DELIVERED` plus `delivered_at` and commitment `COMPLETED` are atomic. The existing dispatch DTO retains its M15 `status` interpretation and adds `delivery_phase`; new handoff/tracking DTOs expose the physical phase directly. D must render that phase rather than infer physical delivery from dispatch status.

Arrival requires the current assigned driver, current M14 eligibility/affiliation, successful immutable PREPARE/SHIP receipts, and exact native shipment readback. An arrival replay cannot issue a new generation. The shared M16-B transaction prefix remains merchant locks → driver/affiliation → availability → OrderOperation → picking → Delivery → commitment, followed by handoff generation and completion operation. Redis is never a capacity or OTP authority.

### Tracking and privacy

The existing `PUT /driver/location` accepts the strict `purpose: DELIVERY` variant. `POST /driver/deliveries/:id/tracking` establishes an assignment-scoped generation; it does not accept coordinates. The existing Redis location owner is reused under a tracking purpose namespace keyed by immutable commitment, with sequence fences, its existing 60/minute sample limit and configured M15 freshness (120 seconds by default). ONLINE intent is not required for an occupied delivery's tracking. GPS remains untrusted device input.

`GET /store/gospaza/orders/:id/tracking` first proves native customer/Order ownership, then linearizes lifecycle and sample access under the shared transaction locks. Only current eligible transit/arrival exposes latitude, longitude, server recorded time and freshness. Missing/stale Redis data returns null tracking. Terminal SQL state revokes coordinate disclosure even if best-effort sample deletion fails. No coordinates enter PostgreSQL, audit, workflow inputs, merchant DTOs or other driver responses. Old Redis metadata fences are non-location data; operational retention tuning remains M25.

### Handoff generations and secrets

Central policy: six digits, ten-minute lifetime, five failures per generation, fifteen per Delivery, at most three generations, sixty-second regeneration cooldown. ARRIVED ensures generation one. Restricted deliveries may arrive and display a code, but `handoffCompliance` returns REQUIRED and verification stops before comparing or counting a guess. No M17 evidence is manufactured.

`HANDOFF_OTP_SECRET` is a dedicated random 32-byte key encoded as 64 hexadecimal characters, distinct from JWT/cookie/Yoco/webhook secrets. Startup rejects absent/insecure configuration in staging/production; any configured development value is validated too. Development arrival fails closed without a key. HMAC-SHA-256 over a versioned canonical Delivery/nonce/generation tuple uses rejection sampling to derive six digits. Comparison is constant-time for validated fixed-length input. PostgreSQL stores nonce, key fingerprint, generation, expiry, bounded counts and lifecycle only, never plaintext code. A changed key fingerprint fails closed for existing generations; automatic key rotation/re-keying is not implemented.

Customer GET reconstructs the same active code without changing generation/expiry/count/cooldown. Regeneration is explicit, owned-customer-only, revision checked and serialized; previous generations are invalidated and accidental repeat codes are rejected during derivation. Expiry alone burns no attempts. Exhaustion never releases capacity. A separate PostgreSQL per-delivery/endpoint throttle limits retrieval and unconsumed verification to sixty requests per minute; lifetime failure budgets survive Redis loss. Responses are private/no-store and strict schemas reject authority fields.

### At-most-one native delivered dispatch

Correct OTP consumption and a unique `delivery_completion` claim commit together before any external workflow call. The claim references the immutable SHIP input/fulfillment, commitment and consumed generation, with fixed workflow and transaction identities. Only the process that created that claim may call pinned Medusa 2.18.0 `markOrderFulfillmentAsDeliveredWorkflow`. Repeated requests/read/worker recovery only observe; they never invoke a second native run.

Pinned source marks native fulfillment delivered before registering delivered Order quantities. Therefore timestamp existence alone is insufficient. A retained native done result or exact terminal workflow observation plus strict native readback must prove the same fulfillment, Order link, physical manifest/components, fulfilled/shipped/delivered quantities and retained omitted reservations. Unknown/history-missing outcomes retain consumed authorization and occupied capacity in RECOVERY_REQUIRED. There is no compensation/replay/manual delivered endpoint. A dispatch-claim-before-call crash is intentionally ambiguous.

After proof, one SQL transaction records the terminal native receipt, sets commitment COMPLETED, marks Delivery DELIVERED with timestamp and writes bounded proof/completion audits. Deferred constraints require matching consumed generation, successful shipment, fulfillment receipt, no active commitment and completion audit. Terminal records are immutable. M9 reservation and native commercial/payment/inventory ownership are unchanged. No financial resolution or earnings is implied.

`HANDOFF_WORKER_ENABLED=false` by default. Explicitly enabled scheduled processing reads at most 25 due operations per pass and rechecks unresolved operations after sixty seconds. Driver read/duplicate submission uses the same observation path. Earlier pickup/dispatch observation delegates after handoff claim, and delivered dispatch scheduling becomes terminal. No process-memory recovery or timing sleep is used.

### API surface

- DRIVER POST `/driver/deliveries/:id/arrive`: current revision only.
- DRIVER GET `/driver/deliveries/:id/handoff`: bounded physical/completion state.
- DRIVER POST `/driver/deliveries/:id/handoff/verify`: candidate code and current revision only.
- DRIVER POST `/driver/deliveries/:id/tracking`: current revision; existing location PUT carries samples.
- CUSTOMER GET `/store/gospaza/orders/:id/tracking` and `/handoff-code`.
- CUSTOMER POST `/store/gospaza/orders/:id/handoff-code/regenerate`: current revision only.
- Existing merchant/customer order-delivery reads expose bounded `delivery_phase`; no merchant GPS/OTP.

All identity comes from existing actor boundaries and native/M14 ownership. Native fulfillment bypass protection from B remains in force. Client mutation helpers issue one request only; uncertainty requires explicit authoritative readback. No public native-delivered command is exposed.

### Static security review and executable coverage

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

- Delivery/Order selector → strict ID + authenticated DriverProfile/current commitment or native customer ownership → locked authoritative state → arrival, code or tracking projection.
- OTP candidate → strict six digits/revision → current assignment/compliance/DB expiry and budgets → keyed comparison, atomic consumption and unique operation. Candidate is absent from audit/log/workflow input.
- GPS → strict numeric ranges/purpose/generation/sequence → current occupied delivery and Redis fence → latest scoped sample only; no GPS-based arrival authority.
- Native observation → exact designated transaction and complete commerce readback → guarded local terminal transaction → one capacity release; ambiguity never authorizes replay.

No confirmed critical/high/medium vulnerability identified by this static review. Runtime security/concurrency proof remains pending. Operational limitations are deliberate fail-closed native ambiguity, browser-supplied GPS authenticity, dedicated-key lifecycle and later M23/M25 recovery/retention tooling.

Added policy tests cover derivation, strict input, dedicated-secret validation and restricted prerequisite. API-client tests cover 409/503/network-loss no-retry behavior. `test:handoff` composes every existing pickup prerequisite, then covers arrival before shipment/current revision, foreign driver/customer IDs, duplicate arrival, tracking replay/staleness/terminal privacy, stable redisplay, cooldown/max generations, old-code rejection, concurrent guess budgets, fifteen-attempt exhaustion, exact expiry and just-before-expiry, compliance without attempt burn, concurrent success, regeneration race, native response loss/ambiguous history, repeated repair, retained capacity, single release/audit and deferred-constraint rollback. Fixture changes/cleanup remain bounded to generated Orders/products/commitments and restore catalogue flags; no shared Redis clearing.

### User verification and stop boundary

No commands were executed by Codex. Run from repository root, stopping on any failure:

1. With dev servers stopped: `pnpm run lint`, then `pnpm run typecheck`, then `pnpm --filter @gospaza/backend run test`, then `pnpm --filter @gospaza/api-client run test`, then `pnpm --filter @gospaza/backend run build`. Each must exit successfully; do not leave Next dev processes writing generated state during typecheck/build.
2. PostgreSQL/Redis available, backend stopped: configure the dedicated secret and run `pnpm --filter @gospaza/backend run db:migrate`. Expect the new handoff migration to apply successfully.
3. Backend only: retain the verified local test Yoco configuration, use the same OTP secret in backend/verifier, and disable payment reconciliation, dispatch, pickup and handoff workers for isolated fixtures. Start `pnpm --filter @gospaza/backend run dev` and wait for port 9000 readiness. In another terminal run `pnpm --filter @gospaza/backend run test:handoff`, then `pnpm --filter @gospaza/backend run test:dispatch-acceptance`. Expected: all prerequisites and slice assertions pass, deterministic cleanup succeeds.

No browser implementation/tests are added in C; D owns those. M16-D, M17, refunds, earnings, persistent GPS history, notifications and manual overrides are not started. No commit/merge was made.

### M16-C material file inventory

```text
apps/backend/.env.example
apps/backend/medusa-config.ts
apps/backend/package.json
apps/backend/src/api/middlewares.ts
apps/backend/src/api/driver/deliveries/[id]/arrive/route.ts
apps/backend/src/api/driver/deliveries/[id]/handoff/route.ts
apps/backend/src/api/driver/deliveries/[id]/handoff/verify/route.ts
apps/backend/src/api/driver/deliveries/[id]/tracking/route.ts
apps/backend/src/api/store/gospaza/orders/[id]/tracking/route.ts
apps/backend/src/api/store/gospaza/orders/[id]/handoff-code/route.ts
apps/backend/src/api/store/gospaza/orders/[id]/handoff-code/regenerate/route.ts
apps/backend/src/jobs/handoff.ts
apps/backend/src/lib/handoff-http.ts
apps/backend/src/lib/handoff-native.ts
apps/backend/src/lib/handoff-service.ts
apps/backend/src/lib/delivery-tracking.ts
apps/backend/src/lib/dispatch-http.ts
apps/backend/src/lib/dispatch-location.ts
apps/backend/src/lib/dispatch-orchestrator.ts
apps/backend/src/lib/dispatch-projection.ts
apps/backend/src/lib/pickup-native.ts
apps/backend/src/lib/pickup-service.ts
apps/backend/src/modules/marketplace/handoff-policy.ts
apps/backend/src/modules/marketplace/dispatch-rows.ts
apps/backend/src/modules/marketplace/service.ts
apps/backend/src/modules/marketplace/models/handoff-generation.ts
apps/backend/src/modules/marketplace/models/delivery-completion.ts
apps/backend/src/modules/marketplace/models/delivery-operation.ts
apps/backend/src/modules/marketplace/models/dispatch-commitment.ts
apps/backend/src/modules/marketplace/migrations/Migration20261024000000.ts
apps/backend/src/scripts/verify-handoff.ts
apps/backend/src/scripts/verify-pickup.ts
apps/backend/src/scripts/verify-dispatch.ts
apps/backend/tests/handoff-policy.test.ts
packages/contracts/src/handoff.ts
packages/contracts/src/dispatch.ts
packages/contracts/src/index.ts
packages/api-client/src/dispatch.ts
packages/api-client/tests/handoff.test.ts
milestones/MILESTONE_M16_PICKUP_TRACKING_DELIVERY_OTP.md
```
