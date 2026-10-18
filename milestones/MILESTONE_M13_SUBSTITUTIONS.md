# M13 — Shortage Resolution & Substitution-Policy Groundwork

## Status and scope — current authoritative revision

The user has explicitly revised M13 MVP to omission-only shortage resolution. Actual replacement substitutions and the proposed shared Inventory compatibility work are deferred. No Medusa Inventory/workflow patch is authorized in M13.

**Section 19 is the current executable contract and takes precedence over conflicting earlier sections.** Sections 1–18 remain intact as historical reconnaissance, prior approved design and deferred replacement evidence; their replacement APIs, states, inventory gates and earlier implementation authorizations do not authorize current work. Revised M13-B is approved for implementation; M13-C is not authorized.

Current slices:
- M13-B: shortage-resolution domain/APIs and customer omission decisions, with the narrow M12 completion bridge.
- M13-C: merchant/customer shortage-resolution UX.
- M13-D: acceptance/security/regression.

Replacement substitutions are not required for completion of this revised M13 milestone. M18 retains all financial resolution authority. No runtime code has changed as part of this contract revision.

## 1. Inspected repository and pinned Medusa findings

Pinned installed package family: Medusa 2.18.0. Native paths below are relative to each installed package's dist directory (resolved from node_modules/.pnpm); findings are from source inspection, not runtime verification.

| Source | Finding / consequence |
| --- | --- |
| GoSpaza lib/picking-service.ts and marketplace/picking-policy.ts | Merchant-first transaction; ACCEPTED + terminal M10 handoff + COMMITTED reservation; one assignee; native-line fingerprint; absolute original picked quantity; shortage flag; session revision and append-only PickEvent. Completion currently requires every original quantity picked, no shortage. |
| Marketplace M12 migration and models pick-session/pick-line/pick-event | Database admission, immutable baseline, completion and audit constraints reinforce the service. M13 must extend the completion predicate and audit constraints explicitly, not bypass them in a new endpoint. |
| lib/order-operation-native.ts | Supported native Order/cart reads and Order–cart link check. Native variant/quantity signature must equal the frozen M10 snapshot. Native edits would invalidate this boundary and M12's line fingerprint. Do not rewrite either original snapshot to hide an edit. |
| lib/order-operations-service.ts customerDetail | Native Order query is scoped by authenticated customer before handoff/projection; customer and frozen snapshot are rechecked under merchant lock. Reuse this ownership boundary for customer decisions. |
| marketplace/merchant-authorization.ts | Post-merchant-lock active membership/capability reread is shared with team revocation. Reuse; no supervisor assignment bypass. |
| lib/catalogue-native.ts; storefront-product.ts | ProductMarketplaceProfile owns Product→Merchant; native variant→inventory topology and base ZAR price; only tracked PUBLIC_PREFIX images exposed. Storefront display price is not an Order's discounted, taxed allocation. |
| lib/discovery-service.ts; checkout-policy.ts; delivery-reservation-service.ts and models/delivery-reservation.ts | M6 owns serviceability; M10 freezes address and commercial snapshot. M9 stores server-resolved latitude/longitude on the reservation; frozen checkout validates them against the owned address. Read the linked COMMITTED reservation, not current browser location or a subsequently edited address. |
| packages/api-client/src/orders.ts, picking.ts; customer app/orders; merchant picking portal | Actor-specific clients, credentialed/no-store reads, safe errors and backend restoration. Extend these conventions, never browser-authoritative substitution state. |
| @medusajs/order models/order-item.js | Versioned OrderItem quantities include fulfillment/return/write-off counters; these are not physical picking evidence. Native OrderLineItem owns identity/unit price. Preserve original line and version references. |
| @medusajs/core-flows order/workflows/order-edit/order-edit-add-new-item.js | Adds persistent native line items, sets tax lines, creates ITEM_ADD actions, computes promotion adjustments and previews. This is not a read-only candidate quote. |
| order/workflows/order-edit/order-edit-update-item-quantity.js | Creates ITEM_UPDATE change actions, quantity differences and optional price changes; recalculates preview adjustments. |
| order/workflows/order-edit/confirm-order-edit-request.js | Confirms native change, deletes/recreates reservations for affected lines, emits reservation events, calls createOrUpdateOrderPaymentCollectionWorkflow. Multi-step native effects are not one Marketplace transaction. |
| order/steps/confirm-order-changes.js | Calls confirmOrderChange; compensation calls undoLastChange. This is versioned native history, not an immutable no-effect proposal. Compensation is not proof of crash-safe exactly-once replay. |
| order/workflows/create-or-update-order-payment-collection.js | Reads native pending_difference; can update/create/cancel eligible payment collections for positive amounts. Negative balance does not automatically refund the captured payment. M10's existing captured payment must not be repurposed for an edit. |
| order/workflows/compute-adjustments-for-preview.js | carry_over_promotions may recompute item AND shipping adjustments across the preview. Removing/replacing one item can affect other lines. A catalogue unit-price comparison cannot prove an edited total ceiling. |
| order/workflows/update-tax-lines.js | Native tax context includes address/customer/region/item tax-inclusivity; writes returned tax lines. Do not call this mutation merely to quote a proposal. |
| order/workflows/exchange/confirm-exchange-request.js | Requires inbound return and outbound items; confirms changes, requests return, conditionally reserves outbound inventory/creates return fulfillment, updates payment collection. An unpicked shortage is not a customer return. |
| cart/workflows/get-variants-and-items-with-prices.js | Supported native price calculation uses quantity, customer, region and currency; rejects missing/unpublished variants and missing prices. Does not create the Order line itself. Never supply a browser custom unit_price. |
| tax/steps/get-item-tax-lines.js | Calls Tax Module getTaxLines with server-built item/context. This step retrieves tax lines without attaching them to an Order. |
| @medusajs/utils totals/line-item/index.js | Exported getLineItemTotals uses MathBN/BigNumber, tax inclusion, adjustments and quantities. Use native total calculation, not another JavaScript tax engine. Native values can have sub-cent precision. |
| GoSpaza catalogue-policy.ts minorPrice/nativePrice; lib/checkout-native.ts checkoutMoney | Existing exact major/minor conversion rejects missing/non-finite/sub-cent/unsafe values; preserve it. Do not round silently or invent another money interpretation. |
| @medusajs/inventory models/reservation-item.js; types inventory/mutations/reservation-item.d.ts | Standalone reservation allowed: nullable line_item_id, external_id, metadata, explicit inventory/location/quantity. external_id is NOT unique; CreateReservationItemInput does not expose a caller-supplied id. |
| inventory/services/inventory-module.js | createReservationItems validates availability, creates reservations and adjusts reserved quantity in an injected native transaction. No Order/payment mutation in that method. The method alone is not proof that all competing writers share a lock. |
| core-flows cart/steps/reserve-inventory.js | Native checkout uses Locking Module execute on inventory-item IDs around reservation creation/deletion. Reuse those exact native keys/protocol, not a separate GoSpaza-only inventory mutex. |

Search of application/shared TypeScript found no implemented BEST_MATCH / CONTACT_ME / DO_NOT_SUBSTITUTE preference or substitution model. AGENTS originally defines those preferences and CONTACT_ME expiry with DO_NOT_SUBSTITUTE fallback, but the approved M13-B request explicitly overrides expiry: no automatic timeout. No M18 milestone contract exists yet. Do not claim a preference, numeric deadline or downstream financial handler already exists.

## 2. Ownership decision

Compare:
- A — native Order edits: commercially expressive but currently changes native quantities/reservations/payment-collection behavior and invalidates frozen M10/M12 readback. Repricing a preview alone is insufficient to make its confirm/compensation safe. Not recommended in M13.
- B — operational records only: preserves commercial authority but a replacement stock check is not a reservation. Cannot promise replacement inventory or future native fulfillment of that SKU. Safe only as a blocked/proposal-only interim state, not as silently completed fulfillment.
- C — bounded hybrid (approved, subject to implementation safety gates): GoSpaza owns case/proposal/consent/physical resolution; native pricing/tax provide proposal valuation and native Inventory owns a separately correlated replacement reservation. Native Order lines/totals, original inventory reservations, payment/capture, shipping and M10 receipt remain unchanged.

Custom records are operational evidence, not commercial replacement lines or a refund ledger. Follow PickSession→OrderOperation→native Order relationship; do not duplicate Order totals, customer master data or stock balances. A native replacement reservation has no counterfeit original line_item_id. Correlate it to the immutable proposal through supported external_id/metadata and the GoSpaza receipt.

M13 completion means physical work resolved. It does NOT mean native fulfillment can be created from unchanged original Order lines. A later approved fulfillment/commercial bridge must consume the original+substitution evidence without shipping missing goods or double-reserving/decrementing. Until that bridge exists, substituted/omitted lines are not eligible for automatic native fulfillment/dispatch. This limitation is explicit, not hidden behind a ready-for-pickup claim.

## 3. Minimum operational records and state

One SubstitutionCase per PickLine, database unique including retained history. It is admitted only for ACCEPTED authoritative M10 Order + IN_PROGRESS session + recorded shortage with U = native ordered Q minus original physically picked P > 0. A merely unfinished line with no recorded shortage does not automatically become a substitution case.

Case owns stable PickLine reference and current proposal pointer/revision. Proposal history is append-only in identity/value: original line/native version and fingerprint, original picked baseline, replaces_original_quantity U, candidate native variant, candidate unit quantity R, currency, native quote evidence/fingerprint, proposer identity, policy snapshot, decision actor/time and correlated reservation intent/result. No arbitrary status patch.

