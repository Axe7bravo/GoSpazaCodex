# M11 — Order Operations & Merchant Acceptance

## Status and authority

M11-A and M11-B are complete and user-verified against installed Medusa **2.18.0**. M10 is complete and user-verified. M11-C is complete and user-verified. M11-D is complete and user-verified. M11-E acceptance review and coverage additions are implemented pending user verification; M12 is not started.

This document defines the approved bounded M11 contract. Approval to proceed with a slice approves these decisions; implementation must not silently substitute a different state machine, role matrix or financial behavior. Follow `AGENTS.md` and the milestone, Medusa-first and security-review skills. Do not execute installs, migrations, tests, builds, lint, typecheck or servers unless separately requested.

Goal: turn each authoritative M10-created Medusa Order into one GoSpaza operational order; expose it only to its owning merchant/store and authenticated customer; permit an authorized merchant employee to accept or reject it once.

## 1. Reconnaissance evidence

Paths are relative to the repository root. The source bodies, not only comments/API names, were inspected.

| Evidence | Finding / design consequence |
| --- | --- |
| `node_modules/@medusajs/core-flows/package.json` | Installed version is 2.18.0. Do not upgrade Medusa for M11. |
| `node_modules/@medusajs/core-flows/dist/cart/workflows/complete-cart.js` | `complete-cart` stores workflow history for three days and declares `idempotent: false`. It creates a native Order with status `pending`, then performs links, cart completion, inventory reservation, payment authorization and capture transactions. Existing-order lookup is not proof against every interrupted native write. Preserve M10's dispatch/recovery boundary. |
| `node_modules/@medusajs/core-flows/dist/order/steps/create-orders.js` | Calls the Order module `createOrders`; compensation calls `deleteOrders`. Bare Order existence is not the M10 handoff. |
| `node_modules/@medusajs/utils/dist/core-flows/events.js` and `complete-cart.js` | `OrderWorkflowEvents.PLACED` is exactly `order.placed`; payload is `{ id: createdOrder.id }`. The event contains no trusted merchant identity. |
| `node_modules/@medusajs/core-flows/dist/common/steps/emit-event.js` | Passes the workflow `eventGroupId`; its compensator clears grouped events. |
| `node_modules/@medusajs/workflows-sdk/dist/helper/workflow-export.js` | Supplies event-group context; finish handling clears failed/reverted groups and releases other finished groups. Native event release does not wait for a later GoSpaza terminal database transaction. |
| `node_modules/@medusajs/event-bus-redis/dist/services/event-bus-redis.js` | Groups events in Redis and publishes subscribed events through its queue; group release filters for subscribers. Do not assume historical replay, exactly-once delivery, or that a missing subscriber will receive an old event later. |
| `node_modules/@medusajs/utils/dist/order/status.js` | Native commercial statuses do not express GoSpaza merchant acceptance. Do not overload native `pending`/`completed` as M11 decisions. |
| `node_modules/@medusajs/core-flows/dist/order/workflows/cancel-order.js` | Native cancellation runs captured-payment refunds, inventory reservation deletion, payment cancellation and collection changes. It is NOT an acceptable implementation of M11 merchant rejection. |
| `apps/backend/src/lib/completion-native.ts` | M10 validates Order/cart/customer/channel/items/shipping/totals/payment/capture relationships through public Medusa APIs before accepting completion. Reuse its source-of-truth boundary; do not recreate payment reconciliation in M11. |
| `apps/backend/src/lib/payment-reconciliation-service.ts`, `modules/marketplace/completion-repository.ts` | M10 atomically publishes a `SUCCEEDED` terminal receipt, `COMPLETED` attempt and `COMMITTED` reservation with the native Order ID. That durable evidence is the handoff, including after native workflow history expires. |
| `apps/backend/src/modules/marketplace/service.ts`, `models/*` | No existing `OrderOperation`. Marketplace currently owns merchant/store, cart binding, scheduling and checkout coordination. Introduce the operational owner alongside these, with a dedicated service/repository rather than adding route-local rules or a second commercial Order. |
| `apps/backend/src/modules/marketplace/team-policy.ts`, `team-service.ts` | Roles are OWNER/MANAGER/PICKER; reusable `requireCapability` exists, but no order capabilities exist yet. Team mutations lock merchant first and re-resolve membership inside the transaction. |
| `apps/backend/src/lib/applicant-auth.ts`, `merchant-tenancy.ts`, Marketplace `resolveTenant` | Merchant session actor and `auth_identity_id` resolve active membership, active merchant, approved application and store. Applicant/customer/driver/platform-user identities do not confer merchant tenancy. |
| `apps/merchant/app/merchant/shell.tsx` | Canonical portal is `/merchant`; shell refreshes tenancy on focus/visibility and periodically, removes protected content on failed authorization, and exposes server-returned capabilities. No orders UI exists. |
| `apps/backend/src/lib/checkout-status-service.ts`, `packages/contracts/src/checkout.ts`, `apps/customer/app/checkout/checkout-view.tsx` | Customer currently gets a verified Order reference via checkout status, not an operational Order detail view. Payment success and merchant acceptance must remain separate projections. |
| `apps/backend/src/workflows/approve-merchant.ts`, `reconcile-yoco-payment.ts`, `jobs/reconcile-yoco.ts` | Existing patterns support a workflow step owning a custom transaction and a bounded scheduled repair job. There is currently no application subscribers directory. |
| Marketplace review/scheduling event models and migrations | Existing domain-specific append-oriented audit records; not a generic audit platform. Use a small order-decision audit record in the same transaction. |
| `apps/backend/src/api/middlewares.ts`, `node_modules/@medusajs/framework/dist/http/router.js` | Native `/store/orders` is blocked. Native `/admin` requires platform `user` authentication, not merchant authentication. Preserve and test these boundaries; do not proxy native mutations into merchant APIs. |

