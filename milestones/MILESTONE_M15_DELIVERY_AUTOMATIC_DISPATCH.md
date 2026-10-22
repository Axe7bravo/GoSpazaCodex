# M15 — Delivery & Automatic Dispatch

## Status and scope

M15-A, M15-B and M15-C are approved and user-verified. M15-D static acceptance/security review and additional regression coverage are prepared; see M15_D_ACCEPTANCE.md for findings, concurrency proof, coverage limits and the frozen M16 handoff. D verification is pending. Codex has not run verification commands or committed these changes.

Sections 1–18 retain the original reconnaissance and proposed policies for traceability. The approved policies in section 19 supersede every conflicting recommendation and resolve the former section 18 approval gates. They authorize M15-B only.

M15 introduces operational dispatch only. Medusa remains authoritative for Order, items, prices, payments, inventory, shipping methods and native fulfillment. M14 remains authoritative for driver identity, lifecycle, affiliation and persistent eligibility. M9 owns delivery-slot capacity. M15 owns dynamic availability, latest location admission, offers and single-driver assignment capacity. These are separate capacities.

## 1. Source-backed reconnaissance

Paths below are repository-relative except pinned package paths. Inspection is static; it is not runtime verification.

| Source | Finding and implication |
|---|---|
| apps/backend/src/modules/marketplace/order-operation-repository.ts | completedOrderCandidates/readOrderHandoff require successful terminal completion, completed attempt and native Order/cart relationship. Historical rejected-order capacity can also qualify for this read boundary. M15 must additionally require ACCEPTED and COMMITTED; it must not copy the query and mistake historical eligibility for dispatch readiness. |
| apps/backend/src/lib/order-operation-native.ts | readOperationalOrder verifies native Order/cart/customer/channel/line/shipping-option identity and rejects canceled Orders. Native Order remains commercial authority. |
| apps/backend/src/lib/order-operations-service.ts | Merchant-first authorization and row locks; irreversible ACCEPTED/REJECTED; rejection releases only GoSpaza slot commitment. Bounded idempotent repair exists. |
| apps/backend/src/subscribers/order-placed.ts; jobs/repair-order-operations.ts | order.placed can precede terminal GoSpaza completion. Subscriber is a hint; durable evidence, ensure and bounded repair establish authority. |
| apps/backend/src/lib/picking-service.ts | ACCEPTED + terminal M10 + COMMITTED admission, native-line fingerprint, one picker, transactionally audited COMPLETED. Completion is physical accounting, not native fulfillment. No dispatch event or native fulfillment mutation is present. |
| milestones/MILESTONE_M13_SUBSTITUTIONS.md, executable revised section 19; marketplace/shortage-resolution.ts | Omission-only runtime; P + O = Q may complete picking. Original native quantities/reservations remain unchanged. No replacement inventory patch. Earlier automatic fulfillment/dispatch limitation is not superseded by an implemented fulfillment bridge. |
| marketplace/models/delivery-reservation.ts; delivery-reservation-repository.ts | COMMITTED scheduling capacity does not expire merely because the original HELD expiry passes. payment_accepted_at and native Order binding are retained. Reuse clock_timestamp and slot-lock conventions where relevant. |
| marketplace/models/delivery-option.ts; lib/scheduling-native.ts; lib/location-service.ts | ASAP/SCHEDULED delivery options refer to native Shipping Options; Stock Location → shipping Fulfillment Set → native Service Zone topology exists. These modes are not driver dispatch modes. |
| marketplace/models/merchant-store.ts | One store per merchant; address and native location/fulfillment references. No dispatch mode and no authoritative store latitude/longitude. |
| marketplace/models/service-zone.ts; marketplace/location-policy.ts; lib/location-service.ts | GoSpaza polygon/multipolygon geometry and active store-zone mapping own geographic serviceability. Reuse geometryService; native country geo zones alone are too coarse for dispatch admission. |
| marketplace/checkout-policy.ts | Frozen checkout address text/IDs and native commercial references exist. Coordinates are retained on the exact M9 reservation, not in CheckoutSnapshot. Do not substitute a subsequently edited customer address. |
| marketplace/driver-service.ts; driver-policy.ts; lib/driver-auth.ts | Native DRIVER auth identity → immutable DriverProfile binding, without auth metadata driver IDs. Persistent eligibility is profile ACTIVE + affiliation ACTIVE + valid native identity + active target store; MERCHANT requires exact merchant/store match. PLATFORM has no geographical admission rule yet. |
| DriverService.withEligibility | Discovers affected merchants, locks merchant IDs in sorted order, then profile and current affiliation; revalidates observed affiliation and exposes a transaction callback. A preliminary eligibility read is not a commitment. |
| marketplace/merchant-authorization.ts; team-policy.ts | M4 merchant row lock then current membership/capability. OWNER/MANAGER have order and driver-read capabilities; PICKER does not have general order/driver-read access. |
| apps/driver/app/page.tsx; packages/contracts/src/drivers.ts; packages/api-client/src/drivers.ts | Onboarding/profile/affiliation surfaces and credentialed actor clients exist. No online/location/offer/assignment implementation. Reuse their authentication, refresh and safe-error patterns. |
| apps/backend/medusa-config.ts | Pinned manual fulfillment provider, Redis event bus, Redis workflow engine, configured worker mode. No dispatch worker exists. |
| Application source inspection | No implemented MERCHANT_ONLY/PLATFORM_ONLY/HYBRID dispatch policy, native cancelOrderWorkflow call, or createOrderFulfillmentWorkflow call found outside verification/migrations. This is not a claim that native Admin routes do not exist. |