Separate axes avoid conflating acceptance with picking:
- Proposal decision: PROPOSED → CUSTOMER_ACCEPTED | CUSTOMER_REJECTED | SUPERSEDED.
- Physical case resolution: OPEN → REPLACEMENT_PICKED | OMITTED | ORIGINAL_PICKED.
- Native stock coordination, when necessary: prepared/dispatched/confirmed/released or RECOVERY_REQUIRED. This is an operation receipt, not a stock ledger.

Only one active proposal per case. One accepted replacement allocation per line in this bounded slice; no split across multiple replacement variants. An unanswered proposal may be superseded under revision/locks, preserving old history. Accepted/rejected decisions are not rewritten. Exact request replay returns the stored result; changing payload/action at that revision conflicts.

After explicit rejection or authoritative NO_SUBSTITUTION preference, record OMITTED for the unresolved original units with financial_review_required evidence; no subsequent automatic replacement offer. A shortage may instead be cleared by finding original goods before a terminal decision: atomically supersede an unanswered proposal and resolve ORIGINAL_PICKED via the M12 original-quantity update. Never erase shortage/proposal history. After acceptance, ordinary original-line edits that overlap its covered units are blocked; no implicit undo of customer consent.

RECOVERY_REQUIRED blocks physical completion/replacement retry for the affected case. It is not a refund status or a general admin recovery feature.

## 4. Partial quantities and completion

Keep Q and P unchanged by substitution. Example Q=5, P=3, U=2. Store coverage of the two missing ORIGINAL units separately from R, the number of REPLACEMENT variant units offered. Candidate R is a strict positive bounded whole-unit choice validated server-side; it is not a new original picked quantity.

Approved quantity policy: 1:1 compatible selling units (R=U), with equivalent fixed-weight pack size. Do not parse free-text titles as proof of compatibility. One 1kg unit may replace one compatible 1kg unit, never two 500g units. Compatibility requires validated server-owned classification; see section 14 for the current catalogue data gap.

Replacement physically_picked_quantity starts at zero and must reach R under the active assignee before REPLACEMENT_PICKED. Customer acceptance alone cannot do this. At completion each original line must have exactly one non-overlapping accounting of units:

Q = original physically picked + original units covered by fully picked accepted replacement + explicitly omitted original units.

No pending proposal, missing stock receipt, recovery state or unaccounted units. All native fingerprints and original quantities remain valid. M12 DTO must retain original picked=3 and unresolved_original=2 while separately presenting replacement/omission resolution; never report original picked=5. Extend the single authoritative M12 completion predicate AND database completion/audit constraints. No alternate complete endpoint. COMPLETED remains immutable.

An OMITTED line is physically resolved, commercially unresolved. UI says item unavailable/not supplied and financial adjustment pending review, never refunded/cancelled. Physical completion with such audited omissions is approved for M13-B.

## 5. Exact NO_TOTAL_INCREASE

Two distinct guarantees:
1. Hard commercial guarantee: M13 performs no commercial Order/payment mutation or extra charge. Native confirmed total remains T0 from the accepted M10 outcome. No new payable balance, payment session or charge. M13 does not recalculate a replacement commercial Order total.
2. Conservative proposal ceiling: replacement's complete tax-inclusive native quote C must not exceed the paid net allocation of the covered original units B. No borrowing other lines' discounts, shipping value or later refunds.

Original allocation source is the unchanged native original line total after its existing native adjustments and tax, checked against the successful M10 snapshot allocation. Reject ambiguity (e.g. repeated variant lines that cannot map unambiguously), native line/version/price/allocation changes, returns/edits, missing taxes or unsupported precision; do not fall back to catalogue price or reconstruct the frozen Order from browser state.

For whole-line net total L in integer cents, native original quantity Q, covered original quantity U:
B = floor(L * U / Q), evaluated with BigInt.
This is a conservative eligibility budget, NOT an asserted native refund entitlement. Remaining rounding cents stay with original coverage. Unique active allocation and sum covered<=Q-P prevent repeated proposals/replays from spending the budget again. Original promotion allocations stay frozen; do not rerun promotions across the native Order.

C is native server-calculated variant price for R in the Order customer/region/currency context, plus native Tax Module lines for the immutable delivery context, using exported native line-total calculation and exact existing conversion. No browser unit price, tax flag, price override or discount. Do not apply a new coupon or transfer original promotions to the replacement. Native price-list calculation may be used only through native context, never fabricated. A missing/unsupported context or sub-cent result blocks that candidate until a separately approved rounding policy exists; never relax minorPrice.

Require ZAR and C<=B. At acceptance re-read quote/candidate validity and compare its fingerprint. Changed price/tax/config requires a new proposal and customer consent, even if still cheaper; do not silently edit the accepted offer. After acceptance retain the agreed evidence; later pricing changes do not create a new charge. Zero-budget lines permit only a genuinely zero-valued valid replacement under this policy.

This does not prove a hypothetical edited Order total. Native promotion/shipping recalculation can affect unrelated lines, which is precisely why native edits are excluded. Any future commercial edit must separately enforce final native total<=T0 under native taxes/promotions and an approved financial recovery design.

## 6. Candidate eligibility and location

Resolve candidate variant→native Product→M5 ProductMarketplaceProfile→Merchant/Store server-side. Must equal the accepted Order's authoritative merchant/store, have active usable commerce topology, published nondeleted product/variant, native sale price, fixed-unit inventory topology and supported quantity. Sales Channel membership is consistency, never authorization. Original variant itself should use ordinary M12 picking, not a substitution bypass.

Reuse M6 serviceability for the Order's server-retained delivery location/zone relationship, not the customer's newly selected browser location or a mutable address record without comparison. Use validated latitude/longitude retained on the exact M10-linked COMMITTED M9 reservation; its selection stored the server-resolved point and frozen checkout checks coordinate equality. The snapshot itself contains address text/address ID, not coordinates. Missing or inconsistent retained evidence fails closed. Do not infer coordinates from a changed saved address or accept browser coordinates. Address deletion/location drift must not block customer rejection or allow a silently changed destination.

Native stock must cover R at the exact merchant Stock Location, allow_backorder=false. Proposal availability is advisory; acceptance must secure native reservation before becoming physically actionable. Physical confirmation revalidates proposal identity, stock receipt and candidate ownership/availability; drift leaves an explicit unresolved exception, not counterfeit picked goods.

Restricted goods: no non-restricted→restricted substitution. Restricted replacement candidates are excluded from M13 until the M17-compatible eligibility contract is explicitly established; do not infer recipient age from the original Order or picker judgment. Non-restricted replacement of a restricted original must not remove any existing Order compliance requirement. This scope is approved; no new identity/compliance subsystem in M13.

## 7. Customer authority and preference policy

Customer route family /store/gospaza/orders/:order_id/substitutions. Native Order ownership + authoritative handoff precede case/proposal lookup; authenticated actor type must be customer. Foreign/unknown IDs return the same inaccessible result. Use the existing customer Order authority owner, not a client-supplied customer/merchant ID.

Decision input only proposal selector, expected proposal revision and explicit accept/reject choice (or separate action endpoints). Server owns variant, quantity, quote, coverage and stock action. Same exact decision by the authorized customer is idempotent; opposite or superseded proposal conflicts. The customer may read terminal receipts after reload. No public bearer-token acceptance link, browser-local authority or generic status API.

Approved preference behavior: absent explicit preference means CONTACT_ME, with explicit customer acceptance required. There is NO automatic response timeout in M13; no expiry worker, deadline configuration or no-response omission. Pending remains pending and blocks physical completion. BEST_MATCH must not silently become automatic acceptance. Authoritative NO_SUBSTITUTION forbids replacement and permits audited omission; treat any legacy DO_NOT_SUBSTITUTE naming only through an explicit validated mapping, not raw metadata or request claims. Customer rejection does not require current catalogue/serviceability. No automatic financial action.

## 8. Native inventory and failure boundary

Supported APIs can reserve standalone replacement stock without Order edit, fulfillment, payment or deletion of original reservations. That establishes capability, not end-to-end recovery safety.

Proposed hybrid protocol:
- Persist immutable proposal/stock-operation intent before dispatch; server-generated correlation, exact native item/location/quantity, dispatch state and append-only result/audit.
- Use the same native inventory-item Locking Module keys as reserveInventoryStep (sorted/deduplicated for multiple items) and supported Inventory Module APIs. PostgreSQL continues to serialize case/decision ownership; a native distributed lock is not a replacement for that boundary.
- Never write native inventory tables or assume a GoSpaza merchant lock serializes unrelated native checkouts. Confirm shared locking/configuration and last-stock race against native checkout in B integration coverage.
- Standalone reservation has no original Order-line ID. Use supported external_id/metadata; persist returned native reservation ID and validate full correlation on readback.
- An external_id is NOT a native uniqueness/idempotency guarantee. Do not blindly rerun createReservationItems after uncertain dispatch. Read via supported native service; exactly one matching reservation may establish outcome. Missing/duplicate/conflicting evidence after dispatch fails closed RECOVERY_REQUIRED until outcome can be proven. No fabricated successful accept or manual stock decrement.
- Only confirmed native stock outcome can publish actionable CUSTOMER_ACCEPTED. Durable recorded customer intent may be pending stock confirmation; API/UI distinguish that from a completed acceptance. Stock unavailable before mutation leaves proposal unresolved, not accepted/omitted/refunded automatically.
- Controlled cancellation/supersession deletes only the specific standalone reservation proven to belong to this proposal using supported APIs. Original native reservations remain untouched. Unknown delete outcome requires readback; retain durable release receipt and never delete by broad tenant/metadata filters.
- A native side effect and Marketplace receipt are not assumed to commit atomically. Before implementation prove transaction/context or durable-dispatch/readback behavior; crash windows and compensation failures require tests. Do not copy M10 automatic-replay assumptions.