`docs/ux/UX_SPEC.md` already names `/merchant/orders` and `/merchant/orders/[id]` and merchant accept/reject interactions. `docs/product/PRD.md` describes broader customer cancellation, but the current M11 scope takes precedence: no customer cancellation/refund workflow is introduced here. No acceptance timeout/automatic rejection requirement was found in the inspected requirements.

## 2. Ownership and minimum state

```text
PENDING_ACCEPTANCE -> ACCEPTED
PENDING_ACCEPTANCE -> REJECTED
```

Terminal decisions are irreversible in M11. `ACCEPTED` is a necessary future M12 picking precondition, not an implementation of picking or an instruction to create a fulfillment. `REJECTED` never qualifies for picking. No timeout, auto-acceptance, auto-rejection, reopening or generic status-edit API.

Medusa owns commercial Order/items/prices/tax/shipping/customer/payment/inventory. Marketplace's logical Order Operations domain owns only the merchant decision and immutable correlation. Keep it in the existing Marketplace module for this milestone so decision, tenancy and audit can use one PostgreSQL transaction. Put reusable behavior in a dedicated `OrderOperationsService`/repository; do not build a new deployed service, auth layer or financial ledger.

`OrderOperation` fields (B supplies identity/status/revision; C adds decision timestamps, actor, reason and audit):

- `id` (server-generated), `medusa_order_id` (unique, immutable, non-null).
- `checkout_completion_id` (unique immutable provenance, restrictive FK to the GoSpaza completion record).
- `merchant_id`, `merchant_store_id` (immutable server-derived binding).
- `status`, initially `PENDING_ACCEPTANCE`.
- `revision`, initially 0; the sole decision increments it to 1.
- `accepted_at` / `rejected_at`, nullable; exactly the appropriate timestamp for a terminal decision.
- `decided_by_member_id`, nullable until decision; authenticated MerchantMember identity, never supplied by the browser.
- `rejection_reason`, nullable, bounded plain text (trimmed, maximum 500 characters); optional in M11. Do not invent a reason taxonomy. Keep this merchant audit text out of the customer DTO.
- Standard created/updated timestamps. No public delete/archive/rebind operation; soft deletion must not permit another row for the same Order.

Database enforcement in B/C:

- Full unique constraints on native Order ID and completion ID, not only application checks or partial uniqueness excluding deleted rows.
- Composite FK `(merchant_store_id, merchant_id)` to existing `merchant_store(id, merchant_id)`; restrictive references for provenance and deciding member. Enforce deciding-member merchant consistency server-side and with a suitable custom-table constraint where practical.
- CHECKs for revision/state/timestamp/decision identity consistency; immutable native/binding/provenance columns; terminal decision cannot be rewritten, including by generated module CRUD.
- Supported **read-only module link** from OrderOperation's `medusa_order_id` to native `Order.linkable.order`, following `src/links/cart-context.ts`. No direct FK/write into Medusa-owned tables; no independent join-table identity required for read-only linking. Verify generated cardinality in B.

Do not copy native line items, shipping totals, addresses, payment status or refund balances into this model. Historical binding is an immutable projection of M10's accepted binding, not a second browser-editable ownership authority.

## 3. Authoritative provisioning

### Admission rule

Expose one typed, read-only Marketplace handoff contract around existing M10 evidence. It must require:

1. Exactly one matching `checkout_completion`, state `SUCCEEDED`, non-null validated terminal receipt/Order reference.
2. Its matching `CheckoutAttempt` is `COMPLETED`, with the same cart and immutable snapshot.
3. Matching reservation is `COMMITTED`, references this native Order, attempt and cart context.
4. CartMarketplaceContext, snapshot and MerchantStore→Merchant binding agree. Resolve identities server-side; native Sales Channel is a consistency check, never authorization.
5. The native Order exists and its ID/customer/cart relationship agrees with that handoff. Use public Order retrieval and Query/module-link APIs, as M10 already does. Native line items/totals are the display source; do not silently filter out inconsistent items to make a mixed order appear valid.

The handoff must fail closed on contradictions. It must not infer success from Order existence, event payload, metadata, a caller-supplied channel or absent native history. It must not reject a valid historical completed Order merely because a customer now has another current cart. No late/expired/refunded orderless payment or RECOVERY_REQUIRED partial Order is eligible. A missing/canceled native Order must not be presented as actionable; preserve any existing operational evidence and return a safe unavailable/conflict result rather than rebind or fabricate a replacement.