### Pinned Medusa 2.18.0

Installed @medusajs/core-flows/package.json reports 2.18.0. Sources inspected under node_modules/.pnpm/@medusajs+core-flows@2.18.0_*/node_modules/@medusajs/core-flows/dist:

- order/workflows/create-fulfillment.js: createOrderFulfillmentWorkflow validates native Order/items; creates fulfillment through its provider; registers fulfillment against Order; links Order/Fulfillment; adjusts inventory and updates/deletes native reservations. It sets packed_at. It is not an assignment-only operation.
- order/workflows/create-shipment.js: createOrderShipmentWorkflow marks shipment through native fulfillment and registers native Order shipment quantities. It is not a driver offer/acceptance abstraction.
- @medusajs/fulfillment 2.18.0 dist/models/fulfillment.js: owns packed/shipped/delivered/canceled timestamps, provider, shipping option, delivery address, items and labels. No GoSpaza driver identity, eligibility, offer or single-driver capacity authority exists there.

Decision: native/configuration alone does not represent marketplace dispatch. Add small linked operational state; do not store driver assignment as authoritative native metadata. Create no native Fulfillment in M15. M16 must design the supported native fulfillment/shipment boundary at pickup, including omission handling and crash recovery before making those mutations. A native fulfillment ID is not an M15 assignment ID.

## 2. Authoritative model

Keep the new operational domain in the existing modular monolith and Marketplace persistence/transaction boundary, with a distinct delivery service/repository contract. This allows atomic composition with current M14/M11 locks without introducing a deployed service or cross-module transaction fiction.

Proposed records:

1. DeliveryOperation: database-unique order_operation_id and native medusa_order_id; validated merchant/store binding; references to completed picking evidence, exact committed reservation and delivery zone; status, revision, dispatch generation, policy revision, phase, due/deadline timestamps and bounded safe reason code. Native Order link follows the existing read-only OrderOperation link pattern. Do not duplicate amounts, payment state, Order items or mutable customer address.
2. DriverAvailability: unique DriverProfile reference, desired ONLINE/OFFLINE, availability revision/generation, online_since and explicit online authorization evidence. No stored BUSY boolean. No coordinates in PostgreSQL.
3. DispatchCommitment: one durable offer that may become the assignment. delivery_id, driver_profile_id, generation, MERCHANT/PLATFORM path, M14 affiliation reference/revisions, offer expiry, response/assignment timestamps and terminal reason. States OFFERED → ASSIGNED or DECLINED/EXPIRED/CANCELLED; ASSIGNED remains occupied until a later explicit supported release. One table owns both offer reservation and assignment capacity; do not implement two independent uniqueness constraints on separate offer/assignment tables that allow cross-table overlap.
4. Append-oriented DeliveryEvent/availability decision evidence using existing audit conventions: actor/system identity, target, scope, prior/result state, revision, safe reason and DB timestamp. No coordinate history or raw address/provider payload dumps.
5. Small durable dispatch cursor/due-work state for bounded repair. This is operational scheduling, not a second queue as a source of truth.

Foreign keys/composite scope constraints enforce same OrderOperation/store/merchant and valid DriverProfile references. Unique active DispatchCommitment per driver AND per delivery where state in OFFERED/ASSIGNED. Unique delivery/order survives archive; no delete-and-recreate reset. Migration owns partial indexes/checks where model DSL is insufficient. Deferred consistency checks must keep delivery current commitment/status and commitment state coherent in one transaction. Do not use a time-dependent now() index predicate: expired offers must be explicitly closed under locks before reuse.

M16 may extend the same assignment lifecycle later. M15 does not expose arbitrary release/reassign or manufacture delivery completion.

## 3. Single readiness owner

Expose transaction-aware handoffs through current owners, especially M11 order authority and M12/M13 completed physical accounting. Do not duplicate private PickingService.load rules in a new route.

Proposed is_order_dispatch_ready(order) returns a typed reason/result, not a browser flag. It requires:

- successful durable M10 terminal receipt, CheckoutAttempt COMPLETED and exact authoritative native Order;
- native readback remains consistent and not canceled, with expected native shipping method/Shipping Option;
- owning OrderOperation ACCEPTED, never PENDING_ACCEPTANCE or REJECTED;
- immutable COMPLETED PickSession, valid completion audit/native-line fingerprint and no unresolved shortage/recovery;
- exact reservation COMMITTED and bound to that Order/store, with retained destination coordinates and service-zone mapping;
- delivery method is the existing shipping-delivery topology, not inferred from a shipping label or browser input;
- valid active store/merchant, active authoritative destination zone/mapping and retained destination contained in that zone;
- approved store dispatch configuration; scheduled dispatch not-before reached;
- physically deliverable original items; current proposed admission excludes ANY terminal omission until a separately approved fulfillment bridge permits it;
- no canceled/attention-blocked operational delivery and no incompatible native fulfillment/shipment discovered.

COMMITTED is not tested against old HELD expires_at. Do not reprice a paid order against later fees. Configuration/service-area drift yields an operational hold, not automatic financial cancellation, changed address or release of M9 capacity.

Recommendation for scheduled orders: no dispatch earlier than the reserved window start; past window end becomes attention-required, not automatic cancellation. ASAP may dispatch once physical readiness is true. A lead time or continued dispatch after the window is a product decision in section 18, not an inferred ETA.

M13 limitation: partial omissions and all-omitted completion are physically resolved but not automatically dispatch-ready under the existing contract. Retain visible readiness reason FULFILLMENT_BRIDGE_REQUIRED / NO_PHYSICAL_ITEMS. No fake picked quantities or native Order edits. This limits launch coverage and needs explicit product acknowledgement.

## 4. Delivery lifecycle and M16 boundary

- PENDING_DISPATCH: durable ready-order record, possibly waiting for approved scheduled not-before.
- SEARCHING: bounded dispatch cycle active, no current offer/assignment.
- OFFERED: exactly one live commitment to one driver.
- ASSIGNED: accepted commitment, one driver occupied. M15 normal successful terminal boundary.
- ATTENTION_REQUIRED: exhausted cycle, missing policy/evidence or safety/infrastructure issue; safe reason retained. If an assignment exists it remains occupied; status alone never releases it.
- CANCELLED: proven operational cancellation before assignment, with live offer canceled atomically. Not a native cancellation or financial result.

One-way normal transitions and revision-checked explicit recovery only; no generic edit status. SEARCHING ↔ OFFERED only within a bounded generation. Terminal offer history is retained. Do not automatically restart exhausted generations indefinitely. A later platform recovery contract may authorize redispatch; M23 UI is out of scope. Infrastructure work can resume the same uncommitted generation after durable readback, never replay an unknown assignment blindly.

## 5. Dynamic availability and location

Effective AVAILABLE = desired ONLINE + fresh authenticated presence/location lease + current M14 eligibility for target + no active DispatchCommitment. OFFERED reserves capacity; ASSIGNED derives BUSY. INELIGIBLE/STALE/OFFLINE are safe projected reasons, not replacement M14 lifecycle states.

Online/offline commands bind only to authenticated DriverProfile. Explicit online establishes a new availability generation and M14 revision evidence; React reload does not silently go online. Offline blocks new offers and cancels an outstanding unaccepted offer under the same lock protocol. Offline during ASSIGNED changes desire only: retain assignment/load and display it. Suspension/revocation invalidates candidacy and outstanding acceptance; reactivation must require explicit online again rather than reviving a stale lease. An already assigned ineligible driver triggers attention and keeps occupied capacity pending controlled recovery.

Session expiry is not synchronously observable from a closed browser. Require authenticated renewal; when renewal stops, bounded freshness expiry blocks new commitments. Logout should request offline when possible but correctness must not depend on it. Existing assignment never disappears on logout/session expiry.

Latest location resides in Redis with TTL: latitude, longitude, optional accuracy, server received_at, server-issued availability generation and monotonic sequence. Validate coordinate ranges using existing location owner; reject old generations/sequences and arbitrary recorded_at as freshness authority. Serialize generation admission against DriverAvailability; atomically compare/update the Redis generation/sequence. Offline/re-online invalidates older writes even if Redis cleanup fails. No high-frequency PostgreSQL writes or location history.

Proposed defaults for approval: foreground refresh about 30 seconds, maximum age 120 seconds, latest-location TTL 120 seconds, reject supplied accuracy worse than 100 metres. Missing/denied/stale location or Redis failure makes driver unavailable for NEW offers/acceptance. Browser timestamps cannot extend freshness. Recheck current generation/freshness while commitment locks are held, using fresh DB time; a Redis sample is a bounded observation, not a PostgreSQL transaction participant. Location can become stale after assignment without undoing assignment.

Device GPS is untrusted evidence: schema, sequence and timestamps prevent stale protocol replay, not a malicious device fabricating coordinates. Do not claim fraud-proof geolocation; M25 device abuse/attestation is residual risk.

Privacy: driver may read own latest point/freshness; dispatch reads it internally. No customer location access in M15. Merchant sees assignment/status and necessary driver identity/contact, not coordinates. Do not add platform location browsing without a specific scoped capability/audit requirement; existing driver review permission alone is not blanket location access. TTL deletion and no logs/history minimize retention. Destination details should not be exposed to candidate lists or unaccepted offers; store pickup address and coarse service area suffice in M15. M16 authorizes exact delivery destination access for assigned execution.