Original reservations remain retained, including physically missing units. Replacement reservation is additional and can conservatively reduce availability; this is not double-decrementing stock. Completion does not decrement stock. Future native fulfillment/financial handling must explicitly consume/release the correct reservations. Until that handoff is approved, no automatic fulfillment for substituted Orders. If the reservation recovery gate cannot be proven, B must stop rather than ship check-only stock protection or enable physical completion without secured stock.

## 9. RBAC, audit and locks

Reuse MERCHANT_PICKING_VIEW/PERFORM for substitution reads/work; OWNER/MANAGER/PICKER do not gain financial or general Order capabilities. All ordinary proposing/replacing/physical confirmation requires the current assigned active member, including OWNER/MANAGER. Supervisor management uses existing explicit reassignment first. No new silent takeover. Customer decision belongs only to native customer owner. Reassignment preserves proposal/customer receipt, increments session revision and denies old assignee.

One common transaction-aware domain boundary, not nested calls opening another merchant transaction:
1. Resolve tentative scope from authenticated actor/native owned Order.
2. Merchant row FOR UPDATE; for employee calls revalidate active membership/capability. For customer calls revalidate native customer ownership and handoff.
3. Tenant-scoped OrderOperation FOR UPDATE; ACCEPTED, terminal M10 and COMMITTED capacity.
4. PickSession FOR UPDATE; IN_PROGRESS; all relevant PickLines in native-line-ID order; native fingerprint/quantity validation.
5. Case/proposals in stable IDs; validate expected revisions, active pointer, assignee or customer; fresh DB time for audit timestamps.
6. Atomic GoSpaza transition + PickSession revision progression + append-only audit. Native stock coordination follows section 8 with explicit durable phases; no reverse native-lock→merchant-lock path or long network call assumed atomic with this transaction.

Exact implementation must preserve lock order across proposal, M12 LINE/COMPLETE/REASSIGN, customer decision. All contend on the same session boundary. Use transaction-aware owner helpers, not duplicated completion/authority rules. Persistent native intent reserves the case against conflicting writes while a stock operation is in flight; no complete or competing acceptance during that phase.

Reuse domain audit pattern: dedicated bounded substitution events with session/case/proposal, prior/result revision/state, member OR customer OR explicit validated preference-resolution system actor, original coverage, native quote fingerprint, decision/physical/release timestamp and normalized request receipt. Append events in the state transaction; retain PickEvent for session-affecting actions. No payment secrets, raw arbitrary payloads or full address. No general audit framework or financial ledger.

Required races: proposal/proposal; proposal/original shortage clear; replacement/customer decision; accept/reject; same-decision replay; stock loss/accept; complete/resolve; reassignment/proposal; revocation/proposal. Winning revision determines outcome; late callers refresh, never overwrite. Unanswered proposals remain pending; only explicit supersession or a validated decision changes them.

## 10. API and projection boundaries for B/C

Proposed paths follow existing actor families:
- GET /merchant/picking/:id/substitutions — bounded case/current proposal view.
- GET /merchant/picking/:id/lines/:line_id/substitution-candidates — bounded tenant-safe eligible catalogue query; no arbitrary URLs/filters.
- POST /merchant/picking/:id/lines/:line_id/substitution — propose with expected session revision and candidate variant selector; server derives covered units and 1:1 candidate quantity under approved policy.
- POST /merchant/picking/:id/substitutions/:case_id/replace — explicit unanswered-proposal replacement with revisions; no generic patch.
- PUT /merchant/picking/:id/substitutions/:case_id/picked — absolute replacement picked quantity + revisions; accepted/confirmed stock only.
- GET /store/gospaza/orders/:id/substitutions and POST .../:proposal_id/accept or /reject — authenticated owned Order, strict revision payload.

Exact selectors are typed/validated and always scoped. Browser cannot assign case state, coverage, money, membership, timestamps or native inventory IDs. No native edit/exchange/inventory/payment proxy. Shared contracts/API-client methods project allowlisted request fields; server schemas remain strict even for direct hostile requests.

Customer sees original ordered/picked/replaced/omitted facts separately, native original totals unchanged, proposal price evidence labelled as substitution value (not new charge), decision and financial review notice. Picker sees only required product/value/quantity/decision data, no payment diagnostics or customer PII. Safe images use M5 tracked-public filter. Reload/focus refetch authoritative state; stale/unmounted results ignored. No customer-response countdown or automatic timeout exists in M13. No auto-accept/retry after 409, no optimistic physical completion.

## 11. Financial handoff to M18

Retain original native Order/line/version and confirmed snapshot reference, original Q/P/U, native net/tax/adjustment evidence, candidate variant/R/quote and fingerprint, customer consent/rejection, actual replacement picked, omission, native reservation receipts and immutable audit references.

Record that financial review is required for omission or value difference; do not store an authoritative refundable balance, credit entitlement, settlement payable or mark refund complete. B-C is a valuation comparison, not money owed. M18 must re-read native commercial/payment/refund state and prevent duplicate compensation. M13 never calls native cancellation, refund, capture adjustment, store credit or M10 technical-compensation paths. Original and replacement history must remain identifiable after all later work.

## 12. Security traces and acceptance obligations

No new executable M13 surface exists in A; these are design/test obligations, not claims of vulnerabilities found or tests passed.

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Required proof |
| --- | --- |
| Order/line/case/proposal IDs → strict selectors + tenant/native customer ownership → actor/tenant scope → read/decision | Foreign known IDs and unknown equivalent; parent-child mismatch, customer/admin/merchant confusion, pagination isolation. |
| Candidate ID → native variant/Product/M5 owner + same Store → catalogue authority → proposal | Foreign/draft/deleted/unpriced/out-of-channel/restricted/ineligible candidates denied; browser merchant/store fields rejected. |
| Body values → strict schemas + native Q/P/U and quote → operational vs commercial authority → case/audit | Forged amount/currency/coverage/member/status/timestamps/native reservation IDs denied; negative/fraction/string/overflow quantities. |
| Catalogue price → native context/taxes + original discounted allocation → NO_TOTAL_INCREASE → proposal/accept | Discounted original vs higher display price, taxes, shipping allocations, zero value, partial quantity rounding, changed quote, repeated budget consumption, unsupported precision fail closed. |
| Merchant session → post-lock active capability + assignee → function authority → proposal/picked | Nonassignee OWNER/MANAGER/PICKER denied; explicit reassignment; revocation while waiting. |
| Customer choice → current immutable proposal + revision → consent → accept/reject | Stale/superseded/foreign proposal, exact replay, opposite replay, accept/reject and replace/accept races, indefinite unanswered state. |
| Native stock request → durable intent + supported shared lock/API/readback → inventory boundary → reservation | Two customers/orders final-stock race, lost create/delete response, duplicate dispatch, mismatched readback, no original reservation mutation. |
| Physical complete → original+replacement+omission coverage and native fingerprint → M12 terminal guard → completed session | Acceptance alone insufficient; partial replacement, pending/recovery block; original picked remains truthful; changed native line; completed mutation denied. |
| UI/URL → authenticated backend state → presentation → customer result | Reload, unanswered pending state, stale recovery, rejection not refund, no local payment/stock authority. |

Real database/API tests for state, constraints, actor/known-ID attacks and actual concurrent calls; native inventory integration rather than mocks for stock safety. Pure tests for budget/replay/input rules; browser tests for shortage5/picked3/replacement2, customer decisions, physical completion, omission wording and reload. Compare native Order/payment/shipping/original reservation snapshots before/after. Preserve M8–M12 coverage. Bound queries and payloads; no unbounded candidate scan, HTML/raw provider errors, arbitrary metadata, sleeps, retry masking or destructive cleanup.

## 13. Slice boundaries

- M13-A: this reconnaissance/contract only; inspect pinned sources and identify approval/proof gates. No runtime commands.
- M13-B: after approval/gate resolution, operational models/migrations/constraints, shared owner helpers, strict actor APIs, native quote/stock coordination, decisions/replay/concurrency/audit, narrowly extended M12 completion guards, focused real-DB/API/native inventory tests. No UI, Order edit or financial mutations. Stop if supported native coordination cannot establish the promised safety.
- M13-C: merchant assigned-picker proposal and physical controls; authenticated customer decisions/restoration; shared API-client/contracts; truthful original/replacement/omission and unresolved financial wording; focused client/browser coverage. No new business authority in components.
- M13-D: acceptance/security/regression matrix; only missing coverage/proven defect fixes. User-run commands grouped by no-dev-server static/unit/build, backend-only integration, required browser stack. No M14+ scope.

M18 owns refunds/store credit/payment reduction/cancellation and rejected-line financial resolution. M17 owns recipient alcohol verification; M15 dispatch must not infer native fulfillment readiness from M13 physical completion. No picking reassignment redesign, general notifications/chat, matching engine, finance ledger, dispatch or automatic native fulfillment here.

## 14. M13-B inspection status and gates

The approved policy refinements above are recorded before executable implementation. No M13-B application code has been enabled yet.

### Selling-unit authority: approved bounded extension

M5 product-profile.ts contains only merchant/product identity and requires_age_verification. catalogue-policy.ts accepts variant title, SKU, price and stock; create-catalogue-product.ts creates a generic Variant option using free-text titles. There is no validated selling-unit class or equivalent-pack-size field in this provisioning path. Equal labels are not proof of equivalent packs. Native product shipping weight is not automatically a selling-unit classification.

Approved by the user: add validated classification on native variants through the existing catalogue owner, and treat unclassified variants as ineligible. Never infer authoritative class/pack from titles or accept classification in a substitution request. Original-line classification provenance and candidate comparison must remain server-derived. This bounded catalogue extension is authorized within M13-B. No classification may be inferred from display titles. It has not yet been implemented while the reservation safety review remains open.