Do not replay native completion or re-authorize/capture payment while reading/provisioning. Do not duplicate M10 financial readback logic. Exposing its accepted completion evidence through a typed query is the only required M10-facing addition; its dispatch/commit architecture stays unchanged.

### One ensure operation, multiple safe callers

Implement idempotent `ensureOrderOperation` using admission above and a unique Order/provenance insert. On conflict, reread the existing row and verify the exact immutable binding. Return it unchanged, including terminal decisions; do not overwrite bindings or reset state.

Use:

- An `order.placed` subscriber as a latency hint. Validate the ID and call ensure. If M10 has not published the receipt yet, defer/no-op; never promote a partial Order. Event data is not authorization.
- A bounded scheduled repair job over durable successful M10 completion candidates missing their operation. This covers early/lost events, downtime, startup after M10 Orders already exist and repeated restarts. Use stable pagination and fair revisiting of failures so one bad record cannot starve later candidates; no full native Order scan or reliance on a process-local cursor for correctness.
- Authorized merchant list/detail read repair. List candidates from the tenant-scoped authoritative handoff first, ensure only the bounded page, then return operations. Do not query only already-provisioned operations and incorrectly show an empty list while the queue lags. Detail scopes the candidate to the authenticated tenant BEFORE ensuring or exposing it. Customer detail applies native customer ownership first.

All callers converge on the same ensure operation. PostgreSQL uniqueness provides at-most-one row; the repair/read paths provide eventual provisioning when services are available. A crash before commit leaves no row; after commit, retries return the same row. One malformed handoff must not expose another tenant or erase existing evidence.

Comparison:

- Native event alone is insufficient: it can precede GoSpaza terminal publication, be duplicated, or be unavailable for historical Orders.
- A post-native workflow hook is insufficient and risks moving provisioning into the completion failure domain. Do not add one to M10.
- Event hint + durable recovery + authorized read ensure is selected. No new outbox or broad event framework is required for provisioning correctness.

## 4. Authorization and merchant APIs

M11 additions to the existing M4 capability map (these are new permissions, not claims that M4 already granted them):

| Role | MERCHANT_ORDER_VIEW | MERCHANT_ORDER_DECIDE |
| --- | --- | --- |
| OWNER | yes | yes |
| MANAGER | yes | yes |
| PICKER | no | no |

This is the minimum merchant-acceptance grant. M12 may explicitly add the picker view/claim capabilities it requires; do not grant a picker acceptance authority or expose pending customer Orders now. All existing catalogue/inventory/team permissions stay unchanged.

Routes, with native Order ID as the resource selector:

```text
GET  /merchant/orders
GET  /merchant/orders/:id
POST /merchant/orders/:id/accept
POST /merchant/orders/:id/reject
GET  /store/gospaza/orders/:id
```

- Merchant actor → `applicantIdentity` → active `resolveTenant` → reusable `requireCapability`. Repeat authorization inside mutation transactions after acquiring locks.
- List/detail require VIEW; decisions require DECIDE. Customer/driver/platform-user sessions must not substitute for merchant sessions. Platform Admin remains a separate privileged trust domain, not a shortcut to these routes.
- Scope by both derived merchant and store. Unknown and foreign well-formed IDs return the same 404. Missing/invalid identity gets 401; absent capability gets 403 before unrelated resource details. Malformed params/body/query get safe 400 responses.
- Strict query/body schemas; reject merchant/store/customer/channel/context/payment IDs, `status`, timestamps, deciding identity, arbitrary native fields/expansions. Bounded pagination (default 20, maximum 100), fixed sort/filter allowlist and parameterized queries.
- `Cache-Control: private, no-store`; use existing origin/session protections. No token in local storage, raw entities, provider diagnostics, private media keys or unrestricted customer PII.
- Merchant detail shows only useful native order reference/time/items/variant/quantity/prices/totals and selected delivery window, plus operation state/revision. Minimize customer data; no billing address, payment identifiers or full checkout/provider snapshot. If images are shown, reuse tracked-public media filtering.
- Customer detail verifies native `order.customer_id` against authenticated customer and requires the same successful M10 handoff; a known Order ID is never sufficient. No public order search/list is required in M11.

Native `/store/orders` stays blocked. Test merchant/customer attempts to mutate native `/admin/orders/:id` routes fail their native user-auth boundary. Never grant native platform-user credentials to merchant employees. Existing privileged native Admin capabilities are not redesigned in M11; broad platform controls remain later work. Native status changes must never be interpreted as an M11 accept/reject decision.

## 5. Atomic merchant decision

Use a small Medusa workflow whose decision step owns one Marketplace database transaction, following existing atomic custom-domain workflow patterns. The transaction performs authorization, state change and audit together. Do not place irreversible financial/native mutations inside it.

Lock order:

```text
derive initial tenant from authenticated merchant identity
-> transaction: lock merchant row
-> re-resolve current active membership/store/capability
-> lock tenant-scoped OrderOperation row FOR UPDATE
-> validate/replay/decide
-> insert audit and update operation
-> commit
```

