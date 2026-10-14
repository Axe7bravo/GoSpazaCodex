# M12 — Picking

## Status, scope and authority

M12-A through M12-C are complete and user-verified. M11 is complete and user-verified. The approved B refinement permits explicit OWNER/MANAGER reassignment of IN_PROGRESS work; no silent takeover. M12-D static acceptance/security review and missing coverage are implemented, pending user verification. See M12_D_ACCEPTANCE.md for evidence, limitations and commands.

Goal: one authorized merchant employee physically picks one authoritative ACCEPTED GoSpaza Order and records exact progress. Complete only when every original ordered quantity is picked. Keep Medusa 2.18.0 authoritative for commercial Order, lines, quantity, prices, payment and inventory. No substitutions, refunds or fulfillment creation.

## 1. Repository and pinned-source findings

Paths are repository-relative; these source bodies were inspected rather than inferring behavior from names.

| Source | Finding / consequence |
| --- | --- |
| node_modules/@medusajs/core-flows/package.json | Installed core-flows is 2.18.0. Do not upgrade for picking. |
| node_modules/@medusajs/order/dist/models/order-item.js | Native OrderItem has versioned quantity and fulfilled/delivered/shipped/return/write-off quantities, represented as bigNumber. These are commercial/fulfillment state, not a picker work log. |
| node_modules/@medusajs/order/dist/models/line-item.js | Native OrderLineItem owns product/variant identity, presentation and unit price. Use the native Order DTO item ID, not variant ID or internal OrderItem join-row ID, as the picking-line selector. |
| node_modules/@medusajs/core-flows/dist/cart/workflows/complete-cart.js | Native completion derives reservation inputs from created Order lines and calls reserveInventoryStep. M10 already owns this completed checkout boundary. |
| node_modules/@medusajs/core-flows/dist/cart/steps/reserve-inventory.js | Creates reservations associated with native line_item_id, inventory item and location; quantity multiplies required inventory quantity by ordered quantity. Inventory-item locking protects creation; compensation deletes those reservations. Picking must not repeat reservation creation. |
| node_modules/@medusajs/core-flows/dist/order/workflows/create-fulfillment.js | prepareInventoryUpdate produces negative stock adjustments and reservation updates/deletions. Workflow registers native fulfillment, creates Order–Fulfillment link and emits fulfillment events. Calling this to mark a line picked would introduce real commerce/fulfillment effects outside M12. |
| apps/backend/src/modules/marketplace/models/order-operation.ts | One operation per native Order; PENDING_ACCEPTANCE/ACCEPTED/REJECTED with immutable terminal decision. Keep acceptance separate from picking. Do not replace ACCEPTED with PICKING or relax the M11 terminal guard. |
| apps/backend/src/modules/marketplace/order-operation-repository.ts | Reusable durable M10 successful handoff and tenant-scoped candidates. Rejected historical reads can use audited RELEASED capacity; picking must additionally require ACCEPTED and COMMITTED, never reuse the historical rejection exception as admission. |
| apps/backend/src/lib/order-operation-native.ts | readOperationalOrder uses supported Order/cart services and query.graph Order–cart link. Validates customer/channel, cancellation, shipping and snapshot variant/quantity consistency. Extend/expose this owning boundary if a shared validation is needed; do not build parallel Order authority. |
| apps/backend/src/lib/order-operations-service.ts | Merchant-first FOR UPDATE, post-lock membership/capability reread, tenant predicate before native reads, one atomic decision/audit/capacity transaction. Reuse this discipline. |
| apps/backend/src/modules/marketplace/team-service.ts | Team changes use the same merchant-first lock; picking requests must recheck membership after waiting so revocation cannot authorize stale work. |
| apps/backend/src/modules/marketplace/team-policy.ts | OWNER/MANAGER have M11 Order view/decision capabilities. PICKER does not. Add separate picking capabilities; do not grant PICKER acceptance or general M11 Order read. |
| apps/backend/src/modules/marketplace/models/order-decision-event.ts; workflows/decide-merchant-order.ts | Existing domain-specific append-oriented audit and one-step atomic workflow pattern. Reuse the pattern, not the decision-event table or a new general audit platform. |
| apps/merchant/app/merchant/shell.tsx; app/merchant/orders/* | Capability-gated portal; focus/visibility refresh; protected content removed on authorization loss. Reuse lifetimes/stale-request protection and shared API-client conventions. |
| packages/contracts/src/orders.ts; apps/customer/app/orders/order-view.tsx | Customer sees safe native commercial projection and merchant acceptance. M12 need not alter this contract: ACCEPTED remains accepted, not shipped/delivered. No customer picker identity or internal exception/audit exposure. |
| apps/backend/src/modules/marketplace/models/*; milestones/* | No PickSession/PickLine implementation or M13 milestone contract currently exists. Define only the operational handoff below, not substitution policy. |

Medusa ownership decision: native fulfillment is a different concern with stock effects. The small custom state is picking assignment/progress/exceptions/audit within the existing Marketplace/Order Operations logical domain. It links through the existing OrderOperation → native Order relationship. No second Order, inventory, payment or fulfillment store is introduced.

## 2. Admission and authority

Every read/mutation begins with merchant actor identity and active server-derived tenant membership. Admit only an owned, nondeleted OrderOperation with status ACCEPTED and the existing successful terminal M10 evidence, COMPLETED attempt, authoritative native Order correlation and COMMITTED reservation. Validate the native Order through the existing operational read boundary.

Pending/rejected owned Orders are not pickable; return a safe domain conflict for direct mutation, omit from the picking queue. Foreign/unknown/non-GoSpaza/ambiguous Order IDs use the same unavailable response without native data leakage. PICKER cannot use M11 list/detail routes to discover pending/rejected Orders.

Do not treat native Order existence, metadata, event delivery, browser IDs, stock channel, or an old session as authorization. Missing/changed native data fails closed without recreating an Order or changing quantities. No M10 completion/recovery rule changes.

## 3. Minimum durable state

### PickSession (one per OrderOperation)

- id; order_operation_id (all-row unique FK, no second session after soft deletion).
- assigned_member_id (server-derived on self-claim; changes only through explicit authorized reassignment while IN_PROGRESS).
- status: IN_PROGRESS or COMPLETED.
- revision (monotonic integer); started_at; completed_at nullable; created_at/updated_at.
- source_lines_fingerprint: canonical native line ID + variant ID + ordered quantity set at start, for detecting later native changes, not commercial authority.

NOT_STARTED is derived from an admitted ACCEPTED operation having no session; no eager session per Order or additional status row. Claim atomically creates session and all line records. M11 acceptance status stays ACCEPTED throughout picking. One session allows one claimed picker even if the picker uses multiple devices.

### PickLine (one per session/native Order line)

- id; pick_session_id FK; medusa_order_line_id; unique(session, native line ID).
- ordered_quantity_at_start: immutable server-read operational ceiling, explicitly a non-authoritative baseline.
- picked_quantity: whole units, initially zero.
- shortage_recorded: boolean, initially false.
- updated_at. Actor/history comes from session assignment and the audit event.

No copied prices/totals/customer data/product descriptions or second product ownership. Titles/SKU/variant details are read from the native Order. The baseline is revalidated against native quantities on every mutation and completion; mismatch blocks the session rather than making the baseline authoritative. Do not store another independently editable ordered quantity.

Per-line presentation is derived, not independently mutable:
- PICKED: picked_quantity equals native ordered quantity and shortage_recorded is false.
- EXCEPTION: picked_quantity is below ordered quantity and shortage_recorded is true.
- PENDING: picked_quantity below ordered quantity without a recorded shortage (including partially picked work).

### PickEvent (small domain audit and replay receipt)

One append-only event per accepted claim, changed line action, reassignment or completion. Fields: session, resulting revision (unique per session), prior revision, action, optional native line ID, server-derived acting member, server timestamp, normalized bounded request values, and previous/resulting picked quantity/exception state when relevant. No raw request/provider/customer payload. No events for reads, focus refresh, failed/stale attempts or duplicate replay.

This preserves who/what/when and allows exact retries without a separate idempotency subsystem. Reuse M11 domain-audit transaction conventions; do not overload its terminal decision table. Ordinary quantity entry is saved explicitly, not logged per keystroke. Current-state rows remain the read model; this is not event sourcing or a financial ledger.

## 4. Quantities, corrections and M13 handoff

Validate JSON picked_quantity as a safe whole integer (no coercion from strings), nonnegative and no greater than the server-read native quantity. Native ordered quantities must themselves pass the existing positive safe-integer boundary; BigNumber support does not authorize fractional physical units in this MVP. Fixed-weight variants are ordinary units, not measured-weight repricing.

Database checks enforce integral nonnegative picked quantity <= immutable positive baseline; service validation enforces equality of that baseline to current native authority. Choose a checked integer representation that covers the existing safe quantity range; do not accidentally impose a smaller 32-bit bound or silently round native values. Cross-module equality is checked using supported native reads, not native-table triggers/writes.

Updates set an absolute quantity, never an increment. Before completion the assigned picker may correct quantities upward or downward using the current revision; corrections are audited. A shortage must be explicitly recorded/cleared, not inferred from every partial pick. shortage_recorded=true with exact full quantity is invalid.

Unavailable item: EXCEPTION with picked_quantity=0. Insufficient stock: EXCEPTION with 0<picked_quantity<ordered quantity. Both preserve the original line and block completion. Remaining unresolved quantity is native ordered quantity minus picked quantity, derived server-side; no stored alternate refund/quantity balance.

M13 handoff is the accepted Order/operation + session/revision + original native line ID/variant + native ordered quantity + picked exact-item quantity + unresolved quantity + recorded exception/audit. M12 offers no substitute selector, substitute ID, commercial line deletion, price difference, customer decision timer or generic resolved=true escape hatch. The picker may find more of the exact original variant and clear the exception before completion; M13 later owns every other resolution and must extend completion validation explicitly. No M13 policy is invented here.

Revalidate the complete native line set/fingerprint on mutation/completion. Added/deleted/replaced lines or changed quantities fail closed with a safe refresh/review error. No automatic remapping, resetting picked quantities or rebinding to a different variant. Later native Order-edit coordination belongs to its approved milestone; arbitrary Admin commerce writes are not serialized by a Marketplace lock.

## 5. Capabilities and assignment

| Capability | OWNER | MANAGER | PICKER |
| --- | --- | --- | --- |
| MERCHANT_PICKING_VIEW | yes | yes | yes |
| MERCHANT_PICKING_PERFORM | yes | yes | yes |
| MERCHANT_PICKING_REASSIGN | yes | yes | no |
| Existing MERCHANT_ORDER_VIEW / DECIDE | unchanged | unchanged | no |

Use reusable backend requireCapability enforcement. A separate picking queue/detail allowlist gives PICKER only admitted ACCEPTED work and needed product/quantity/status information; no customer address/contact, payment/totals, staff rejection reason or M10 evidence. OWNER/MANAGER may inspect all same-store picking and may claim/perform work themselves. Performing an existing session always requires its assigned member, including OWNER/MANAGER; “manage” does not imply an unrestricted override.

Choose B: explicit self-claim. It satisfies AGENTS 1 order = 1 active picker and prevents two employees independently starting physical work. Option A (any authorized employee editing) cannot meet that invariant. Claim never accepts picker/member/tenant IDs from the browser.

No silent takeover, timeout release or auto-unassignment. OWNER/MANAGER may explicitly reassign an IN_PROGRESS session for operational recovery. The target identifier selects a member; the backend revalidates active same-merchant/store membership and picking capability under the merchant lock. The action requires expected_revision, advances revision, and records old/new assignee, server-derived acting member and database timestamp. Picking lines and shortages remain unchanged. PICKER cannot reassign; OWNER/MANAGER cannot bypass assignment for ordinary edits. COMPLETED cannot be reassigned. Revoked/removed assignees cannot mutate; progress remains durable until an authorized explicit handover.

## 6. Locking, revisions and replay

One PostgreSQL transaction per claim/reassign/line update/complete, wrapped in the existing one-step domain workflow pattern where appropriate:

1. Resolve tentative merchant from authenticated identity.
2. Lock merchant FOR UPDATE; re-read active membership, tenant and capability using that transaction.
3. Lock tenant-scoped OrderOperation FOR UPDATE; validate ACCEPTED and authoritative M10 handoff/native Order.
4. Lock PickSession FOR UPDATE if present; verify assignee for normal work or supervisor capability/target membership for reassignment; lock affected lines in stable native-line-ID order.
5. Revalidate native line fingerprint/quantities; decide revision/replay and transition.
6. Use fresh database time, update state and append audit in the same transaction; commit.

No native inventory, customer cart, payment or scheduling slot locks are acquired by M12. Do not re-enter a service that opens a second merchant-lock transaction while holding the first; expose/reuse a transaction-aware owner boundary if needed. No in-memory mutex, Redis-only correctness or blind workflow retry.

Session revision serializes all line/completion changes (no per-line version needed for MVP). First start creates revision 1; changed line, reassignment and completion each advance exactly once. Database uniqueness/FKs/checks enforce session/line identity; completed session and lines are immutable, with admission/complete consistency constraints analogous to M11 where feasible.

- Two employees claim: one session/assignee wins; other conflicts. Same assignee repeats start: current session returned, no new event.
- Two devices: both supply expected_revision; first valid update wins; the other conflicts unless it is the exact authenticated replay recorded for that revision.
- Exact replay: match actor, action, target and canonical payload against the stored event keyed by prior revision. No additional state/audit effect. Return authoritative current projection plus the already-applied revision; do not roll the UI back to an old quantity.
- Changed payload at the same revision: conflict even if superficially similar. No last-write-wins or increment reapplication.
- New request at current revision that changes nothing: return current state without new event/revision.
- Completion vs update: the same session lock/revision decides order. Completion rechecks every native line; after completion no new edit is permitted. Exact replay of an already-applied action may be acknowledged without changing history.
- Revocation during lock wait: post-lock membership check denies the request. Demotion OWNER/MANAGER → PICKER does not revoke picking in this approved matrix; it still removes M11 decision privileges. Loss of active membership or picking capability does revoke it.
- Database failure: state/audit roll back together. Lost response: reread/replay the same canonical action; never recreate session or replay non-idempotent native commerce.

## 7. Completion and inventory boundary

PICKING_COMPLETED is the PickSession COMPLETED transition; do not add it to M11's acceptance enum. Require authorized active assignee, expected revision, ACCEPTED authoritative operation, unchanged complete native line set, exactly one operational record per line, exact ordered quantity for each, and no shortage flag. Reject empty/missing/extra/unresolved lines. Audit completion and timestamp in the same transaction. Completion is irreversible within M12; no reopen/reset or correction after completion.

Inventory finding: managed native reservations already exist after successful M10 completion. Physical picking does not decrement stocked quantity, alter reserved quantity, move stock locations, create/delete reservations, create fulfillment, release delivery capacity, capture/release payment or change prices. Do not require a reservation for every unmanaged variant; native inventory management semantics remain native. Native fulfillment later owns its inventory effects. Preserve reservations even for recorded shortage, which is physical evidence rather than authority to rewrite available inventory.

Customer M11 projection remains safe and unchanged: ACCEPTED never implies shipped/delivered. No new customer picking controls or dispatch-ready claim. Future M13/M15 may consume completed picking through an explicit contract.

## 8. Proposed API/UI boundary (B/C only)

Native Order IDs remain selectors, not authority:
- GET /merchant/picking — bounded tenant-scoped accepted-work queue, default 20/max 100 and bounded offset; allowlisted picking status only.
- GET /merchant/picking/:id — picking-safe detail, NOT_STARTED or durable session.
- POST /merchant/picking/:id/claim — strict empty body; authenticated self-claim.
- PUT /merchant/picking/:id/lines/:line_id — strict { expected_revision, picked_quantity, shortage_recorded }; native ordered quantity/state/actor/timestamps are forbidden inputs.
- POST /merchant/picking/:id/reassign — strict { expected_revision, target_member_id }; supervisor-only, same active tenant, preserves progress.
- POST /merchant/picking/:id/complete — strict { expected_revision, confirmed: true }.

No generic patch/status route or client-supplied merchant/store/native quantity. Only the explicit reassign action accepts a target member selector, never membership authority. Unknown/foreign Order or line IDs must not leak existence. Owned but non-ACCEPTED work cannot be started; no queued pending/rejected detail exposure to PICKER. Native Order/operation IDs are not interchangeable.

C adds a capability-gated Picking entry in the existing merchant shell, tablet/mobile-friendly line controls, native variant identification, quantity/shortage editing, assignment conflict view, remaining-work summary and explicit completion confirmation. Use shared contracts/API client. Restore from backend after reload/focus; ignore stale/unmounted reads; never auto-replay writes. No authoritative local-storage picking state. Same-store peers may view progress but only assignee edits. Keep general M11 Orders navigation denied to PICKER.

## 9. Security traces and executable obligations

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Required B/D test |
| --- | --- |
| Known Order/operation/line IDs → validated selectors + tenant/M10/ACCEPTED gate → ownership → picking DTO/write | Real HTTP foreign/unknown equivalence; pending/rejected/non-GoSpaza/recovery denied; foreign line within own Order denied. |
| Session/member claim → active membership/capability reread after merchant lock → role + assignment → session/update/complete | OWNER/MANAGER/PICKER allowed only as assigned performer; wrong actors/applicants denied; two claimants; revocation while waiting; no forged picker identity. |
| Body → strict schema and native quantity validation → operational-only input → checked PickLine | Negative/fractional/overflow/string/over-order quantity rejected; forged status/tenant/timestamps/native quantity rejected. |
| Duplicate/stale payload → event match + revision under session lock → exactly one effect → state/audit | Concurrent same/different line actions, exact duplicate no double count/event, changed payload conflict, original actor/time retained. |
| Complete action → native lines + full quantities + no exceptions → irreversible completion → session/audit | Unavailable/short/partial/missing/extra lines deny completion; complete vs update race; terminal edits/reopen denied. |
| Browser state/URL → shared client/server projection → backend authority → controls | Direct navigation, reload, stale refetch without replay, assignment conflict, membership loss, no local authority. |
| Picking action → operational transaction only → native commerce boundary → unchanged Medusa records | Snapshot native Order lines/quantities/prices, inventory levels/reservations, payment and fulfillment before/after start/update/shortage/complete; no new native mutation proxy. |

Retain M4/M8–M11 regression tests. Use actual concurrent database/API tests and invocation-owned fixture cleanup. No sleeps, inflated timeouts or broad cleanup. Native Order admin mutation and store-route bypass denial must remain tested; frontend visibility is not the boundary.

## 10. Exact slices

### M12-A — reconnaissance/state contract

This document only, including native findings, decisions and limitations. No application implementation or verification commands. Stop for approval.

### M12-B — picking models/state + APIs + concurrency

Models/migration with identity/quantity/terminal/audit constraints; accepted-order authority via existing owner; self-claim, explicit supervisor reassignment, line/shortage updates and completion; reusable picking capabilities; bounded safe queue/detail; transaction-aware workflows/services; real DB/API/concurrency/security tests; shared DTOs as needed. No portal workflow, substitution or native commerce writes. Verify native fields/types again at implementation before using new version-sensitive APIs.

### M12-C — merchant/PICKER portal workflow

Shared API client + focused client tests, picking queue/detail and assignment/progress/shortage/completion UI; tablet/mobile usability; read-only peer and completed views; loading/empty/error/stale/retry states; focus/reload restoration and revocation; deterministic browser tests. Preserve M11 customer and acceptance semantics. No substitute UI. Explicit supervisor handover UI consumes B’s bounded reassignment endpoint.

### M12-D — acceptance/security/regression

Audit B/C as one system, fill only missing real race/known-ID/rollback/browser coverage, preserve native snapshots and M11 tests, report evidence/limitations and user-run verification commands grouped by no-dev-server, backend-only and required Playwright stack. Fix only proven M12 defects. No future-scope work.

## 11. Decisions, limitations and stop rule

No pinned Medusa incompatibility blocks this operational-only design. M12-B is safe to start after approval of this contract. Explicit assumptions proposed for approval: self-claim without silent takeover; explicit supervisor reassignment; pre-completion absolute quantity corrections; separate picking capabilities; shortage flag with no M13 resolution; immutable baseline solely as a native-validated safety check.

No unresolved native API question requires commands for A. Operational recovery: an unavailable/revoked assignee requires explicit OWNER/MANAGER handover; no automatic reassignment. Shortage Orders intentionally remain incomplete until exact original goods are found or M13 supplies a valid resolution. Neither limitation authorizes an automatic completion or refund.

Out of scope: substitutions/approval M13; driver accounts M14; dispatch M15; delivery OTP M16; doorstep alcohol checks M17; refunds/store credit M18; finance M19+; notifications/realtime, generic admin overrides, native fulfillment and native inventory release. No M12-C/D implementation, commands, commit or merge in B.

## M12-B implementation notes

- Picking routes use the separate `/merchant/picking` family so PICKER never gains M11 order-read/decision access. `:id` is the native Order selector; internal session/operation IDs are not accepted as interchangeable IDs.
- `pick_session`, `pick_line`, and `pick_event` are Marketplace operational records. The existing OrderOperation read-only native Order relationship supplies commerce correlation; no redundant native link or commerce writes are added.
- Quantity columns use native DML bigNumber/numeric plus raw companions and integral/range checks, representing the full safe-integer physical-unit range exactly. Pinned model.float maps to real (insufficient precision), so it is deliberately not used. They are not monetary columns. Native values use the existing M11 conversion boundary; client numbers are never coerced. Revision uses checked int4 and inputs stop before overflow.
- `withMerchantAuthorization` exposes the existing M11 merchant-lock/revalidation boundary; M11 calls it unchanged and M12 shares it.
- Real database/HTTP coverage: `apps/backend/src/scripts/verify-picking.ts` (`test:picking`), preserving the nested M10/M11-B prerequisites. Pure policy coverage: `apps/backend/tests/picking.test.ts`. M11-C regression remains `test:order-decisions`.
- All verification remains user-run. No dependencies, customer UI or native fulfillment introduced.