### Reservation recovery inspection

Pinned CreateReservationItemInput supports external_id, metadata and created_by but no caller-supplied reservation ID. external_id has no unique index. FilterableReservationItemProps does not expose external_id or metadata; ReservationItemDTO does expose metadata and created_by. A direct listReservationItems({ external_id }) assumption is therefore unsupported by the pinned public type.

The documented created_by field accepts any user/system identification string and is a supported exact filter. A namespaced stable operation identity can potentially use that field for bounded readback, with complete immutable correlation in metadata and independent validation of inventory item/location/quantity. This is a supported API candidate, not yet an implemented or runtime-proven safety guarantee. Do not declare the native API incapable solely because external_id cannot be filtered.

Required proof before enabling replacement picking: commit a single-dispatch operation receipt before native create; serialize competing workers with PostgreSQL; use native inventory locking keys; never issue a second create after uncertain dispatch; recover only one exact matching reservation; zero/multiple/conflicting evidence stays fail-closed. Exact replay must inspect the same operation. Do not reuse another case's reservation, mutate original Order reservations, or assume a Marketplace transaction atomically owns native writes. Tests must exercise the post-native-create/pre-receipt failure window.

The reservation safety gate remains open until the implementation and real-database tests establish these properties. No accepted replacement picking may be enabled before that point. If the supported protocol cannot prove them, stop for architectural approval.

### Other required proof

- Reuse linked COMMITTED M9 coordinates for M6 checks, including missing/corrupt location evidence.
- Reuse native read-only pricing/tax and exact existing money conversion; conservative allocation rounding only, never permissive quote conversion.
- Extend M12 service and database completion/audit guards together; keep original quantities truthful.

No commands, tests, migrations or commits were executed during this inspection. No M13-C or M18 work was started.

## 15. Reservation concurrency review — 2026-10-15

Status: inspection stopped before executable M13-B changes. No runtime reproduction or claim that an existing checkout has oversold. This is a source-backed design concern requiring an approved resolution before promising replacement stock safety under interrupted operations.

Inspected pinned 2.18.0 sources:
- backend medusa-config.ts selects locking-redis as the native default.
- core-flows/cart/steps/reserve-inventory.js calls locking.execute(inventoryItemIds, createReservationItems) without explicit execution options.
- locking-redis/dist/services/redis-lock.js execute acquires a 60-second lease by default, then awaits job() without renewal or fencing. Its timeout controls acquisition, not cancellation of the database job. The default owner is the shared '*' string.
- inventory/dist/services/inventory-module.js ensureInventoryLevels reads and checks availability; createReservationItems_ creates the reservation and writes reserved_quantity derived from the earlier level value, in a native transaction.
- inventory/dist/repositories/inventory-level.js, services/inventory-level.js, utils/apply-decorators.js, models/inventory-level.js and shipped migrations inspected: no stock admission CAS/optimistic version or reserved<=stock constraint was found to close that lease-loss window. A transaction alone does not establish serialization of the earlier read/validation.

Credible sequence to cover, not a reported runtime incident:
1. A holds the inventory key and reads the last available unit.
2. A pauses before committing beyond the Redis lease lifetime.
3. B acquires that same key and reserves the unit using native checkout.
4. A resumes with its earlier availability/quantity state. Native lease ownership is not checked before that write.

GoSpaza's single-dispatch receipt still prevents a second create for the SAME replacement operation. It does not serialize B, which is a different native checkout. Full correlation readback identifies A's reservation but is not proof that competing reservations fit available stock. Consequently created_by/metadata correlation alone does not discharge the complete replacement-reservation safety requirement.

The supported locking-postgres 2.18.0 provider was also inspected: execute uses pg_advisory_xact_lock around job(), unlike the fixed Redis lease. However it uses its own manager transaction; its connection-loss semantics and all participating callers must be reviewed. acquire/release are implemented separately using a locking table. Do not claim switching providers is already proven safe or equivalent for every existing caller.

Smallest next investigation for approval: determine a supported shared inventory-lock boundary for BOTH native checkout and M13, including database connection loss, and whether the PostgreSQL provider can supply it without altering unrelated lock behavior. Merely choosing a different provider for M13 creates two independent lock domains and is insufficient. Do not change the default provider globally, patch Medusa internals, add native-table constraints/writes, use larger lease timeouts or manually clear locks during this slice without architectural approval.

Classification approval is retained. No additional approval for that extension is needed. Reservation identity/readback support has not been rejected as impossible; the remaining issue is the shared mutation boundary. No accepted replacement or M12 completion bridge is enabled.


## 16. Approved shared inventory-lock investigation — decision C

Decision: PROVIDER CHANGE ALONE IS INSUFFICIENT. This supersedes section 15's suggestion that a global PostgreSQL switch might suffice. No reproduced overselling incident is asserted. No configuration, native source, production code or executable test changed during this investigation. M13 replacement reservation implementation remains gated.

### Pinned source evidence

All native paths below refer to installed Medusa 2.18.0 dist source, not current online documentation:
- locking/services/locking-module.js: execute/acquire/release delegate to explicit args.provider or the configured default. No inventory transaction is automatically joined.
- locking-redis/services/redis-lock.js: execute/acquire_/release and embedded Lua.
- locking-postgres/services/advisory-lock.js: execute, acquire, release, hashStringToInt. The package's shipped JS contains no automatic expired-table-lock cleanup worker.
- core-flows/cart/steps/reserve-inventory.js; reservation/steps/create-reservations.js, update-reservations.js, delete-reservations.js, delete-reservations-by-line-items.js; inventory/steps/adjust-inventory-levels.js and update-inventory-levels.js.
- core-flows/locking/steps/acquire-lock.js and release-lock.js; cart/workflows/complete-cart.js, add-to-cart.js, update-line-item-in-cart.js; line-item/workflows/delete-line-items.js.
- inventory/services/inventory-module.js and the model/filter evidence in sections 14–15.

### Redis semantics

Native reservation steps call execute without options. Its default acquisition budget is 5 seconds and acquired keys expire after 60 seconds. An explicit execute timeout also changes the lease length; it does not bound/cancel the running mutation. Acquisition retries use jittered exponential backoff (20ms initial, 1000ms maximum, factor 2 by default). Multi-key acquisition runs concurrently, not in sorted order.

No automatic lease extension, fencing token, or callback cancellation on lease loss exists in this provider. Acquisition cancellation only stops acquisition polling. After expiry another worker can acquire the same key while the original callback can resume. Finally release compares the Redis value to the default shared owner '*' and deletes it: an expired old callback can also match a successor's default-owner lock. These are source-backed interleavings, not runtime reproductions.

Explicit acquire can use an owner and expiry, but native execute does not provide renewable unique ownership to its job. A non-expiring lock would trade the lease issue for crash recovery problems; neither changing timeout nor relying on normally short operations proves safety.

### PostgreSQL semantics: two different lock mechanisms

execute hashes each string key to an unsigned 32-bit integer, calls pg_advisory_xact_lock on its own manager transaction, invokes job(), and commits/rolls back that transaction afterward. Same keys across processes serialize while that connection/transaction survives; hash collisions serialize additional unrelated keys. There is no lease expiring during an ordinary process pause. Transaction/session termination releases the advisory locks when PostgreSQL observes termination.

Its default 5-second JS timeout races lock acquisition only. It does not cancel the native job, and the source does not cancel an already queued blocking SQL lock request. Rollback can itself wait behind that request; do not promise a strict five-second wall-clock bound. Multi-key SQL calls are submitted with Promise.all in input order, without sorting. Reverse-order batches require deadlock/failure tests. Nested acquisition on a separate connection is not reentrant; a wrapper around an already-locking native step can block itself.

Crucially, the callback receives no manager/shared transaction from execute. Native Inventory persistence uses its own transaction. Loss of ONLY the advisory-lock connection can release exclusion without proving that the independent native mutation has stopped. Ordinary process-pause protection is therefore not proof of the required failure boundary. Pool sizing must allow the held lock transaction plus the native mutation's database work.

acquire/release instead INSERT/DELETE rows in the provider-owned locking table. They do not participate in the advisory-lock namespace, even for identical string keys. acquire rejects an existing null-owner or different-owner row before testing expiration. It does not reclaim an expired abandoned row for another owner. Rows survive process death. Same-owner refresh is not general expired-lock recovery. The inspected package contains no automatic cleanup path. A global switch would therefore also change native workflow cart-lock crash behavior, not just inventory exclusion. releaseAll/manual deletion is not an approved correctness mechanism.

### Topology, exact keys and participants

| Path | Lock boundary/resource | Consequence |
| --- | --- | --- |
| M10 completeCartWorkflow reserveInventoryStep | Modules.LOCKING.execute, distinct inventory_item_id strings | Same native item key for all locations; not inventory_level_id, variant, cart or Merchant ID. Default provider selected at runtime. |
| Standalone create/update/delete reservation steps and delete-by-line-items | Same execute item-ID keys; compensation uses corresponding keys | Suitable matching key identity for M13 only when using these supported workflows. Direct Inventory Module calls do not acquire this boundary automatically. Update/delete read affected reservations before acquiring the lock. |
| Native adjustInventoryLevelsStep and compensation | Same execute item-ID keys | Participates in native item exclusion. |
| Native updateInventoryLevelsStep and compensation | No Modules.LOCKING execute | M5 absolute stock updates do not join item exclusion merely because they use a native workflow. |
| Native complete-cart outer lock | acquire/release cart ID, timeout 30s, TTL 120s, no owner/provider override | Separate from item locks; affected by a default-provider change. |
| Native add/update/delete cart-line outer locks | acquire/release cart ID, timeout 2s, TTL 10s, no owner/provider override | Also affected by a global switch. Nested acquire/release steps normally skip in subworkflows unless explicitly enabled. |
| M5 catalogue stock changes | Custom merchant commerce advisory lock plus native updateInventoryLevelsWorkflow | Serializes that merchant path, not checkout item admission. Creation uses native level creation. |
| M8 cart / M10 orchestration | Custom customer-cart PostgreSQL advisory lock plus domain row locks | Different customers are intentionally independent; cannot replace shared stock exclusion. |
| M9 scheduling and M11/M12 operations | Existing custom PostgreSQL slot/configuration/merchant/operation/session locks | Not changed directly by Medusa's default locking provider. |