Reuse M4's merchant-first order so member deactivation/demotion and decisions have a definite winner. A request waiting behind a committed membership revocation must fail authorization. Provisioning also uses a consistent merchant-before-operation order when locks are needed. Do not acquire customer/payment locks from this path or change M10 locking. No process-local mutex as authority.

Input:

```text
accept: { expected_revision: 0, confirmed: true }
reject: { expected_revision: 0, confirmed: true, reason?: bounded string }
```

For pending revision 0, exactly one transition may commit; use fresh PostgreSQL time for the decision timestamp. Check native Order availability through the same owning read contract before allowing a new decision. Store the authenticated member ID and one audit record. Route/actor IDs never populate authority fields directly. This custom lock serializes GoSpaza decisions and M4 membership changes, not arbitrary privileged native Admin mutations; do not claim it provides that broader guarantee.

Replay semantics:

- An authorized repeat of the same action and normalized payload returns the already-established result without changing timestamp, deciding member, revision or audit. The original expected revision 0 remains valid for this exact retry even though the stored revision is now 1.
- A second authorized employee submitting the same decision also observes the original result; do not falsely attribute it to the replayer.
- Opposite decision, changed rejection reason, or incompatible/stale revision returns safe 409 `ORDER_DECISION_CONFLICT` with instructions to refresh; never last-write-wins.
- Always recheck ownership/capability before replay. A deactivated employee does not retain a replay exception.
- No separate idempotency-key ledger is needed: the unique operation, terminal decision, normalized payload and row lock establish the bounded one-decision operation.

Audit: append-oriented `OrderDecisionEvent` tied to the operation, unique operation ID (one decision), original member identity, from/to state, normalized optional reason and server timestamp. Enforce update immutability and no ordinary deletion path. The event is written in the same transaction; failure rolls back both. Do not dump native order/address/payment payloads. Reuse domain-audit conventions, not a platform-wide audit subsystem.

There is no compensator that reverses a committed merchant decision. Failure after commit/response loss is resolved by the same-action read/replay. No downstream event delivery is necessary for correctness; future reactions cannot be prerequisites to a successful decision. M12 will read ACCEPTED from the authoritative operation.

## 6. Rejection before M18

Rejection stops all GoSpaza fulfillment progression. It is not native cancellation or a financial state transition. Never call `cancelOrderWorkflow`, refund/cancel payment APIs, delete captures, mark an attempt failed, reopen checkout or start M10 technical compensation for merchant rejection.

Customer wording for a rejected paid Order:

> The store could not accept this order. It will not be prepared or delivered. Your payment was received; a refund has not been confirmed.

Show this only alongside the appropriate server-derived paid outcome; do not promise a refund date, issue credit, or show “refund processing” without a real financial process. Do not expose optional merchant free-text audit reasons by default. Keep a safe Order reference. No invented support channel or general support/refund UI.

Keep commercial checkout success distinct from operational rejection: M10's verified `succeeded` remains its historical commercial outcome. The customer Order projection reports `REJECTED`; it must visibly supersede any implication that successful checkout guarantees delivery. Accepted wording is “Accepted by the store,” not “Picking,” “Dispatched” or “Delivered.”

Approved refinement: **M11-C rejection releases GoSpaza-owned delivery-slot capacity**, because the rejected Order will not be fulfilled. Implement that through the scheduling owner in the same atomic decision boundary, with explicit provenance and regression tests; do not turn M10's general COMMITTED guard into unrestricted release. Replay must not release twice. Preserve the completed checkout's historical success and the reservation's Order correlation. Historical rejected Orders must remain readable after this authorized release; C must distinguish that proven release from missing/invalid M10 admission evidence.

**Medusa-owned inventory reservations are different.** Do not independently release them unless a supported non-financial native mechanism is proven. Otherwise retain them until M18 cancellation/refund handling. Do not call native cancellation to achieve capacity release: it has financial side effects. Inventory retention and unresolved customer financial resolution remain launch-readiness limitations.

M11-B implements neither release nor rejection. Its admission still requires the existing COMMITTED reservation; M10 scheduling/completion guards remain unchanged in B.

## 7. Portal and customer projection

- `/merchant/orders`: pending attention-first list, bounded pagination, state filters, clear loading/empty/error/retry states.
- `/merchant/orders/[id]`: native commercial details plus decision controls only for DECIDE; explicit accept/reject confirmation, optional rejection reason, duplicate-click prevention, refresh after conflict.
- Reuse MerchantShell/capability refresh and existing API-client/contracts. UI hiding is never authorization. Remove protected content when membership becomes inactive; ignore stale requests after navigation/unmount.
- `/orders/[id]` customer detail is the minimum durable projection; link from M10's verified Order reference. Read the backend on reload/focus. Do not depend on the latest current cart or browser-local state to restore a historical Order.
- Keep financial and operational states distinct. Pending provisioning must not be fabricated as accepted; an inconsistent handoff is an unavailable/retry state, never a false success.
- No picking buttons, cancellation button, driver/tracking screens, refund controls or full account-order-history feature in this milestone.

## 8. Slice boundaries and acceptance

### M11-A — reconnaissance/state contract

This document only. Inspect repository/native semantics, resolve the minimal handoff/state/authority/locking design, state limitations. No application code, schema, migrations, routes or tests are added. Stop for approval.