## 6. Mode and candidate policy

Store-level dispatch configuration is authoritative and separate from M9 ASAP/SCHEDULED. Fields: enabled, MERCHANT_ONLY/PLATFORM_ONLY/HYBRID, revision, bounded approved policy settings. Initially disabled/unconfigured; no implicit HYBRID for old stores. A narrow platform-user configuration API may establish mode using existing native platform authentication, strict input, expected revision, reason and audit; no generic admin override or driver/merchant-chosen mode. Freeze policy version for the cycle; safety disablement takes effect immediately. Mode change must not reroute an existing assigned delivery.

Every candidate: M14 current persistent eligibility; exact correct affiliation path; ONLINE generation/current lease; fresh valid location; no active offer/assignment; target service-area admission. Re-evaluate at offer publication and acceptance, not merely discovery.

Proposed geographic admission: latest driver point must be in the exact active GoSpaza zone retained by the order's committed reservation; use geometryService and the authoritative store-zone relationship. This is conservative and can exclude a driver at a store outside that polygon. Product approval is required; do not infer store coordinates or introduce routing APIs. No independent permanent driver-zone membership model in M15.

Within each pool rank by oldest server-established available_since (reset on explicit online and legitimate capacity release), then stable DriverProfile ID. Revalidate a bounded candidate page rather than keeping a process-local list. No distance/ETA ranking until authoritative store coordinates and its policy are approved. No driver earnings/fairness guarantees beyond deterministic ordering.

- MERCHANT_ONLY: only ACTIVE MERCHANT affiliation to exact store/merchant, never platform fallback.
- PLATFORM_ONLY: only ACTIVE PLATFORM affiliation, never another store's merchant driver.
- HYBRID: sequential merchant phase first. Try available merchant candidates without repeating a declined/expired candidate in the same generation. Switch to PLATFORM on merchant exhaustion or bounded merchant-phase deadline. No waiting when the merchant pool is empty. Persist the one-way fallback and audit it; do not oscillate back if a merchant driver later appears.

Proposed bounds: 45-second offer expiry, 180-second merchant phase, 600-second total cycle, at most 10 offers total. Expiry is min(offer duration, phase deadline, cycle deadline). Bounds are versioned, validated settings requiring approval; all-offers-exhausted or budget-exhausted becomes ATTENTION_REQUIRED. A bounded page must not falsely mean whole-pool exhaustion: persist scan progress, distinguish no candidates from search-budget exhaustion, and expose the correct reason. No public first-come claim or broadcast fan-out.

## 7. Offer decision

Use automatic sequential offer → explicit accept/decline, not direct assignment. This follows the approved offer-based product direction, respects driver agency and makes timeouts/fallback explicit. One live offer per delivery and driver.

Accept body: expected commitment revision only (plus explicit confirmation if UI contract requires it); IDs select, never authorize. Recheck actor binding, live offer ownership, availability, M14, readiness and fresh DB deadline. now >= expires_at rejects. Accept atomically converts the SAME occupied commitment to ASSIGNED and records delivery revision/audit. No gap releasing and recreating driver capacity. Same accepted request returns original assignment after authorization; conflicting/expired/canceled decisions cannot revive it. Decline closes only own current offer and advances due search; never cancels an assignment.

## 8. Locks, races and transaction proof

Common order for paths touching these resources:

1. Discover IDs without locking, solely to plan lock acquisition.
2. Lock all affected merchant rows in lexical order (target + observed affiliation merchant), as M14 does. Revalidate scope/generation; changed identity conflicts and may be rediscovered as a new safe pre-mutation operation.
3. DriverProfile → current DriverAffiliation → DriverAvailability, each deterministic ID order if more than one (normal flow touches one driver).
4. OrderOperation → PickSession and required line/evidence rows in existing native-line order → DeliveryOperation.
5. Current DispatchCommitment; affected rows in deterministic ID order.
6. If current geographic/configuration state requires serialization, lock the owning rows in one documented suffix order, read fresh database time, then atomically write dispatch state/audit. No M9 capacity mutation or native commerce mutation in this transaction.

M14.withEligibility owns a transaction. Extend/expose its transaction-aware owner contract if necessary, preserving existing callers, so readiness can join the SAME transaction. Never lock delivery then call a second withEligibility transaction. A path that does not need driver locks may skip them, but must never later acquire an earlier lock. Repair discovers work without holding delivery row locks across acquisition of merchant/profile locks. Do not keep a SKIP LOCKED delivery transaction open while calling the public mutation service in another transaction.

M14 mutations stop at merchant/profile/affiliation. M11/M12 start merchant then order/picking and never take a driver lock afterward. Thus M15 cannot form a reverse order→profile dependency. Location/zone configuration writers must be checked for reverse lock acquisition before B merges; reuse owner APIs, not cross-domain write shortcuts. M9 customer/config/slot locks are not entered by dispatch; committed capacity is read evidence only.