Native inventory steps deduplicate using Set in encounter order; neither step nor providers establishes a canonical sorted item order. Checkout and standalone reservation creation therefore use compatible identities, but identity compatibility does not resolve lease loss, independent transaction lifetime, or unlocked stock writers.

Additional native workflows reuse these inventory steps: draft-order conversion, Order edits/exchanges/claims, cancellation, fulfillment/cancel-fulfillment and return receipt. Their existence is not approval to expose them in GoSpaza. Any enabled privileged native path must be considered before claiming all inventory writers share a boundary. Current M5–M13 production scan found no GoSpaza direct reservation creation/update/deletion implementation outside native workflow usage; direct reservation fixture creation/cleanup exists in verification scripts and must remain isolated. M13 reservation code is not enabled.

Changing the default affects every Modules.LOCKING call without a provider override in all app/worker processes. It does not replace Redis workflow execution persistence or the Redis event bus; those are separately configured modules. Payment-session creation itself is not an inventory-locking workflow. M10 native completion and any invoked inventory compensation inherit the changed native lock behavior. Worker configuration must be consistent; mixed Redis/PostgreSQL defaults create separate competing lock domains.

### Independent uncertain-outcome recovery

A bounded supported recovery protocol remains plausible, independently of the unresolved stock gate: persist an immutable operation identity and at-most-one dispatch receipt before native create; use a namespaced created_by system identity (supported exact filter) plus immutable metadata; read at most two matching native records; validate item, location, quantity and all correlation against server-owned intent. external_id is non-unique and is not the public exact-filter mechanism.

One exact record can resolve a lost create response; zero does not authorize another create while the first may still commit; multiple/mismatched records require durable recovery. Never attach another operation's reservation or mutate original Order reservations. Native deletion/release also needs durable receipts/readback. This does not create a parallel inventory authority. It is a design candidate requiring implementation and real-database fault tests, not a completed proof. Correlation never establishes that aggregate stock is within capacity.

### Proposed proof plan — not executed

Use separate processes/connections, native reservation APIs and isolated fixtures. Explicit barriers at acquisition/native-write/checkpoint boundaries and PostgreSQL lock observations should establish ordering, not arbitrary sleeps or an assumption that a job finishes within 60 seconds.

1. Checkout/checkout, checkout/M13 and M13/M13 competing for the final unit: exactly one admission, authoritative native reservations and reserved quantity consistent.
2. Pause a holder at a barrier; establish competing acquisition; resume holder; prove no overlapping critical section. Exercise reversed multi-item ordering and unrelated-item progress separately.
3. Terminate an isolated holder process; prove automatic advisory-lock release and classify native outcome without replay. Separately terminate ONLY the lock connection while the native mutation connection remains alive: this is the essential transaction-lifetime gate.
4. Exercise native cart acquire/release with process death and expired table rows, without global lock clearing. This must pass before any global provider migration is accepted.
5. Race M5 stock updates against checkout/replacement admission; prove the stock-update policy and shared boundary, not merely two reservation writers.
6. Lose the native create response/checkpoint; restart workers and issue duplicate recovery calls; prove one dispatch and one exact correlated reservation. Cover zero/multiple/mismatched readback and uncertain release.
7. Test pool pressure and nested native workflows/compensation. Acquisition failure must not blindly replay non-idempotent inventory mutations.

### Recommendation and resume gate

Do not switch the global default, choose an M13-only provider, wrap already-locking steps recursively, or implement a custom distributed lock. The required architecture is a shared native inventory admission boundary covering checkout, replacements and competing stock writers, with lock lifetime coupled to the authoritative mutation or a proven equivalent fencing mechanism. Neither inspected provider configuration alone proves that guarantee.

The next bounded decision needs evidence for a supported native transaction/concurrency extension covering those callers, including abandoned workflow locks and isolated lock-connection failure. If that requires a native compatibility patch or custom coordination, obtain separate approval before implementation. No such extension is approved or designed here. Classification approval remains valid; full M13-B and accepted replacement reservations cannot safely resume under the current guarantee. No M13-C work started.


## 17. Transaction-coupled boundary investigation — 2026-10-15

Outcome: B. MINIMAL COMPATIBILITY PATCH REQUIRED for a shared, automatically applied boundary. Supported transaction propagation and ORM row-lock primitives are present in the installed 2.18.0 stack; existing native workflows do not apply them as one shared admission boundary. This is source inspection, not runtime proof or approval to implement. No configuration/application/dependency changes, commands or tests were made. M13-B remains paused.

### Transaction propagation traced to persistence

Public types/inventory/service.d.ts exposes Context for createReservationItems, updateReservationItems, deleteReservationItems and updateInventoryLevels. types/shared-context.d.ts explicitly describes transactionManager as a resource shared between application and module.

The actual path is:
1. utils/modules-sdk/decorators/inject-manager.js preserves a supplied transactionManager.
2. inject-transaction-manager.js immediately calls the original method when that manager is supplied; otherwise it obtains a repository transaction and passes its manager down. It does not silently start another transaction over a supplied transactionManager.
3. InventoryModuleService's createReservationItems_, updateReservationItems_, deleteReservationItems_ and updateInventoryLevels_ pass that context into internal native services.
4. MedusaInternalService passes it to repositories; MikroOrmBase.getActiveManager prefers transactionManager over manager/fresh manager.
5. Native reservation/level create/update persist entities through that manager. Delete builds SQL using manager.getTransactionContext() when present. Native soft-delete/restore likewise use the active manager.
6. ORM transaction completion flushes and commits; failure rolls back. SqlEntityManager.execute passes getTransactionContext to the driver. Therefore SQL advisory locking issued through that SAME transactional EntityManager and native persistence supplied that manager can share a database transaction/connection.

A Knex transaction or raw pg Client is not interchangeable with the required ORM EntityManager. Merely naming a field transactionId does not establish a database transaction. Workflow transactionId/runId are orchestration identities; reserveInventoryStep resolves Inventory and calls createReservationItems(items) without propagating a database transaction. A module-compatible manager with Inventory metadata must be used, not an arbitrary Marketplace manager assumed to know native entities.

| Operation | Native transaction and writes | Caller transaction supported? |
| --- | --- | --- |
| Create reservation | createReservationItems_ validates levels, creates native reservations, adjusts reserved_quantity in one decorated transaction | Yes, explicit transactionManager is retained throughout |
| Update reservation | updateReservationItems_ reads old reservations, computes deltas, validates levels, updates reservation and reserved_quantity in one transaction | Yes |
| Delete reservation | deleteReservationItems_ reads reservations, deletes through native generated service and adjusts reserved_quantity in one transaction | Yes; soft-delete, restore and by-line/location variants must also be covered |
| Update inventory level | updateInventoryLevels_ resolves levels and updates them in one transaction | Yes |
| Adjust inventory | adjustInventory_ reads and updates stocked quantity inside its transaction | Yes; array public method loops individual calls unless one shared context is supplied |

Atomicity here means writes/checks participate in one transaction; it does NOT mean competing transactions serialize their earlier availability reads. No explicit row lock is requested by ensureInventoryLevels, which passes an empty FindConfig. Native create checks each input quantity before summing adjustments; aggregate duplicate-item/location inputs require separate proof. Do not infer unrestricted batch admission safety from transaction support.

### Row-lock support and limits

FindConfig.options is a public ORM-options escape hatch. buildQuery copies it to find options; repository preparation preserves lockMode; MikroORM's SQL driver applies QueryBuilder.setLockMode. PESSIMISTIC_WRITE can therefore be requested through native list/retrieve APIs with a live transactionManager. This is a supported way to request row locks without writing native tables directly.

The unmodified reservation methods do not request it. Prelocking only an existing inventory-level row is insufficient as a universal solution for creation/deletion of missing levels. A shared boundary can instead serialize by native inventory-item identity (e.g. supported pessimistic item reads in sorted ID order), then re-read levels and reservations under that transaction. All participating methods must follow the same protocol; an UPDATE's incidental row lock does not protect an earlier unlocked read/compute sequence.

InventoryLevelRepository aggregate available/stocked/reserved helpers use getKnex() without explicitly binding getTransactionContext. They must not be substituted for the traced transactional ensureInventoryLevels ORM-list path as proof of same-connection admission. Use the native mutation's transactional checks; any additional read must prove its transaction binding.

### Competing writers and shared integration coverage