### M11-B — provisioning + merchant read APIs

- OrderOperation model/migration with uniqueness, immutable correlation and read-only native link.
- Typed M10 completed-order handoff and idempotent ensure service; subscriber, bounded repair job and tenant-scoped list/detail read repair.
- Add order capability definitions/mapping and enforce VIEW; do not implement decision routes yet.
- Merchant list/detail DTOs, API-client/contracts as needed. No portal or customer Order UI.
- Real DB/API tests: duplicate and concurrent ensures; historical repair; event-before-receipt; receipt-before-worker; process-restart/repeated ensure; cross-merchant/actor/list-count isolation; unknown/non-M10/recovery/late-payment Orders excluded; corruption fails closed; native retrieval and module link.

### M11-C — accept/reject + RBAC/concurrency/audit

- Decision workflow/service, strict inputs, transactional merchant/op locks, audit constraints and immutable terminal state.
- Rejection releases GoSpaza delivery capacity through the scheduling owner, atomically/idempotently with the decision. Prove scheduling lock order and preserve historical read authority. Native inventory remains retained unless supported non-financial release is proven.
- Real concurrent same/opposite decisions; one winning state/audit; original actor/time preserved on replay; reason/revision conflicts; membership revocation/demotion race; tenant known-ID attacks; no native financial/commerce mutation.
- No portal/customer UI or future operational workflow.

### M11-D — merchant portal + customer projection

- Bounded merchant list/detail/confirm controls and customer-owned detail endpoint/page, using shared clients/contracts and the completed-order handoff.
- M10 verified Order link/projection integration without changing payment/completion semantics.
- Browser tests for pending/accepted/rejected, reason entry, duplicate clicks, stale conflict refresh, inactive member, denied picker controls, customer refresh/historical restoration, explicit non-refund wording.
- No picking, delivery tracking, cancellation or refund product functionality.

### M11-E — acceptance/security/regression

- Audit implementation against this contract; add missing executable coverage only.
- SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK for Order ID, list filters, decision payload, session identity and event data.
- Prove BOLA/actor isolation/mass-assignment rejection, bounded lists, duplicate events/decisions, accept-vs-reject and membership races, event lag/read repair, immutable audit and no refund/payment side effects; rejection releases only GoSpaza capacity once, with native inventory retained by default.
- Preserve M4/M8/M9/M10 tests. No architecture broadening or general refactor. Fix only proven defects and report separately.

## 9. Security and test obligations

| Source → transformation → trust boundary → sink | Required proof |
| --- | --- |
| Known native Order ID → M10 handoff + derived tenant predicate → merchant ownership → native Order DTO/operation | Foreign and forged IDs cannot read, provision through a merchant request, decide, or affect list counts. Unknown and foreign results are indistinguishable. |
| Merchant/customer/admin session → actor check + current membership/capability → authorization → decision transaction | Wrong actors, applicants, inactive members and pickers denied. Recheck after merchant lock wait. |
| Browser state/merchant/store/decider fields → strict schema → server authority → persisted decision | Hostile fields rejected, not ignored into a spread/update. No generic PATCH status. |
| Duplicate/stale action → row lock + canonical replay → irreversible state → operation + audit | Same action idempotent; opposite action cannot win later; one audit; no arbitrary sleeps. |
| Native event `{id}` → validated authoritative M10 evidence → successful-commerce boundary → ensure | An event alone cannot provision/expose a partial/foreign/non-M10 Order. Missing event is repaired durably. |
| Direct native API call → native actor middleware / existing store block → commerce mutation | Merchant/customer cannot use native admin cancellation or store Order routes as a bypass. No new native proxy route. |
| Rejected paid Order → safe operational projection → financial truth → customer screen | No invented refunded/pending-refund state, no payment changes, no picking eligibility. |

Real database tests must use actual transactions/concurrent requests and scoped fixtures. Browser mocks prove UX only. New verifiers must not rely on manual Redis clearing, Admin changes, non-test payments, timeout inflation or destructive cleanup of unrelated records. Preserve history outside explicitly owned disposable test fixtures.

## 10. Verification/reporting and stop rules

M11-A requires document review only; no user command is necessary. M10 is user-verified, not rerun here.

For implemented B–E, give exact existing/new script names after they actually exist, with expected success and stop-on-failure. Group:

1. No dev servers: lint, typecheck, relevant unit/client tests, builds; stop Next before generated `.next` type/build work.
2. Backend only with PostgreSQL/Redis: required migrations/link synchronization and real DB/API verifiers; don't start every frontend for a backend test.
3. Required browser stack: focused merchant/customer Order journeys, then full regression. One worker; deterministic state/navigation synchronization.

Slice report: implemented scope; native ownership; schema/links; APIs/workflows; role/security decisions; concurrency/replay; tests and actual verification status; exact files changed; commands; limitations; next-slice prerequisites. Never declare runtime verification passed without user output.

## 11. Explicit exclusions and open decisions

No acceptance timeout, customer cancellation, native order cancellation, independent native stock release, picking/claims (M12), substitutions (M13), dispatch/driver assignment (M15), alcohol handoff (M17), general refunds/store credit (M18), finance/settlements (M19+), broad admin recovery tooling or microservices.