Unique active commitments are the final guard even if candidate discovery races. On conflict, reread authoritative state; do not blindly replay a workflow. A driver with an expired OFFERED row cannot be reused until an authorized expiry transaction closes it. Each logical decision plus event commits in one PostgreSQL transaction; disconnect before commit rolls back, lost response after commit reads original receipt. No external payable/native side effect participates.

Required race outcomes:

| Race | Required outcome |
|---|---|
| Two deliveries choose one driver | One active commitment; loser searches another candidate or waits within its budget. |
| Two workers same delivery | One offer/current generation; duplicates converge. |
| Driver accepts two offers | Schema prevents two active offers; at most one assignment. |
| Accept vs expiry/decline/offline | Shared locks + fresh DB time decide one result; no revival. |
| Merchant expiry vs platform fallback | One phase transition and one current commitment, never both paths assigned. |
| M14 suspension/revocation vs acceptance | Shared merchant/profile locks linearize; revocation first denies, acceptance first remains assigned then attention on later invalidation. |
| Readiness lost vs offer/assignment | Current owner validation blocks commitment; supported future cancellation must use same outer protocol. |
| Worker crash after assignment commit | Same assignment recovered from DB; no second driver, no compensating delete. |

Native Admin cancellation does NOT share these custom locks. Current public actors cannot become native platform users, but a privileged native writer can still race after native readback. Do not claim globally atomic native cancellation without a shared supported boundary. M15 must detect native cancellation on reads/repair, stop new offers, quarantine assigned work, and M16 must revalidate before pickup. A proven need for strict simultaneous native cancellation serialization is a separate gate, not permission to patch native tables.

## 9. Trigger, workflow and recovery

A small idempotent dispatch workflow delegates one coherent operation to transaction-owning delivery service. Events are wake-ups only. Add durable due-work/ensure scheduling to successful M12 completion without changing its physical rules; rollback must not publish readiness. Best-effort post-commit event can improve latency. Also use bounded keyset repair over eligible completed picking receipts and due deliveries, with cursor/wrap and per-record safe failures, analogous to order-operation repair. No unbounded request scans.

Current offer/assignment GETs may reconcile their one owned record; not a global dispatch trigger. A configured Medusa worker handles due search/expiry and repairs missed events/restarts. Multiple workers are supported by row/uniqueness enforcement, not process identity. Bounded polling remains correct without push. Worker frequency must fit approved offer expiry (recommend 5-second due-work cadence, verified against pinned scheduling registration in implementation); deadlines remain DB-authoritative even if workers are late. Timer delay never extends acceptance eligibility.

Distinguish transient infrastructure unavailability from candidate exhaustion. Persist safe error/next-due/attempt evidence with bounded work; reread before retrying a pure transaction. Unknown DB outcome is read back, not compensated by deleting assignment. Long outage or cycle budget expiry produces visible ATTENTION_REQUIRED. No financial rollback, native workflow replay or automated broad admin recovery.

## 10. Cancellation and failure

No eligible driver, exhausted declines/expiry or unsafe readiness evidence must remain durable and visible. No implicit merchant-to-platform fallback outside HYBRID.

Before assignment, proven cancellation/non-dispatchability cancels live offers and stops search under common locks. Invalid evidence/infrastructure failure is ATTENTION_REQUIRED rather than a claim of cancellation. After assignment, retain commitment/load, mark attention and forbid further progression; no automatic reassignment/release when custody is uncertain. Offline/suspension cannot orphan work. Future M16/M18 must explicitly establish safe release semantics.

M11 rejection cannot follow ACCEPTED, so it cannot normally race an eligible M15 delivery; pending/rejected never qualify. M15 does not release COMMITTED M9 capacity, cancel native Orders, refund, delete inventory reservations or claim financial resolution. Rejected-order capacity release remains exclusively M11.

## 11. API/RBAC/projections proposed for B/C

| Family | Minimum surface and authority |
|---|---|
| Driver | GET /driver/availability; POST /driver/availability/online and /offline; PUT /driver/location; GET /driver/dispatch/current; POST /driver/offers/:id/accept and /decline. M14 native DRIVER session/profile binding, strict schemas, revisions, own-resource predicates. No body driver_id/merchant/store/mode/status/timestamps/load. |
| Merchant | GET /merchant/orders/:id/delivery using existing MERCHANT_ORDER_VIEW (OWNER/MANAGER). Tenant predicate before lookup/projection. PICKER gains no generic delivery/driver browse capability; M16 may add a minimal pickup-purpose projection later. No manual assignment. |
| Customer | GET /store/gospaza/orders/:id/delivery or bounded existing Order projection extension, native authenticated customer ownership. Preparing/finding driver/assigned/delayed only; no location or candidate IDs. |
| Platform | Narrow audited store dispatch configuration command under existing native platform authentication; no manual driver assignment/release/recovery UI. No new latest-location feed. |