| Writer family | Current behavior | Required shared interception |
| --- | --- | --- |
| M10 checkout / native reserveInventoryStep | Redis execute by item IDs; Inventory creates its own DB transaction | Native reservation service entry must acquire transactional exclusion before check/create |
| Standalone reservation create/update/delete (future M13 too) | Same Redis item keys; direct module calls omit that outer lock | Same module boundary, including ID-to-item resolution and authoritative reread |
| Reservation soft-delete/restore, by-line/by-location, workflow compensation | Native writes and reserved-quantity adjustment; not all entry paths share identical outer locks | Cover every release/restore variant; no bypass via generated methods |
| M5 stock update / product-update workflow | Merchant commerce lock; updateInventoryLevelsWorkflow has no item lock | Native level update/adjust boundary, not M13-only locking |
| Native Admin stock POST/batch/create/delete | Native inventory workflows; deletion validates before later mutation | Same boundary, including level/item lifecycle and revalidation of deletion preconditions inside it |
| Native fulfillment/cancel-fulfillment/return workflows | Native stock adjustment and reservation update/delete/create in distinct steps | Every constituent mutation uses the boundary; do not claim the whole workflow is one transaction |
| Native Order edits/exchanges/claims/cancellation | Reuses reservation and stock steps | Same native service boundary if enabled; does not authorize exposing these future features |
| Item/level create, soft-delete, restore, cascade/location cleanup | Can change existence/availability and invalidate selectors | Cover lifecycle methods or explicitly prevent unsupported paths; item creation needs no competing existing identity but related level changes do |
| Verification fixture writes | Direct Inventory calls exist | Same registered native service, isolated fixtures; never broad cleanup |

M8/M9/M11/M12 domain locks remain distinct. A shared native Inventory boundary does not replace customer/merchant/slot/operation locks, Redis workflow persistence or event delivery. Server and worker registrations must be identical. No browser ID becomes authorization through this boundary.

A lock does not by itself prohibit a legitimate stock recount below already-reserved quantity or repair every native restore/compensation policy. Preserve and explicitly test native business semantics; do not claim stocked>=reserved is universally guaranteed by serialization. In particular, native restore increases reserved quantity without the same admission validation as create, and stale workflow compensation snapshots may require fail-closed handling rather than unconditional restoration. Any required behavioral policy change needs separate approval, not a silent concurrency refactor.

### Ordering and failure lifetime

For the proposed boundary, resolve the full item set, deduplicate, sort inventory_item_id strings, then acquire sequentially before native availability checks. For unknown IDs, resolve via supported native reads, lock the item set, reread/validate resource membership and fail closed if it changed. Do not extend an already-held set in reverse order. Missing/deleted rows, by-location selectors and restore selectors need explicit handling.

Row locks or advisory locks on the same ORM transaction release with commit/rollback/connection death. They cannot expire while that transaction continues. Loss of that connection rolls back uncommitted native writes; no fallback to a fresh manager/connection may continue the same mutation. A lost COMMIT response remains an uncertain outcome.

Unsorted transaction-level locks can deadlock on reversed multi-item sets; PostgreSQL may abort one transaction. Canonical acquisition removes that particular cycle, not every possible mixed domain/workflow deadlock. Current Redis multi-key acquisition can create partial-acquisition contention until timeout/lease expiry; it is not a proof of orderly or promptly cleaned-up contention. Existing outer Redis locks can remain an availability constraint even if an inner database boundary becomes the stock correctness authority. Do not claim globally deadlock-free behavior or blindly retry a workflow after deadlock.

### Smallest compatibility candidate (not implemented)

A caller-level wrapper around supported native Inventory calls can prove the coupling for its own callers, but does not intercept unmodified completeCartWorkflow, native Admin and compensation. Therefore it is not sufficient alone.

The narrow shared interception point is the registered native Inventory module service, around availability-affecting methods, inside their actual transaction and before their first authoritative read. Prefer a module/service compatibility extension delegating to native methods with the same transactionManager, retaining native models, repositories, validation and events. Native module exports expose the service and the module loader supports service registration, but a custom re-export alone does not prove discovery of native models, migrations, repositories and metadata. That packaging must be proven in a bounded compatibility test; do not claim an arbitrary proxy/re-registration is supported automatically.

If a supported extension cannot retain that registration cleanly, the smallest reproducible pinned-package patch belongs at Inventory's transaction-owning method boundary, not at every caller and not in a replacement inventory ledger. It would acquire canonical transaction-coupled locks and delegate the existing mutation. This avoids patching checkout orchestration and avoids changing the global Medusa lock provider. It must cover generated soft-delete/restore/cascade surfaces as well as the handwritten methods. No node_modules edits or patch implementation are authorized by this investigation.

Native EmitEvents and transaction subscribers must retain commit timing. A wrapper that extends a transaction outside a public method must prove events are not emitted before commit; an inner transaction-boundary change is preferable when that cannot be established. Do not use the internal EmitEvents decorator as an invented public integration API.

This is a plausible minimal compatibility architecture, not a completed implementation proof. It requires explicit approval and focused real-database acceptance before enabling replacements. Required tests include same-transaction connection identity, rollback after injected failure, isolated connection termination, final-stock races for all writers, reversed batches, lifecycle deletion races, restore/compensation, duplicate item/location batches, event timing and module discovery in server/worker/migration modes. No arbitrary sleeps or non-idempotent automatic replay.

### Recovery and product fallback

The approved immutable operation identity, at-most-one dispatch receipt, created_by/metadata correlation and bounded native readback remain unchanged. Lock coupling removes a stale-transaction continuation hazard; it does not remove commit-response uncertainty or permit a second create. Zero/multiple/mismatched readback remains RECOVERY_REQUIRED/fail closed under the approved protocol.

An omission-only product slice has value: explicit shortage resolution, truthful original picked/omitted quantities, customer-visible fulfillment outcome and M18 financial-review handoff. It must not claim a refund or independently release native reservations. It is not completion of the currently approved replacement-substitution scope. Adopting it would require explicit scope revision and record replacement support as deferred; no fallback has been chosen.

Final result: transaction propagation and row-lock primitives are source-proven, but automatic all-writer participation is not present. B — MINIMAL COMPATIBILITY PATCH REQUIRED is the implementation direction, subject to registration, mutation coverage, compensation and real-database proof. M13-B has not resumed; M13-C has not begun.


## 18. M13-B0 extension gate — stopped before implementation

Status: BLOCKED, not complete. The approved B0 prompt requires stopping if the supported extension cannot preserve native registration and intercept the required behavior. No application/configuration/dependency edits or package patches were made; no verification commands were executed.

### Registration evidence

Pinned modules-sdk/loaders/utils/load-internal.js resolves a discoveryPath re-export by loading the native module at that path (lines 23–28). loadResources then reads that path's exported service and adjacent models/services/repositories (lines 384–394). Runtime and schema-only registration prefer moduleResources.moduleService over loadedModule.service (lines 155 and 221). Migration discovery also follows that resource directory.

Consequently, pointing discoveryPath at the native package preserves native resources but selects the native service; exporting a local subclass at a local path selects local resource discovery and does not automatically inherit the native models/repositories/migrations. A simple spread/re-export is not the previously hoped-for service-only override. moduleContainerLoaderFactory accepts options.repositories, not an equivalent options.services override. Repository replacement is too late for complete pre-check resource acquisition and does not resolve compensation provenance. Rebuilding loaders/resources, runtime monkey-patching or copying the native module is outside the approved supported-extension constraint. This finding does not claim no possible extension exists in any Medusa version; the inspected pinned mechanism does not establish the required preservation guarantee.

### Independent compensation blocker

core-flows/inventory/steps/update-inventory-levels.js reads dataBeforeUpdate before the native update. Compensation converts that old snapshot back into an ordinary updateInventoryLevels request. core-flows/reservation/steps/update-reservations.js likewise snapshots before acquiring its outer lock and later sends old values through updateReservationItems. Neither passes a compensation marker, expected version or identity of the intervening write to the service.

Credible sequence: workflow A records old stock, changes it; B subsequently makes a valid stock update; A compensates by sending its old absolute quantity. A service-level lock would serialize this final call but cannot distinguish its stale rollback input from an intentional absolute stock update. Fresh level reads alone do not supply the missing provenance. This is a source-backed design concern, not a reproduced incident. It directly prevents claiming the prompt's compensation guarantee with a pure service wrapper.

### Exact mutation surface enumerated from pinned service/type declarations

- Reservation: createReservationItems, updateReservationItems, deleteReservationItems, softDeleteReservationItems, restoreReservationItems, deleteReservationItemsByLineItem, restoreReservationItemsByLineItem, deleteReservationItemByLocationId.
- Levels: createInventoryLevels, updateInventoryLevels, adjustInventory, deleteInventoryLevel, deleteInventoryLevels, softDeleteInventoryLevels, restoreInventoryLevels, deleteInventoryItemLevelByLocationId.
- Item lifecycle/nested levels: createInventoryItems, updateInventoryItems, deleteInventoryItems, softDeleteInventoryItems, restoreInventoryItems.
- Handwritten methods have corresponding transaction-owning underscore methods where declared; generated delete/soft-delete/restore methods also require coverage. Locking only handwritten reservation creation is insufficient.

No new boundary covers these methods yet. Native checkout, M5/Admin level writes, native release/restore/fulfillment paths retain existing behavior. An M13-only wrapper would leave native callers outside it.

### Smallest patch investigation requiring separate approval

The narrow candidate is an explicit native service-extension hook that preserves native resource discovery, or a reproducible pinned Inventory package patch at the transaction-owning methods. The latter would acquire all canonical item locks inside the existing transaction before authoritative reads, cover generated lifecycle surfaces, and preserve the native event/commit sequence. No global locking-provider switch is needed.

That Inventory-only patch is not enough for all B0 requirements: the affected core-flows snapshot compensation steps must also retain sufficient expected-result/provenance information to revalidate after locking and fail closed on an intervening write. Do not invent a restore rule that overwrites intervening valid stock changes. The exact safe compensation protocol requires a bounded design review before patch implementation.

Blast radius: Inventory callers including checkout, native Admin, M5, fulfillment/returns/cancellation and workflow compensation; native package upgrades require explicit patch review. No payment/Yoco/Order/delivery-reservation redesign is proposed. Native models, persistence and event contracts remain authoritative.