No pinned-version blocker to M11-B was found. M11-B is safe to start after approval of this contract, with the OWNER/MANAGER role matrix and the approved GoSpaza-capacity/native-inventory distinction above. These are explicit approved scope choices, not discovered existing M4 permissions. Later launch readiness requires an approved operational/financial resolution for rejected paid Orders; do not claim M11 alone closes that gap.

## 12. M11-B implementation notes

- Marketplace owns `OrderOperation`; migration `Migration20261011000000.ts` enforces all-row native Order/provenance uniqueness, composite store ownership, immutable identity and successful-checkout admission. B permits only PENDING_ACCEPTANCE/revision 0 at the database level. C adds audited transition constraints and decision fields in its own migration.
- `order-operation-repository.ts` is the typed read-only M10 handoff boundary. It joins only Marketplace-owned evidence. Native Order/cart/module-link reads and the existing exact money conversion remain in `order-operation-native.ts`; no payment replay or native commerce SQL is introduced.
- `OrderOperationsService` is the single provisioning owner. Subscriber, fixed 50-candidate/minute repair job, and authorized page/detail repair converge on its materialization path. The repair cursor is a persisted infrastructure row, uses keyset order, skips a concurrently held cursor and wraps after an empty page. Failed candidates are revisited on the next sweep; no process-local cursor is authoritative.
- Lists default to 20, maximum 100, offset maximum 10000; only the three operational statuses are filterable. Scope applies before native reads, count and pagination. Malformed input is 400; well-formed foreign/unknown native Order IDs share 404. Operation IDs are not accepted in place of native Order IDs.
- B grants only MERCHANT_ORDER_VIEW to OWNER/MANAGER. No DECIDE capability, customer Order route, portal UI or decision route is added.
- Projection includes native Order reference/time/items/minor-unit totals, recipient name/city, committed delivery window and owning-store pickup address. It omits billing/contact identifiers, full customer delivery address, media, metadata and provider/workflow/snapshot internals. No stored commercial projection is introduced.
- `verify-order-operations.ts` extends the existing M10 reconciliation fixture after its assertions, producing real native completed Orders. External Yoco HTTP alone is substituted; PostgreSQL, module links, authenticated merchant HTTP, concurrency and native Order reads are real. Cleanup is limited to invocation-owned fixtures and waits for merchant-scoped ensures before deleting their completion evidence.
- No commands or runtime verification were executed by Codex for B. See the slice report for user-run checks. M11-C must not start until B is verified.

## 13. M11-C implementation and static acceptance map

M11-A/B are user-verified. M11-C implementation is complete; its commands have **not** been executed by Codex.

### Decision and ownership boundary

- Routes remain native Order-ID selectors: POST `/merchant/orders/:id/accept` and `/reject`. Operation IDs are not alternate selectors.
- `expected_revision` is only an optimistic comparison token, never an assigned revision. The backend assigns 0 → 1; arbitrary `revision` and ownership fields are rejected. `confirmed: true` is required. Rejection normalizes blank/omitted reason to null and trims/bounds text to 500 characters.
- `decideMerchantOrderWorkflow` has one atomic Marketplace step with no reversal compensator. The existing membership/capability owner grants DECIDE to OWNER/MANAGER only.
- Lock sequence is merchant FOR UPDATE → active membership/capability reread → tenant-scoped operation FOR UPDATE → existing slot lock → fresh database time → decision/audit → reservation write → commit. M9 configured operations acquire merchant SHARE before slot locks; M10 final commit does not acquire a merchant lock after its slot. This path never acquires customer/payment/configuration advisory locks.
- Same action/normalized payload returns the original terminal result, including its timestamps; changing the reason or action, or using an incompatible revision, returns 409 ORDER_DECISION_CONFLICT. Replayers never replace the original audit identity.
- Medusa 2.18's generic conflict handler replaces error codes, so the route explicitly translates this one known domain conflict. Other authorization/validation errors retain existing handling.

### Capacity and historical authority

`Migration20261011100000` adds decision fields, domain audit, pending/terminal shape checks, active same-merchant deciding-member validation, immutable terminal decisions/audit, and a deferred constraint requiring status + audit + capacity consistency at commit.

The scheduling repository's `releaseRejectedOrderCapacity` is the only new release operation. It reuses slot locks, transitions COMMITTED → RELEASED with `ORDER_REJECTED`, increments selection revision once and preserves native Order/payment/deadline/binding fields. The M10 guard permits this exact transition only with a matching rejected operation and audit; no ordinary hold-release bypass is enabled. Released Order capacity cannot be reactivated. Occupancy remains owned by M9's existing query—there is no second capacity counter.

Initial operation admission still requires COMMITTED. Historical read/ensure additionally accepts RELEASED only with matching retained rejection audit and M10 successful completion evidence. Existing operations are reread before INSERT, avoiding the initial-admission trigger for legitimate historical rejection. M10 completion receipts/attempts and native Order, inventory and Payment/Capture are not modified.

### Executable coverage