Own driver current-offer view exposes expiry and store pickup context/coarse destination area; own assignment adds only necessary operational identity. Merchant assigned-driver DTO may expose display name/contact needed for pickup; never auth identity, historical affiliations, coordinates or unrelated assignments. Customer projection cannot claim picked-up/in-transit/delivered. All lists bounded, status bodies customer-safe, foreign IDs unavailable without existence disclosure.

Use shared contracts/API-client; no component calls to native fulfillment, Order mutation or driver lifecycle bypass. Rate-limit availability/location/decision operations by authenticated actor (and unauthenticated abuse at boundary), bound body/page sizes and reject extra fields. CSRF/origin/session protections follow existing driver/merchant boundaries.

## 12. Security data flows and required executable evidence

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Required tests |
|---|---|
| Driver cookie + offer ID → native actor/profile binding + strict input → own commitment + current eligibility/locks → assignment | Foreign/guessed ID, wrong actor, revoked/suspended/native identity unavailable, replay, mass assignment. |
| Merchant cookie + Order ID → M4 membership/capability → tenant-scoped M11 handoff → delivery projection | Foreign known Order/delivery IDs, PICKER denial, removed member, bounded enumeration. |
| Customer Order ID → native owner + terminal M10 link → customer projection → minimal status | Cross-customer IDs, incomplete/late-compensated Order, no coordinates/driver secrets. |
| Location payload → range/accuracy/sequence/generation validation → authenticated profile + lease → Redis latest point and candidate admission | Old generation, out-of-order sample, forged timestamp/driver ID, invalid coordinates, stale Redis, Redis outage, no log/history leakage. GPS fabrication remains residual risk. |
| Candidate IDs/event → owner readiness and M14 reread → common DB locks/unique commitment → offer/assignment/audit | Duplicate trigger/workers, two orders/one driver, accept/expiry/offline/revocation/fallback races, crash before/after commit. |
| Platform mode command → explicit platform auth + revision/enum → store configuration → cycle policy | Merchant/driver forgery, unsupported mode, stale config, disabled dispatch, no retroactive assigned rebinding. |

No confirmed new vulnerability is asserted by this reconnaissance. These are credible proposed trust boundaries and required tests, not already proven implementation guarantees. Native privileged cancellation concurrency and self-reported GPS are explicit design limitations.

## 13. M16 handoff

M16 may trust only a current database-validated ASSIGNED commitment and delivery identity, authoritative OrderOperation/store relationship, completed picking reference, assigned DriverProfile/affiliation reference, dispatch mode/path/policy revision, assignment timestamp/revision and audit receipt. Recheck active assignment, actor and safety state at every M16 action; historical assignment is not indefinite authority.

M16 owns pickup readiness/confirmation, native fulfillment/shipment integration, in-transit tracking, grocery OTP and delivered completion. It must not infer physical line quantities from unchanged native ordered quantities when M13 omissions exist. It must establish when driver load is released. No M16 endpoints/states/OTP or live customer maps are implemented here. M17 recipient verification and M18 finance remain separate.

## 14. Slice boundaries

- M15-A: this reconnaissance/contract only. Resolve section 18 before B.
- M15-B: delivery/readiness owner contracts, models/migrations/constraints, store configuration, availability/latest-location boundary, commitment decision APIs, shared transaction/eligibility composition, audit and focused real-DB/API tests. Pure policy/transition foundation; no automatic live dispatch activation or UI.
- M15-C: bounded candidate workflow, due-work/repair integration, sequential merchant-first fallback, driver online/location/offer/assignment UX, tenant-safe merchant/customer status projections, shared clients/contracts and browser tests. Preserve B tests. No native fulfillment or manual dispatch UI.
- M15-D: whole-system acceptance/security/concurrency/crash/regression and operational configuration review; smallest proven fixes only.

B must include offer capacity/acceptance primitives so C cannot invent a second locking boundary. If implementation requires splitting B into storage/eligibility and command/concurrency sub-slices, obtain explicit scope approval first. No speculative work beyond the requested slice.

## 15. Acceptance matrix for later slices

- One authoritative deliverable Order → one DeliveryOperation; duplicate ensure/event/restart and bounded read repair.
- M10 partial/recovery/late payment, rejected/pending Order, incomplete picking, unresolved/omitted/all-omitted work, wrong shipping method, missing/changed zone evidence excluded with truthful reason.
- MERCHANT_ONLY never platform; PLATFORM_ONLY never merchant; HYBRID phase timeout/exhaustion and one-way fallback.
- Exact affiliation + geometry admission + desired online + fresh lease + no occupied driver; no distance inference.
- Real concurrent HTTP/DB: two orders one driver; duplicate workers; accept/decline/expiry; offline vs offer; revoke/suspend vs accept; fallback vs stale accept; lost response after commit.
- Database insertion/constraint tests prove cross-table coherence and single active commitment, not just application if statements.
- Native Order/payment/inventory/reservations/Fulfillment baseline unchanged by all M15 actions.
- Redis restart/stale samples fail closed for new work without losing active assignments; delayed worker cannot extend offer.
- Hostile actor/known IDs/body fields; safe projections, rate limits and no sensitive logs/location history.
- Browser reload restores current offer/assignment; focus refresh never accepts automatically; expiry display never authorizes acceptance; offline preserves assignment; location denial and auth loss are explicit; actual merchant/customer isolation.
- Recovery uses durable state and original receipts; events missed or replayed cannot create a second assignment.