Required acceptance before declaring B0 complete: native discovery/migration parity; all-method coverage; actual persistence transaction/connection identity; canonical multi-item ordering; final-stock races; Admin/M5 races; rollback and connection-termination release; missing/deleted/restored levels; duplicate batches; no event before commit/after rollback; compensation versus intervening writes; unchanged M5/M8/M10/M11/M12 regression. None was added or run because the mandatory extension gate failed before implementation.

No new verification command exists for this blocked slice. No package patch is authorized or implemented. M13 replacement work and classification implementation remain paused; M13-C not started.


## 19. Revised authoritative MVP contract — omission-only shortage resolution

### 19.1 Scope and authority

Resolve authoritative M12 shortages on ACCEPTED OrderOperations with valid terminal M10 handoff and an IN_PROGRESS PickSession. Medusa retains original Order, lines, quantities, discounted/taxed allocations, totals, payment, inventory/reservations and fulfillment authority. M13 writes operational records only. It must not call native Order edit/cancellation, inventory/reservation mutations, payment/refund/credit, or fulfillment mutations.

Admission requires the existing native-line fingerprint, original PickLine, ordered quantity Q, physically picked original quantity P, shortage_recorded=true and Q-P>0. Fully picked lines, pending/rejected Orders, incomplete/ambiguous M10 handoffs and completed sessions cannot create new omission work. Parent-child relationships and quantities are server-derived. One current shortage generation per original PickLine is enforced in the database. Immutable decisions/audits are retained; records are not overwritten to hide prior shortages.

### 19.2 Minimal states and truthful original-found path

A shortage record uses OPEN_SHORTAGE, CUSTOMER_DECISION_REQUIRED and RESOLVED_OMITTED only for executable omission behavior.
- Admission records OPEN_SHORTAGE and applies the frozen authoritative preference in the same transaction.
- CONTACT_ME advances to CUSTOMER_DECISION_REQUIRED. No response remains unresolved indefinitely.
- NO_SUBSTITUTION may advance directly to RESOLVED_OMITTED under the customer authorization rules below.
- Explicit customer omission agreement advances CUSTOMER_DECISION_REQUIRED to RESOLVED_OMITTED.

ORIGINAL_FOUND is an outcome of the existing M12 original-line update, not a replacement proposal or acceptance state. Before omission is terminal, the active assignee may record newly found original goods using existing M12 validation. A changed picked quantity or shortage status retires the previous open decision generation, preserving its audit, and invalidates its revision. If the line becomes fully picked, no current omission work remains. If a valid partial shortage still exists, a fresh generation must derive its quantity from the new original-line state; previous customer consent cannot be carried to a different missing quantity.

After terminal omission, ordinary M12 edits that change that line's picked quantity/shortage resolution are rejected. M13 does not introduce an undo-omission or post-completion recovery workflow. Reassignment preserves the resolution; it does not reopen it. This avoids silently repurposing customer consent or counting omitted units as subsequently picked. Original-found racing omission is serialized: whichever valid transition commits first invalidates the other command; an exact omission replay remains idempotent.

### 19.3 Customer preference and omission consent

Supported current preferences: CONTACT_ME and NO_SUBSTITUTION. Existing Orders without authoritative explicit preference default to CONTACT_ME. BEST_MATCH/automatic replacement and all replacement acceptance states are deferred.

NO_SUBSTITUTION means: the authenticated owning customer authorizes omission of quantities subsequently recorded missing for this Order, without a further per-shortage prompt, while financial resolution remains pending. It is not inferred from absence of preference, a merchant statement, browser storage, an arbitrary native metadata field or a rejected replacement. Only an explicit authenticated customer choice persisted by the owning operational service supplies this authority.

A narrowly scoped customer Order preference command may establish this groundwork before the first shortage generation, while picking is not completed and the Order is authoritative/ACCEPTED. It accepts only the enum and expected revision; it cannot assign quantity or other authority. Once shortage admission freezes the preference, changing it for existing work is not supported in M13. Historical Orders without such a record use CONTACT_ME. This is operational consent, not a commercial Order mutation. No checkout/payment flow changes are needed.

Each shortage freezes preference value, customer identity, source record/revision and consent timestamp where applicable. NO_SUBSTITUTION auto-resolution records preference-based authorization, never fabricates a per-shortage customer click. CONTACT_ME always requires explicit agreement to omission for the exact current shortage generation. There is no automatic timeout, automatic acceptance, merchant decision on behalf of the customer, or expiry fallback. Choosing not to agree leaves work unresolved; no artificial rejection terminal state is needed.

### 19.4 Quantities and M12 completion

For every native original line:
- Q = authoritative ordered quantity, matching the frozen M12 baseline/native fingerprint.
- P = original physically picked quantity; retain the truthful PickLine value.
- O = server-derived terminal omitted quantity from valid resolution evidence, otherwise zero.
- U = Q-P-O.

Require nonnegative valid quantities and P+O<=Q. Completion requires U=0 for every original line, no pending/invalid resolution and all existing M12 authorization/handoff/fingerprint guards. A shortage flag is no longer alone sufficient to block completion when exact terminal omission evidence accounts for it. Do not clear that flag or fabricate picked units merely to satisfy old checks.

Example: Q=5, P=3, O=2 is operationally complete; PickLine.picked_quantity remains 3. Q=5, P=3, O=0 remains blocked. Customer agreement alone never changes physical picked quantities. Completion marks operational readiness only, not financial settlement or native fulfillment.

Extend the existing M12 owning service and database completion/audit predicates together; no separate bypass completion endpoint. Existing reads that validate quantities and completed state must understand the same single accounting rule. Keep original ordered-minus-picked shortage distinguishable from remaining unresolved quantity in DTOs.

### 19.5 Authorization, concurrency and replay

Merchant/picker mutations reuse existing M12 capabilities, active membership and active-assignee enforcement for OWNER/MANAGER/PICKER. Supervisors must explicitly reassign under M12 to take over; no supervisor bypass. Revocation is revalidated after merchant lock acquisition. Reassignment does not erase shortage/consent evidence.

Customer decisions require authenticated customer ownership of the native Order, authoritative OrderOperation/handoff, current shortage generation and expected revision. Resolve merchant/store from authoritative relationships, then serialize using the existing merchant-first discipline, OrderOperation, PickSession and PickLine/shortage rows in consistent order. Customer commands join the same operational lock boundary without pretending the customer has merchant membership. Revalidate ownership/native state inside the boundary.

Strict bodies allow only customer choices/revisions or merchant selectors/revisions needed for admission. Reject merchant/store/customer identity, quantity, picked state, money, status, timestamps and financial flags supplied as authority. Foreign known Order/line/shortage IDs are unavailable without existence disclosure.

Exact same omission decision for the same generation returns its durable original receipt without another transition/audit, including a lost-response retry after completion, after ownership is revalidated. Nonmatching stale commands, invalidated original-found generations and altered quantities conflict. Terminal replay never authorizes a new mutation. Customer decision races, original-line correction races and completion races use PostgreSQL transactions/constraints; no process-local correctness.

### 19.6 M18 evidence and customer wording

On terminal omission retain immutable evidence referencing original native Order/line/version, OrderOperation, PickSession/PickLine/generation, Q/P/O, native original discounted/taxed allocation and currency with provenance/fingerprint, frozen customer preference, explicit omission decision identity/time where required, preference authorization where used, and operational revision/audit references.

Retain operational completion through an immutable completion receipt/reference when the session completes; do not rewrite the original decision evidence. Set financial_review_required=true for every terminal omission and retain it after operational completion. Reuse existing native money conversion and commercial read boundaries; no independent financial allocation engine. Missing/unsupported required commercial evidence fails safely rather than inventing a value.

These are historical evidence, not a second commercial source of truth, refundable balance or financial entitlement. M18 must independently establish financial resolution and idempotency. No M13 API may claim refunded, credited, commercially cancelled, total reduced, payment adjusted or native line removed. Customer wording must clearly state missing units will not be delivered and financial adjustment is not yet confirmed.

### 19.7 Revised implementation slices and tests

M13-B: operational shortage/preference/decision models and migrations; unique/current-generation and immutable evidence constraints; shared owning domain/service/workflow; strict actor APIs; native read-only evidence; customer consent/replay; merchant/assignee/ownership enforcement; transactional M12 original-found invalidation and exact completion bridge; durable audit; unit and real-database/API tests. No UI and no native inventory mutation.

M13-C: merchant assigned-picker shortage/readiness controls and customer preference/omission decision UX using shared contracts/API client; loading/empty/error/stale/restoration behavior; explicit financial-pending wording; focused browser coverage. No replacement chooser or response countdown.

M13-D: acceptance/security/regression matrix and only missing tests/proven defect fixes. Preserve M10–M12 regressions.

Required B tests: authoritative admission; Q5/P3 partial shortage; fully picked denial; pending/rejected Order denial; completed-session immutability; cross-merchant/customer known-ID attacks; strict hostile bodies; default CONTACT_ME; explicit CONTACT_ME consent; provenance-backed NO_SUBSTITUTION; duplicate/stale/racing decisions; original-found before/racing omission; membership revocation; reassignment preserving resolution; unresolved completion blocked; exact P+O completion accepted with truthful P; decision replay after completion; immutable M18 evidence; native Order/payment/inventory/reservation/fulfillment unchanged before/after all flows. Test actual concurrent transactions and HTTP boundaries, not only mocked helpers.

### 19.8 REPLACEMENT SUBSTITUTIONS — DEFERRED