| Boundary/invariant | Coverage |
| --- | --- |
| Strict mass assignment, confirmation, reason normalization/bounds, incompatible revision | `tests/order-decisions.test.ts`; real HTTP hostile inputs in `verify-order-decisions.ts` |
| OWNER/MANAGER allowed; PICKER/inactive/removed/wrong actor denied | Real merchant sessions and HTTP, reusable capability unit test |
| Cross-merchant known Order/operation IDs, unknown IDs and forged tenant fields | Real HTTP 404 equivalence and 400 strict-schema assertions |
| Duplicate accept/reject, opposite action, original actor/time/audit retained | Actual simultaneous HTTP requests plus authoritative PostgreSQL readback |
| Two authorized employees, accept-vs-reject | Simultaneous OWNER/MANAGER HTTP decisions; one 200, one 409; one audit and matching final capacity |
| Permission revoked/demoted while waiting for merchant lock | Actual PostgreSQL lock wait, observed query dispatch, then committed revocation/demotion; no sleeps or mocked lock |
| Audit/state atomically enforced | Direct invalid database writes rejected; release-failure injection rolls back decision/audit/capacity |
| Rejection releases exactly one place; accepted capacity retained | Existing occupancy query; full fixture slot denies an actual customer selection, rejection enables it, replay leaves occupancy unchanged |
| Native commerce remains authoritative/unmodified | Public Order, Payment/Capture/Refund and inventory-reservation snapshots compared before/after decisions |
| Rejected history remains readable and terminal | Merchant detail/list/ensure after release; DB terminal rewrite rejected |
| Native mutation bypass | Merchant/customer calls to native Admin cancel remain unauthorized; no merchant generic status route |
| Prior M11-B/M10-E assertions | Decision verifier composes the existing order/reconciliation verifier; standalone scripts remain available |

Security trace: request Order ID/body → strict schema and normalized action → authenticated merchant membership rechecked under merchant lock and tenant-scoped successful M10 handoff → custom decision/audit and scheduling release transaction. Native commerce is read-only. The threat boundary is merchant/customer callers, not a database administrator with arbitrary SQL privileges. No generic audit deletion API exists; verifier cleanup deletes only invocation-owned disposable records in dependency order.

No picking API or eligibility engine is added: immutable ACCEPTED is the only future M12 admission state; REJECTED cannot become ACCEPTED. No customer/merchant UI, refund, cancellation, independent inventory release, or M11-D/M12 work is included. Native inventory remains reserved and paid rejection remains financially unresolved until M18.

### User verification

Run from repository root. Stop on any failure. Stop Next development processes before typecheck/build.

No development servers:
1. `pnpm run lint` — no errors/warnings.
2. `pnpm run typecheck` — all workspace types pass.
3. `pnpm --filter @gospaza/backend run test` — backend policy/unit suite passes.
4. `pnpm --filter @gospaza/backend run build` — backend production build succeeds.

PostgreSQL/Redis running, backend stopped for migration:
5. `pnpm --filter @gospaza/backend run db:migrate` — C forward migration and link synchronization complete.

Backend only (no Next apps needed):
6. `pnpm --filter @gospaza/backend run dev` — in a separate terminal, wait for port 9000 readiness.
7. `pnpm --filter @gospaza/backend run test:order-decisions` — M10 reconciliation, M11-B and M11-C assertions pass. Use existing local test Yoco configuration and PAYMENT_RECONCILIATION_WORKER_ENABLED=false in both backend/verifier, as required by the reused M10 fixture; no live payments.
8. `pnpm --filter @gospaza/backend run test:team` — M4 role/membership regression passes.
9. `pnpm --filter @gospaza/backend run test:delivery-reservations` — M9 capacity/concurrency regression passes.
10. `pnpm --filter @gospaza/backend run test:checkout-foundation` — unchanged M10-C checkout/freeze regression passes.

No browser test is added for this backend-only slice. M11-D remains unstarted.

## 14. M11-D implementation — pending user verification

M11-A through M11-C are user-verified. M11-D is implemented; Codex has not run commands or runtime verification. M11-E and M12 remain unstarted.

### Routes and authority

- Merchant pages: `/merchant/orders` and `/merchant/orders/[id]`, consuming the existing B/C read and explicit decision routes.
- Customer page: `/orders/[id]`, linked from the verified M10 checkout Order reference.
- New read-only customer API: GET `/store/gospaza/orders/:id`. Existing customer actor middleware and an explicit handler guard supply customer identity. Pinned 2.18.0 `IOrderModuleService.listOrders` supports both native ID and customer ID filters; that owned lookup precedes operational evidence/provisioning.
- Customer read validates M10 snapshot customer identity, then uses the same merchant-first lock, handoff reread and native projection as existing reads. Missing/foreign/non-authoritative IDs return the same unavailable result. It is independent of the current cart.
- Merchant reads now also include existing decision timestamps and optional rejection reason. Customer projection explicitly excludes staff reason, deciding member, revision, provider/payment/workflow evidence, native metadata and private addresses.
- No schema change, migration, native commerce write, new financial state, decision logic or capacity change.

### Presentation and refresh

OWNER/MANAGER controls are capability-based presentation; server authorization is unchanged. PICKER gets no Order navigation/data view. List uses existing server filtering and bounded pagination. Detail requires explicit confirmation, with a secondary rejection flow and the existing 500-character reason bound.