## 16. Verification and commands

M15-A changes documentation only. No runtime tests are necessary for this slice and no commands were run. Review this contract and approve/resolve section 18. Do not run migrations/builds merely to validate a Markdown contract.

B/C/D must add exact user-run commands only after scripts/configs exist. Group cheap static checks without Next dev servers, backend-only real-DB/API/concurrency verification with backend/DB/Redis, and required browser stack separately. Preserve existing M9–M14 regressions. Never claim future tests passed or invent a test:dispatch script before it exists.

## 17. Deferred risks

M16: native fulfillment crash recovery, omission-aware physical mapping, custody and release. M17: restricted/alcohol driver/handoff eligibility; M15 must not pretend M14 supplies that qualification. Until a restrictive-order dispatch policy is approved, fail closed for an order known to require unsupported restricted delivery; detection must reuse authoritative catalogue/compliance evidence, not driver/browser claims. M18: omission/cancellation financial resolution and retained native inventory. M23: controlled operational rescue/redispatch tooling and finer platform location permissions. M25: GPS spoofing/attestation, precise retention policy, worker throughput/fairness, platform-driver lock contention, Redis availability, native Auth deletion gap and privileged native cancellation coordination. No severity inflation or claim of fraud-proof location.

## 18. Approval gates and readiness for M15-B

No native Medusa blocker prevents an operational-only delivery/offer model. M15-B is architecturally feasible, but not ready to implement unresolved business assumptions silently. Confirm:

1. Omission gate: exclude all M13-omission Orders until an approved fulfillment bridge, including partial omissions, or authorize a separate bounded design for dispatching physically present goods. Do not implement that bridge implicitly in B.
2. Geographic admission: exact destination service-zone containment for both driver pools, acknowledging stores/drivers outside that polygon; alternative store catchment needs explicit data/policy.
3. Scheduled timing: recommended not-before slot start and attention after window end; approve an alternative lead time/late-window policy if needed.
4. Operational numbers: approve proposed refresh/freshness/accuracy, 45-second offer, 180-second merchant phase, 600-second total and 10-offer budget, with validated configuration rather than magic constants.
5. Store mode ownership: platform-controlled, explicit configuration and disabled by default; no merchant manual dispatch authority.
6. Restricted-order admission: establish a trustworthy existing classification and approved dispatch policy or exclude unsupported restricted Orders. Do not invent M17 qualification now.

Other recommended architectural choices need no speculative extension: one active delivery/offer per driver, one sequential offer, BUSY derived, no store-distance ranking, no native fulfillment in M15, atomic assignment/audit and durable attention rather than orphaning work.

M15-A complete as a document and static investigation. M15-B not started; no commit.

## 19. Approved M15-B policy — supersedes conflicting M15-A recommendations

M15-A approved. M15-B only is authorized. Terminal M13 omissions are valid completed physical accounting (P+O=Q), including all-omitted accounting; preserve financial_review_required and make no financial claim. Restricted content does not exclude dispatch: derive requires_age_verification from authoritative native Order product ownership/profile evidence and carry only restricted_content_present. M17 compliance remains out of scope.

One occupied OFFERED/ASSIGNED commitment per driver and delivery; BUSY derived. MERCHANT admission requires current matching ACTIVE affiliation plus fresh location, with no polygon test. PLATFORM additionally requires current point inside the exact order ServiceZone. No distance ranking/store coordinates/maps. Redis loss never deletes a commitment. Online creates a new generation; numeric location and sequence validation cannot prove physical GPS authenticity.

Central configurable defaults: freshness 120s; offer 30s; merchant phase 120s; total generation 300s; scheduled lead 1800s. ASAP ready immediately; scheduled not-before slot start minus lead. No automatic rejection at slot end was approved; lateness alone does not invalidate COMMITTED capacity. Rank available_since then driver ID. No repeated candidate per delivery/generation. One-way HYBRID fallback on merchant exhaustion/deadline, never indefinite restart. Offers clamp to generation and merchant-phase deadline. Exhaustion/deadline becomes ATTENTION_REQUIRED.

Platform controls store mode DISABLED (including unconfigured), MERCHANT_ONLY, PLATFORM_ONLY, HYBRID. Merchant/customer/driver cannot set it. No UI or public dispatch trigger in B. Domain creation, generation/offer primitives, accept/decline, availability/location and configuration APIs are in B; actual candidate-search worker/orchestration/UX are C. No native fulfillment/inventory/payment mutations. The prior omission, restrictive-order, exact-zone-for-merchant, slot-start-only, numeric timing and max-ten-offer proposals are superseded. No fixed offer-count limit substitutes for the approved time/exhaustion horizon.