Preserve sections 1–18 as durable source/design evidence. Re-enabling replacement proposals, customer replacement decisions, candidate validation, replacement stock reservation or physical replacement picking requires a separately approved effort proving:
1. Shared native inventory transaction/failure boundary.
2. Reservation uncertain-outcome recovery and at-most-one dispatch/readback.
3. Native compensation stale-snapshot safety.
4. Participation of all competing stock writers, including Admin/M5.
5. Canonical multi-item locking and failure handling.
6. Item/level lifecycle, native registration/migrations and event correctness.

No Medusa package patch is part of revised M13. The previously approved native-variant selling-unit classification remains recorded as deferred groundwork; it is not required or implemented for omission-only runtime behavior. Unclassified variants remain valid catalogue items. Existing compatible general-purpose classification, if later found already implemented, must be inspected rather than removed automatically.

### 19.9 Approval and readiness

The inventory blocker no longer prevents the revised omission-only design because it performs no native inventory/reservation writes. Revised M13-B is architecturally ready to implement once this contract revision is approved. This document revision does not implement B or authorize starting C. No commands, tests, migrations or commits were run; no production code changed.


## 20. Final M13-B preference clarification — approved 2026-10-16

Before the first authoritative shortage, the owning authenticated customer may choose and change CONTACT_ME or NO_SUBSTITUTION. The first shortage atomically freezes the current choice, or materializes and freezes CONTACT_ME if absent. After freeze, a different preference conflicts; an exact same-value replay is a read-only idempotent result. Frozen authenticated NO_SUBSTITUTION is prior omission consent and requires no per-shortage click. CONTACT_ME needs explicit agreement for each current generation. No automatic timeout. Section 19 otherwise remains the executable contract; sections 1–18 remain deferred research. Implementation is limited to revised M13-B, with no native commerce mutations.


## 21. Revised M13-B implementation record — 2026-10-16

Implementation is present; command/runtime verification remains pending. Sections 1–18 remain deferred research, unchanged by this implementation.

- Marketplace owns order_shortage_preference, shortage_resolution and append-oriented shortage_event. All reference the existing authoritative OrderOperation/PickSession/PickLine; no new commerce store or native mutation.
- Preference can be selected while the authoritative OrderOperation is PENDING_ACCEPTANCE or ACCEPTED, before the first shortage. This makes the section 20 before-first-shortage clarification available before merchant acceptance. Rejected Orders cannot change it. Frozen same-value replay is read-only and never manufactures explicit consent.
- OPEN_SHORTAGE is conceptual admission, not an externally persistent intermediate status: creation and frozen-policy application commit atomically as CUSTOMER_DECISION_REQUIRED or RESOLVED_OMITTED. A UUID identifies each quantity generation; invalidated generations remain durable.
- The native Order/line and checkout_completion_id reference immutable M10 commercial evidence (CheckoutAttempt snapshot via completion). source_lines_fingerprint preserves the M12 native-line baseline. This uses the approved original pricing/allocation **reference** alternative, not a second money snapshot/calculation. PickSession plus its COMPLETE event retain the eventual completion reference. M18 must read original native allocations and establish financial entitlement; M13 does not calculate one.
- The current active-case unique index, foreign keys, immutable terminal evidence, frozen preference guard, omission line guard and deferred audit constraints enforce the database side. M12's existing completion guard now requires exact P+O=Q; original picked quantity and shortage flag remain truthful.
- Customer mutations enter the extracted existing native Order-ownership/merchant-lock boundary. Merchant mutations keep M4 capabilities and active assignee checks. No new authentication or inventory lock.

### M13-B APIs

| Actor | Method/path | Input |
|---|---|---|
| Customer | GET /store/gospaza/orders/:id/substitution-preference | none |
| Customer | PUT /store/gospaza/orders/:id/substitution-preference | preference, expected_revision |
| Customer | GET /store/gospaza/orders/:id/shortages | none |
| Customer | POST /store/gospaza/orders/:id/shortages/:case_id/omit | confirmed=true, expected_revision |
| Merchant | GET /merchant/picking/:id/shortages | none |
| Assigned picker | POST /merchant/picking/:id/lines/:line_id/shortage | expected_revision |

The normal M12 line update automatically admits/invalidate-generates shortage evidence within its transaction; the explicit admission endpoint also handles pre-M13 shortages. Customer quantities, identities, money and states are rejected by strict bodies. There is no replacement, timeout or undo endpoint.

### Static security review

SOURCE (body/known IDs/cookie) → strict schema/actor middleware → server native Order ownership or M4 membership/capability plus merchant-first lock → tenant-scoped operational rows and append-only audit. Case IDs never authorize another Order or customer. Foreign IDs do not expose the foreign record. Quantities derive from validated native/M12 evidence; terminal omission cannot consume original units twice. No outbound provider call or secret payload is introduced. Executable assertions below remain unrun and must not be described as proven runtime results.

### Coverage added

| Invariant | Coverage |
|---|---|
| Default CONTACT_ME, explicit choices, changes and freeze | shortages.test.ts; verify-shortages.ts preference and freeze-race scenarios |
| Hostile bodies, actor confusion, foreign Order/case and merchant IDs | verify-shortages.ts real HTTP negative requests |
| Shortage admission, accepted/in-progress/active assignee | verify-shortages.ts admission, handover and revocation scenarios; existing verify-picking.ts native drift guards |
| Partial Q5/P3/O2 and no-response blocking | verify-shortages.ts partial case |
| NO_SUBSTITUTION prior consent | verify-shortages.ts prior-consent case |
| Generation invalidation and stale consent | verify-shortages.ts partial quantity change/original-found |
| Unique active generation / concurrent repeat admission | verify-shortages.ts duplicate HTTP admission and SQL uniqueness failure |
| Concurrent duplicate omission and original-found race | verify-shortages.ts actual concurrent HTTP requests |
| Preference vs freeze; completion vs omission; reassignment vs line update | verify-shortages.ts actual concurrent HTTP requests |
| Membership revoked while waiting on merchant lock | verify-shortages.ts direct-service request with query barrier and real transaction |
| Audit identity, immutability and transactional rollback | verify-shortages.ts audit assertions and targeted audit-insert fault |
| Truthful M12 completion / terminal replay | verify-shortages.ts partial completion and replay after completion |
| Native Order, inventory/reservation, payment/capture/refund and fulfillment unchanged | verify-shortages.ts native baseline around partial omission and completion; preserved M12 verifier |

### Verification environments

All commands run from repository root. Stop on any failure. Codex did not execute them.

A. No dev servers (stop Next processes before typecheck/build):
1. pnpm run lint — zero errors/warnings.
2. pnpm run typecheck — workspace TypeScript passes.
3. pnpm --filter @gospaza/backend run test — policy/unit regressions pass.
4. pnpm --filter @gospaza/backend run build — backend build succeeds.

B. PostgreSQL/Redis available, backend stopped for migration:
1. pnpm --filter @gospaza/backend run db:migrate — migration/link sync succeeds; then restart backend on migrated code.

C. Backend only (existing local test-mode Yoco verifier configuration; PAYMENT_RECONCILIATION_WORKER_ENABLED=false in backend and verifier; no live credentials):
1. pnpm --filter @gospaza/backend run test:shortages — M13-B passes, including the existing composed M8/M10-E/M11-B prerequisites.
2. pnpm --filter @gospaza/backend run test:checkout-foundation — standalone M10-C assertions pass.
3. pnpm --filter @gospaza/backend run test:order-decisions — M11-C regressions pass.
4. pnpm --filter @gospaza/backend run test:picking — M12 regression and new fixture cleanup pass.

D. Browser regression (Playwright manages configured app stack; backend mocked as in existing suites):
1. pnpm exec playwright test --config=playwright.m12-merchant.config.ts — existing picking browser suite passes.
2. pnpm run test:browser — full regression passes.

No M13 UI/browser journey is added in B. No M13-C, replacement runtime, package patch, native inventory/order/payment mutation, refund, credit, fulfillment or dispatch is implemented.

### M13-B material file manifest

- `apps/backend/src/modules/marketplace/models/order-shortage-preference.ts`
- `apps/backend/src/modules/marketplace/models/shortage-resolution.ts`
- `apps/backend/src/modules/marketplace/models/shortage-event.ts`
- `apps/backend/src/modules/marketplace/service.ts`
- `apps/backend/src/modules/marketplace/shortage-policy.ts`
- `apps/backend/src/modules/marketplace/shortage-resolution.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261016000000.ts`
- `apps/backend/src/lib/picking-service.ts`
- `apps/backend/src/lib/order-operations-service.ts`
- `apps/backend/src/lib/shortage-http.ts`
- `apps/backend/src/workflows/update-shortage.ts`
- `apps/backend/src/api/store/gospaza/orders/[id]/substitution-preference/route.ts`
- `apps/backend/src/api/store/gospaza/orders/[id]/shortages/route.ts`
- `apps/backend/src/api/store/gospaza/orders/[id]/shortages/[case_id]/omit/route.ts`
- `apps/backend/src/api/merchant/picking/[id]/shortages/route.ts`
- `apps/backend/src/api/merchant/picking/[id]/lines/[line_id]/shortage/route.ts`
- `packages/contracts/src/shortages.ts`
- `packages/contracts/src/picking.ts`
- `packages/contracts/src/index.ts`
- `apps/backend/tests/shortages.test.ts`
- `apps/backend/src/scripts/verify-shortages.ts`
- `apps/backend/src/scripts/shortage-verification-cleanup.ts`
- `apps/backend/src/scripts/verify-picking.ts`
- `apps/backend/src/scripts/verify-checkout-foundation.ts`
- `apps/backend/src/scripts/verify-payment-reconciliation.ts`
- `apps/backend/package.json`
- `milestones/MILESTONE_M13_SUBSTITUTIONS.md`