Effect-local lifetimes/generations ignore stale and unmounted reads. Focus/visibility/manual refresh re-fetch authoritative state. A synchronous in-flight latch prevents duplicate writes. Conflict or network uncertainty triggers a read, never automatic mutation replay. Terminal states remove both decision paths.

Customer states distinguish received/awaiting merchant confirmation, accepted by the store, and cannot be fulfilled. Rejection states: “This order will not be fulfilled. Payment resolution is still pending.” It does not claim a refund or expose internal financial/inventory limitations. No browser storage is required.

### Focused tests

| Coverage | Location |
| --- | --- |
| Actor-specific URLs, credentials, allowlisted choice payloads, safe errors, no mutation retries | `packages/api-client/tests/orders.test.ts` |
| Native customer ownership, foreign/unknown equivalence, wrong actor, hostile query/operation IDs, native/snapshot identity mismatch, bounded missing-operation recovery | Existing `verify-order-operations.ts` extended; all B/M10 assertions retained |
| Customer ACCEPTED/REJECTED after real decisions/capacity release; staff-only reason; foreign rejected Order denied | Existing `verify-order-decisions.ts` extended; all C race/audit assertions retained |
| List filtering/pagination/navigation; OWNER/MANAGER accept/reject; duplicate click; reason bound; conflict refetch; terminal reload; picker denial; membership loss; network/read failure; customer three states/foreign lookup/reload/focus | `tests/browser/orders.spec.ts` |

Browser mocks establish UX, not database authorization. Existing composed real HTTP/database verifiers establish the new customer boundary.

### Commands for user to run

All commands are one line, from repository root. Stop on failure. No installation or migration is required for D.

**No development servers running** (stop Next before type generation/build):
1. `pnpm run lint` — no lint errors or warnings.
2. `pnpm run typecheck` — workspace types pass.
3. `pnpm --filter @gospaza/api-client run test` — client regressions pass.
4. `pnpm --filter @gospaza/backend run test` — backend policy/unit regressions pass.
5. `pnpm --filter @gospaza/backend run build` — backend build succeeds.
6. `pnpm --filter @gospaza/merchant run build` — merchant build succeeds.
7. `pnpm --filter @gospaza/customer run build` — customer build succeeds.

**Backend only**, with PostgreSQL/Redis and existing local test-payment verification configuration:
8. `pnpm --filter @gospaza/backend run dev` — separate terminal; wait for backend readiness. Keep the existing verification requirement PAYMENT_RECONCILIATION_WORKER_ENABLED=false.
9. `pnpm --filter @gospaza/backend run test:order-decisions` — composed M10/M11-B/C/D real HTTP/database checks pass, including new customer projections. No frontend stack is needed.

**Browser/frontend stack** (Playwright manages its configured four frontend dev servers; browser API requests are mocked):
10. `pnpm exec playwright test tests/browser/orders.spec.ts tests/browser/checkout.spec.ts --workers=1` — order journeys and M10 checkout regression pass.
11. `pnpm run test:browser` — full browser regression passes.

No commit or merge. No picking, preparation stages, substitution, dispatch, native cancellation, inventory release, refund/store credit or new notification/realtime implementation. Paid rejection still requires M18 financial resolution; this slice only presents that fact safely.

### M11-D files materially changed

- `apps/backend/src/api/store/gospaza/orders/[id]/route.ts`
- `apps/backend/src/lib/order-operation-http.ts`
- `apps/backend/src/lib/order-operation-native.ts`
- `apps/backend/src/lib/order-operations-service.ts`
- `apps/backend/src/scripts/verify-order-decisions.ts`
- `apps/backend/src/scripts/verify-order-operations.ts`
- `apps/customer/app/checkout/checkout-view.tsx`
- `apps/customer/app/globals.css`
- `apps/customer/app/orders/[id]/page.tsx`
- `apps/customer/app/orders/order-view.tsx`
- `apps/merchant/app/globals.css`
- `apps/merchant/app/merchant/orders/[id]/page.tsx`
- `apps/merchant/app/merchant/orders/order-detail.tsx`
- `apps/merchant/app/merchant/orders/page.tsx`
- `apps/merchant/app/merchant/shell.tsx`
- `apps/merchant/app/order-client.ts`
- `milestones/MILESTONE_M11_ORDER_OPERATIONS_MERCHANT_ACCEPTANCE.md`
- `packages/api-client/src/index.ts`
- `packages/api-client/src/orders.ts`
- `packages/api-client/tests/orders.test.ts`
- `packages/contracts/src/orders.ts`
- `packages/ui/package.json`
- `packages/ui/src/orders.tsx`
- `tests/browser/orders.spec.ts`

## 15. M11-E acceptance/security

M11-A through M11-D are user-verified. M11-E adds only focused verifier coverage and a customer/merchant browser configuration; no production defect was identified and no production behavior changed. See [M11-E acceptance matrix, security traces, limitations and commands](M11_E_ACCEPTANCE.md). All new checks await user execution. Historical slice notes above describe their status at implementation time. No commit, merge or M12 work.