## 20. M15-B implementation and verification handoff

The B implementation, exact API families, PostgreSQL constraints/lock order, Redis privacy boundary, focused coverage and user-run commands are recorded in [M15_B_IMPLEMENTATION.md](M15_B_IMPLEMENTATION.md). Section 19 is the current approved policy; earlier recommendations/approval gates are retained as reconnaissance history, not unresolved authorization.

M15-B is prepared for user verification, not runtime-verified. No M15-C worker/UI or commit is included. Native Medusa remains the commercial owner. In particular, latest coordinates bypass workflow persistence, and one PostgreSQL commitment is the sole driver-load authority.

## 21. Approved M15-C orchestration and UX contract

This section supersedes the historical B-only authorization/status above. The user verified M9/M10/M15-B after the explicit M9 shipping synchronization fixture correction. Preserve that correction and the DELIVERY_CONFIGURATION_STALE check unchanged.

Empty pools exhaust deterministically; there is no wait for future online drivers. HYBRID moves once from exhausted merchant candidates to platform candidates. Exhausted final pools enter ATTENTION_REQUIRED. A partial bounded candidate page is not exhaustion. Search retains B's 300-second generation, 120-second merchant phase and 30-second offer limits, with server configuration authoritative.

`dispatch_work` is a durable observation schedule, not another commitment/capacity owner. It stores next_due_at, scan offset, observed delivery revision and a bounded observation error. `dispatch_repair_cursor` sweeps 25 completed picking records per pass, wraps, and calls the same authoritative ensure service. Discovery joins Picking/OrderOperation only to locate candidates; B's owner handoffs remain mandatory before provisioning. This limited cross-domain read follows the existing OrderOperation repair pattern.

The worker processes at most 25 due deliveries per tick, with four 50-row candidate pages per delivery. A continuation persists its scan position and observed revision. Five-second observation scheduling does not extend offer/phase/generation deadlines. Active assignments are safety-checked once per minute; ATTENTION_REQUIRED is not automatically restarted. PostgreSQL row locks with SKIP LOCKED prevent duplicate workers from owning the same due observation concurrently; B's merchant/profile/delivery locks and partial unique indexes remain the business correctness boundary.

The pinned Medusa 2.18.0 JobLoader registers jobs as scheduled workflows; its BullMQ/cron-parser installation supports the six-field seconds schedule. `DISPATCH_WORKER_ENABLED=true` explicitly enables automatic work. Default/absent is disabled. Set it only on intended workers after migration; isolated verification requires it disabled. No process-memory timer owns dispatch progression.

Successful picking workflow completion emits `gospaza.picking.completed` only after the transaction returns. The subscriber is an acceleration hint and calls idempotent ensure. Emission failure never rolls back physical evidence; bounded repair discovers missed events/direct-service completions. A crash after an offer commit but before scheduler update re-observes the existing commitment. No acceptance replay or compensating capacity deletion occurs.

One bounded integration correction is necessary: generation-zero PENDING_DISPATCH may become terminal ATTENTION_REQUIRED for disabled configuration or lost readiness. This records the failure without fabricating a search generation. Scheduled waiting alone remains PENDING_DISPATCH. No new dispatch lifecycle or commercial state is introduced.

Driver UI separates M14 eligibility, online intent, location freshness and occupied commitment. Explicit location sharing uses device geolocation; coordinates stay out of browser storage and workflow history. Own location sequence readback supports reload after sample expiry; the Redis fence still rejects old generations/sequences. Redis fence loss requires explicit offline/online to establish a fresh generation. Own sample expiry is presentation information only; backend freshness checks still authorize every commitment.

Driver observation polls at five seconds for at most five minutes while online/offered, with focus/manual refresh. Merchant/customer searching status polls at ten seconds for at most five minutes. Polling never decides, expires, releases or renews a commitment. Driver decisions use one POST followed by authoritative readback; unresolved requests disable duplicate actions. Countdown expiry may disable a button but never authorizes an acceptance.

Driver offers/assignments expose store name and coarse ServiceZone name only, plus restricted-content warning. Exact destination/pickup execution remains M16. Merchant delivery reads use M11 OWNER/MANAGER order authority and may expose assigned driver name/contact. Customer reads use M11 authenticated native Order ownership and return only PREPARING/FINDING_DRIVER/ASSIGNED/ATTENTION_REQUIRED. No merchant/customer coordinates, driver candidate lists, dispatch controls, internal reasons or refund claims.

Implementation, security boundaries, coverage and runtime-grouped verification commands are recorded in [M15_C_IMPLEMENTATION.md](M15_C_IMPLEMENTATION.md). M15-D/M16 are not authorized by this section.
