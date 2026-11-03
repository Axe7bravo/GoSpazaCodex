# M18 — Refunds, Adjustments and Store Credit

## Status and authority

M18-A through C2B are complete and user-verified. Section 20 supersedes earlier A recommendations concerning guest fallback, restricted-return method/fees and goodwill authority. Section 24 records the provider-correlation evidence for C1. M18-D financial UX is implemented pending user verification. Browser and final security/privacy acceptance follow code-level verification.

M18-A reconnaissance completed on 2026-10-28. **Technical reconnaissance is approved. The revised store-credit-first MVP policy below is approved; remaining recommendations are explicitly identified. B/C/D are not implemented or authorized by this document.** M17 is complete, verified and merged according to the user. Older pending-verification wording in M17 documents is historical, not evidence that M17 must be repeated. Inspected `.git/HEAD` names `milestone/m18-refunds-adjustments-store-credit`; no Git commands were executed.

This contract follows the current milestone prompt, AGENTS.md and the Medusa-first, security-review and milestone-implementer skills. Inspection used file reads and official documentation. No verification commands, installs, migrations, native/provider requests, commits or runtime changes were made.

**Physical outcome is not financial outcome.** M17 `RETURNED_TO_STORE` proves custody at the originating Store, not sellability, a native Return, refund, credit or financial resolution. M18 must never clear or rewrite historical M13/M17 evidence to manufacture resolution.

## 1. Scope and ownership

Medusa owns Orders, original line economics, Payments/Captures/Refunds, OrderTransactions, credit lines, Inventory and commercial Returns. GoSpaza owns marketplace entitlement policy, source-evidence identity, amount allocation, authorization, durable operation designation, external correlation, reconciliation and audit. A settlement operation is an instruction/receipt around native commerce, not an independent payment ledger or customer wallet.

M18 covers existing paid rejection, terminal omissions and failed restricted-handoff financial review; store-credit-first routine adjustments, bounded original-payment refunds and a source-verified native Store Credit integration; explicit inventory disposition and native commercial reconciliation. It must also recognize unresolved M10 and M15/M16 recovery cases without automatically approving money movement.

Excluded: new general customer cancellation/support product, arbitrary goodwill amounts (approved bounded goodwill adjustments default to Store Credit; entitlement rules/caps still require policy), rewards/gift cards, commission/merchant accounting (M19), settlement/manual payout (M20), driver earnings (M21), notification infrastructure (M22), generic operational override UI (M23), replacements, provider upgrades, new payment providers and independent stock/balance stores.

## 2. Evidence map — exact installed version

All installed packages below report 2.18.0. Paths are relative to the matching package directory under `node_modules/.pnpm/<package>@2.18.0_<dependency suffix>/node_modules/@medusajs/<package>/dist/`. These are observations of the installed files, not a claim of a clean reinstall or comparison with a pristine registry archive. No `patchedDependencies` declaration or `patches/` directory was found in the root configuration.

| Source | Observed behavior and consequence |
| --- | --- |
| `types/payment/mutations.d.ts::CreateRefundDTO` | `payment_id`, optional `amount: BigNumberInput`, reason, note, created_by, metadata. **No caller-supplied refund idempotency_key.** |
| `types/payment/provider.d.ts::RefundPaymentInput/Output` | Input amount is BigNumberInput plus PaymentProviderInput data/context. Output extends PaymentProviderOutput; no pending/succeeded/failed refund-status contract. |
| `payment/services/payment-module.js::refundPayment_` | Creates a provisional native Refund before calling the provider. Explicit amount must be positive; omitted amount defaults to the original payment amount, **not remaining refundable amount**. Reads captures minus existing refunds. Inspected implementation locks the payment row in its native transaction, refreshes totals and applies currency epsilon; the lock is not held across the provider call. |
| Same, `refundPayment` / `refundPaymentFromProvider_` | Provider gets payment data, refund.raw_amount and `context.idempotency_key = refund.id`. On provider exception the provisional Refund is deleted. A later call creates another native refund ID/key. Metadata supplied to native refund creation is stored on Refund, **not forwarded as an operation selector to the provider**. Provider success updates payment data and collection totals. |
| `payment/models/refund.js` | Amount, payment, reason, note, creator, metadata; no pending/failure status or business-key uniqueness. Mere row existence is not proof of provider success while the call is in flight. |
| `core-flows/payment/steps/refund-payment.js` | Single-payment module call; deliberately no compensation that recaptures refunded money. |
| `core-flows/payment/workflows/refund-payment.js` | Singular workflow exists. Checks captured balance, invokes refund step, creates negative OrderTransactions and potentially refund credit-line order changes; emits payment.refunded. It iterates the returned payment's refunds, including historical rows. Its transaction amount expression uses `input.amount` if supplied; this is not a safe general repair/import loop. |
| `core-flows/payment/steps/refund-payments.js` | Bulk step catches/logs per-payment errors and returns only successful objects. No proof that every input refund succeeded. |
| `core-flows/payment/workflows/refund-payments.js` | Plural workflow exists; validates capture/refund totals, but derives OrderTransactions from **input**, with payment ID as reference_id, not from individually proven refund receipts. Do not use as M18's settlement authority. Repeated partials also collide with step-level payment-reference deduplication. |
| `core-flows/order/steps/add-order-transaction.js` | Reads existing `(order_id, reference, reference_id)` then inserts missing transactions; compensation deletes the created transactions. This is read-before-write deduplication, not structural concurrent uniqueness. |
| `order/models/transaction.js`, `services/order-module-service.js::addOrderTransactions_` | Reference indexes are non-unique. Supported module method creates transactions and updates native summary. M18 must serialize/designate its native write and read back exact reference and amount. |
| `core-flows/order/workflows/payments/create-order-refund-credit-lines.js` | Creates and confirms a CREDIT_LINE order change. An Order credit line changes commercial balance; it is **not** a reusable customer Store Credit account. |
| `core-flows/order/workflows/cancel-order.js` | Couples refunds of captures, cancellation of uncaptured payments, reservation deletion and native order cancellation. Rejects completed orders and outstanding fulfillments/returns/claims/exchanges. Not a harmless way to release inventory. |
| `core-flows/order/workflows/create-fulfillment.js` | Decrements native stock for fulfilled quantities/components and reduces/deletes corresponding reservations. |
| `core-flows/order/workflows/return/begin-receive-return.js` | Creates a return_receive OrderChange after validation; does not itself prove goods condition or refund. |
| `core-flows/order/workflows/return/confirm-receive-return-request.js` | Confirms native changes, updates received/damaged quantities, restocks normal received units, excludes damaged actions from restock, updates the payment collection and emits return/inventory events. No explicit Yoco refund call in this workflow. |
| `core-flows/order/workflows/return/confirm-return-request.js` | Materializes return items, confirms request and conditionally creates inbound fulfillment if a return shipping option is present. Do not create a second physical journey for an already received M17 return. |
| `core-flows/order/workflows/return/receive-complete-return.js` | Separate workflow delegates to Order Module receiveReturn. It is not interchangeable with the inventory-aware receival workflow. |
| `core-flows/reservation/steps/delete-reservations-by-line-items.js` | Supported native deletion by line IDs under native inventory-item locking, with restore compensation. This is a candidate non-financial release primitive; reconciliation must verify exact owned residual reservations, not blindly delete all records from a broad query. |
| `core-flows/cart/workflows/complete-cart.js` | Copies native credit lines into Order; supports zero total covered by credit lines. This does not prove GoSpaza's current Yoco-only checkout supports credit redemption. |

### Current documentation differs

Current [Medusa payment-flow documentation](https://docs.medusajs.com/resources/commerce-modules/payment/payment-flow) describes caller-supplied refund idempotency and replay-safe transaction/credit-line/event behavior. Its indexed description was available; full page fetch timed out. The installed DTO/model/service/workflows above do **not** provide that newer end-to-end guarantee. Do not infer a feature's presence from the current docs or from the provider context containing a transient refund ID.

Current [Store Credit documentation](https://docs.medusajs.com/resources/commerce-modules/store-credit) describes a separate Loyalty Plugin, with migrations; compatibility is advertised for 2.14+. Its availability is not proof of a reviewed plugin version compatible with every pinned GoSpaza dependency. Current [credit workflows](https://docs.medusajs.com/resources/commerce-modules/store-credit/workflows) explicitly date the single-account debit workflow to 2.21.1. Do not import that into 2.18 from examples.

## 3. Current Yoco integration and provider evidence

Repository source: `apps/backend/src/modules/yoco/{service,types,validation,webhook,request,registered-service}.ts`, `UPSTREAM.json`, `lib/payment-reconciliation-service.ts`, `modules/marketplace/provider-operation-store.ts`, `reconciliation-types.ts`, technical-compensation/provider-operation/inbox models, `api/hooks/gospaza/yoco/route.ts` and `api/middlewares.ts`.

This is a repository-owned fork of medusa-payment-yoco 1.2.0, upstream revision `0513eda8db1adcf00bcf1806c436954ab9134f69`; configuration registers local `./src/modules/yoco`, not a separately installed provider package.

* `payment.succeeded` is mapped to **captured**. Reconciliation authorizes the native session, reads back native Capture, then dispatches completeCartWorkflow. Provider capture validates existing captured evidence; it does not send another capture request. Capture precedes merchant acceptance; rejected successfully completed Orders require refund, not authorization void.
* Native payment data retains operation_id, attempt_id, session_id, payment_collection_id, cart_id, `yocoCheckoutId`, redirectUrl and `yocoPaymentId`. Durable ProviderOperation/session history is authority; browser IDs are not. Refund POST uses **checkout ID**, while payment ID validates original payment correlation.
* `refundPayment` already exists, but only approves a designated **full technical compensation** matching the entire original amount and captured payment. Arbitrary/partial commercial refunds are rejected with YOCO_REFUND_NOT_APPROVED. CancelPayment deliberately throws uncertainty: no supported external void is implemented.
* The adapter uses a durable technical-compensation key, not Medusa's transient refund ID, posts exact cents, persists receipt and throws on pending/unknown. This prevents pending from being recorded as a successful native Refund. It can currently accept a validated synchronous succeeded receipt or verified event for technical compensation. M18's recommended terminal proof is the correlated success event or separately verified provider readback; do not change M10 behavior silently in A.
* Existing inbox accepts signed payment and refund events, deduplicates event IDs with a normalized-body fingerprint, and acknowledges durable receipt before worker processing. Refund normalization retains event ID, checkout ID, amount, currency and mode; it drops provider refund ID/custom metadata/remaining balance. Reconciliation requires refund amount equal to original ProviderOperation amount and an approved technical_compensation. **This path cannot simply be reused unchanged for multiple partial refunds.**

### Official Yoco findings, checked 2026-10-28

The [refund endpoint](https://developer.yoco.com/api-reference/checkout-api/checkout/refund-checkout) takes checkout ID, integer-cent amount and optional metadata, and supports Idempotency-Key. Responses contain checkout ID, refundId and pending/succeeded status. Always send an explicit approved amount; never let an omitted amount consume a later remaining balance.

The [refund guide](https://developer.yoco.com/guides/online-payments/refunding-a-payment) describes asynchronous acceptance and event confirmation, and says real refunds require live-created checkouts. Consequently local mocks are not provider certification; live verification needs separate explicit authorization and a bounded test plan.

[Idempotency documentation](https://developer.yoco.com/docs/checkout-api/idempotency) limits retention to 24 hours and returns the original result on replay. A stable key alone is not permanent duplicate protection. M18 freezes first-dispatch time and a conservative replay deadline; after expiry, **no further POST** for an uncertain operation.

[Partial refund events](https://developer.yoco.com/api-reference/checkout-api/webhook-events/refund-notification-success-partial) carry refundableAmount in addition to refund amount. [Failure events](https://developer.yoco.com/api-reference/checkout-api/webhook-events/refund-notification-failure-full) use refund.failed. Both require existing signature verification. Documentation examples use an event-like payload.id; do not assume it equals HTTP refundId. Confirm custom refund metadata echo/refund-ID correlation in actual provider evidence before enabling repeated equal-value partial refunds. Amount+checkout alone cannot distinguish those operations.

[Signature verification](https://developer.yoco.com/guides/online-payments/webhooks/verifying-the-events) agrees with existing HMAC-SHA256 over webhook-id, timestamp and untouched body, decoded whsec key, constant-time comparison and three-minute freshness. Keep the same endpoint and 64KB body bound.

[Refund readback](https://developer.yoco.com/api-reference/yoco-api/refunds/fetch-refund-v-1-refunds-refund-id-get) is documented on **api.yoco.com**, with JWT and business/orders:read scope. That is a different API/authentication contract from Checkout secret keys. Availability, identifiers and access for this account remain external gates; do not invent GET /checkouts/:id/refund or assume current credentials work.

## 4. Inventory of existing financial work

Search covered application source for financial_review_required, refund/refunded, adjustment/credit/store_credit, return/RETURNED_TO_STORE, REJECTED, OMITTED and cancellation/cancelled, with prior M10/M11/M13/M16/M17 contracts for context. Generic function returns, application rejection, catalogue stock edits, proposed historical replacement designs and native utility names are not financial cases. No general customer cancellation API or Store Credit mutation was found.

| Durable source / current reachability | Financial consequence and limits |
| --- | --- |
| M10 captured late payment after closed/expired attempt, never completion-dispatched | Existing full technical_compensation owns refund. Usually no native Order. Do not create a second M18 entitlement or replay checkout. |
| M10 pending/unknown/failed technical refund | Existing recovery work; not paid back, no alternative credit while uncertainty remains. |
| M10 RECOVERY_REQUIRED / partial native Order / lost completion history | Review-only exception. No inference of cancellation, refund eligibility or unused capacity from uncertainty. |
| M11 OrderOperation REJECTED plus immutable decision | Payment already captured. GoSpaza slot capacity released; native inventory reservations retained. Full financial/commercial review remains unresolved. No M10 automatic reversal. |
| M13 noninvalidated RESOLVED_OMITTED with frozen native line/quantity evidence | financial_review_required=true, whether omitted by frozen NO_SUBSTITUTION preference or explicit customer decision. Calculate from original Order economics; not current catalogue. Unresolved CUSTOMER_DECISION_REQUIRED is not a final omission. |
| M13 completed picking / M16 delivered physical subset with omissions | Delivery success does not settle omitted value; remaining omitted reservations persist. No replacement-price delta exists in implemented omission-only M13. |
| All units omitted / NO_PHYSICAL_ITEMS attention | Whole merchandise omitted; no fabricated shipment. Review fee and operational recovery separately; existing assignment may remain occupied. |
| M15 dispatch attention/exhaustion/disabled or no-longer-dispatchable | Potential paid-unfulfilled review, not automatic cancellation. Search failure alone is insufficient to refund an order that could still progress through approved recovery. |
| M16 pickup/completion RECOVERY_REQUIRED or attention, suspension/cancellation evidence | Unknown physical/native effects. Hold money movement pending authoritative operational disposition. No automatic refund on a timer. |
| M17 RETURN_REQUIRED / RETURNING_TO_STORE | Whole dispatched manifest not handed over; financial_review_required. Open review, but do not equate return initiation with receipt/sellability. |
| M17 RETURNED_TO_STORE and merchant receipt audit | Physical received manifest excludes omitted units. Financial review still true. Separate returned goods and earlier omissions to avoid duplicate entitlement. |
| M17 paid restricted order unable to progress because current authorization/document/handoff gate fails | Bounded review if durable operational evidence proves blockage. No automatic entitlement from a transient UI error; no recipient observations copied into finance. |
| Ordinary successful delivery without shortages | No automatic adjustment. |
| Before capture: failed/abandoned/expired checkout without success | No refund. Browser cancel is UX, not external void. A later success follows M10 compensation. |
| Customer cancellation pre-pick/during-pick/after-pickup; ordinary customer-unavailable return | No approved reachable general cancellation/return workflow today. Mark policy-only; do not create UX in M18-A or infer outcome from a request. |

Current physical evidence sources: `lib/order-operations-service.ts::decide`, `modules/marketplace/shortage-resolution.ts`, `lib/picking-service.ts`, `lib/pickup-native.ts`, `lib/handoff-service.ts`, `lib/recipient-service.ts`. M17 receipt changes restricted_return, delivery and commitment plus audit, not native commerce. M11 rejection never calls native cancel/refund.

## 5. Financial adjustment and settlement model

A **financial adjustment / entitlement** defines how much economic value is owed. A **settlement method** defines where that value goes. Use **Store Credit settlement** for value issued to the native reusable GoSpaza balance and **original-payment refund** only for money returned through the payment provider. For example: a R500 paid Order with R120 terminal omissions produces an approved R120 financial adjustment, settled as STORE_CREDIT +R120; it does not imply a card refund.

Use a small Marketplace Financial Resolution owner, exposed via explicit contracts, not logic distributed across routes. Models proposed for B:

1. **FinancialAdjustment**: unique source identity `(source_type, source_id, source_revision)`; native Order/M10 receipt/Store links; bounded reason; calculation version; immutable approved allocations; policy snapshot including server-derived eligible settlement methods; review/decision audit. Multiple adjustments per Order are legitimate.
2. **AdjustmentAllocation**: native line ID and exact quantity/unit entitlement range or shipping/charge component; original net/tax/discount evidence and approved minor amount. Order-level serialization prevents overlaps between omission and whole-order cases. No mutable copy of catalogue pricing or Order totals as authority.
3. **ResolutionOperation**: designated settlement component, method, amount/currency, server key, immutable request fingerprint, provider account/mode, native/provider reference receipts, first-dispatch/deadline and recovery state. B selects exactly one eligible method per adjustment, STORE_CREDIT or ORIGINAL_PAYMENT, through server policy. Freeze designation before money movement; reject ineligible methods and switching after dispatch. Refund and credit adapters share entitlement reservation but never pretend to be the same native money movement.
4. **InventoryDisposition operation** (C): exact physical/native references and quantities, condition decision and native receipt. Separate from financial success; not an inventory balance.

Append audit through a bounded domain event pattern like OrderDecisionEvent/ShortageEvent. Corrections use superseding/adjusting records, not rewriting settled history. A lightweight per-Order financial lock/coordination row may hold revision/cursor, never a competing paid/refunded balance.

Lifecycle recommendations:

* Adjustment: REVIEW_REQUIRED -> APPROVED or NO_ADJUSTMENT; APPROVED -> RESOLUTION_IN_PROGRESS -> FINANCIALLY_RESOLVED. ATTENTION_REQUIRED records unresolved conflicts without erasing approval.
* Settlement: PREPARED -> DISPATCHED -> PROVIDER_PENDING / OUTCOME_UNKNOWN -> PROVIDER_SUCCEEDED -> NATIVE_RECONCILIATION_PENDING -> SUCCEEDED. Correlated provider failure -> FAILED_REVIEW_REQUIRED. Local state cannot prove the provider failed.
* Store credit: PREPARED -> NATIVE_DISPATCHED -> SUCCEEDED or OUTCOME_UNKNOWN/ATTENTION_REQUIRED, with exact native transaction readback. No external-provider pending fiction.
* Financially resolved means all approved allocations settled exactly and native financial evidence reconciled (or an audited zero-entitlement decision). Inventory and commercial reconciliation retain separate statuses; never call the entire case closed while required work is unresolved.

### Structural economic invariant

For every Order component and every adjustment, under PostgreSQL serialization:

`approved_adjustment = sum(designated_settlement_components)`.

`sum(settled_components + reserved_pending_or_unknown_components) <= approved_adjustment`.

Count each component once as it moves from reserved to settled. Restitution allocations are bounded by remaining original paid economics. Any goodwill entitlement requires a separately approved bounded reason/amount policy and allocation; it must not manufacture returned-item value or grant arbitrary amount overrides. Until those rules are approved, goodwill issuance is unavailable.

`approved_amount = sum(approved line/tax/shipping allocations)`; settled components have distinct native receipts and cannot overlap another settlement. A pending/unknown refund consumes its allocation. Failure does not release it until definitive terminal evidence excludes later provider movement. The same economic amount must never receive both Store Credit and an original-payment refund. There is no automatic original-payment-to-credit fallback.

Unique source identity, settlement business identity, provider key/account namespace, bound native receipt identity and allocation constraints are required. Multiple partial adjustments consume only remaining entitlement; do not merely cap each individual call at the original total. Externally initiated refunds require reconciliation and reduce available entitlement too.

## 6. Calculation and money boundary

Use frozen/native **Order** quantities, unit prices, tax lines, line/shipping adjustments, discount allocations, tax-inclusive flag, currency and version. M10 snapshot provides an immutable cross-check, but its item summary alone does not contain all tax/promotion breakdowns. Do not refresh pricing or rerun today's promotions.

At first calculation retain a typed economic evidence snapshot/version/hash linked to native source; validate consistency with completed checkout and native captures. Changes or unsupported economics fail to review, not guessed zero. Before execution revalidate no conflicting native commercial change/refund.

For omitted quantity, allocate the original net paid line amount (including its apportioned tax and discount) across integer units deterministically using integer/rational arithmetic and a stable remainder rule. Persist the allocation basis so repeated partials add up to exactly the original net amount; last allocated unit absorbs the predetermined remainder, not a newly rounded result. Allocate net/tax/discount components consistently with their native aggregate totals. Native shipping discounts/tax stay on shipping. No promotion threshold requalification or full-price refund for discounted goods. Sum-zero/free lines give zero monetary entitlement, with quantity evidence retained.

Illustrative calculation test: net paid line 1001 cents for 3 units allocates 334,334,333 by stable unit ordinal; omitting two gets the designated 668 cents, later returning the remaining unit at most 333. Exact policy must be approved before B; include inclusive/exclusive tax, line/shipping discounts, fractional native precision rejection, zero items and multiple partials. If native totals contain higher precision, use a documented decimal-to-cent allocation rule at calculation, not JS floating arithmetic or the existing strict converter as silent rounding.

| Boundary | Unit and representation | Required action |
| --- | --- | --- |
| GoSpaza adjustment/allocation | Positive integer minor units; safe integer or checked bigint/decimal persistence, zar | Exact integer sums and explicit caps; client supplies no amount authority |
| Native Order financial values | Major-unit BigNumber/raw decimal, native currency | Read native decimals; deliberate exact allocation into cents |
| Medusa refund workflow / Payment Module input | Major-unit BigNumberInput | Convert approved cents to exact decimal major-unit representation; always explicit amount |
| Medusa provider refund input | Major-unit BigNumberInput (refund.raw_amount) | Existing `cents` boundary converts once to Yoco integer cents; compare frozen operation amount |
| Yoco POST amount | Positive integer cents; original Checkout currency ZAR | Exact frozen amount, never missing/full-remaining shortcut |
| Yoco webhook amount/refundableAmount | Integer cents | No multiplication; verify amount/currency/mode/account/correlation |
| Native OrderTransaction | Signed major-unit BigNumber amount | Refund negative, unique refund reference; no raw cents passed as major units |
| Native Order credit line | Major-unit amount | Commercial balance adjustment only; must not duplicate a Return's native change |
| Store Credit transaction | **Not installed**; current docs describe major-unit decimal | Verify exact chosen plugin source before implementation; no assumed signature or custom minor-unit balance |

Existing `catalogue-policy.ts::minorPrice`, `nativePrice`, `checkout-native.ts::checkoutMoney`, `yoco/validation.ts::cents` own conversions. Reuse/expose them where valid; do not fork equivalent money helpers. Example path: approved 1000 cents -> native decimal 10.00 -> provider 10.00 -> Yoco 1000. That is one major-to-Yoco conversion, not two multiplications.

## 7. Refund execution and recovery seam

Do not call bulk refundPaymentsWorkflow or cancelOrderWorkflow to implement settlement. Prefer a small GoSpaza workflow using supported **Payment Module refundPayment** and **Order Module APIs** with designated, independently observed native steps. No direct writes to Medusa tables, no installed-package patches.

Proposed provider seam: one active native refund execution per Payment, bound server-side to a designated ResolutionOperation. Provider adapter resolves the durable operation by authoritative Payment/ProviderOperation correlation and an execution binding, compares exact amount/currency/key and requires approved state. Native refund metadata stores operation reference for readback, but is not assumed forwarded to the provider. The transient context refund ID may be bound to the operation for observation, never used as the economic key. Public/client input cannot select this binding. All native HTTP mutation bypasses must be closed before enabling it. The binding/claim must prevent a second native call from creating a second successful Refund for the same external operation; use the existing at-most-once native dispatch/readback pattern, not a time lease that grants replay after timeout.

The external request is frozen before send: account fingerprint, mode, checkout/payment/operation relationships, explicit amount, bounded opaque resolution reference metadata, serialized body/fingerprint and server-generated UUID-based key. A crash after dispatch claim but before transport is uncertain. Never select a new key to escape uncertainty.

* First send: durable claim, network outside PostgreSQL locks, record bounded response, then reconcile.
* Pending: provider throws a bounded pending result to native Payment; provisional native refund deletion is expected. The GoSpaza operation remains durable and reserves entitlement.
* Success event/readback: persist verified provider success. A later designated native call may materialize a missing native refund **without another external POST**; provider returns success only for the same proven operation. Require proof of earlier native-call termination/rollback and absence, not a single empty read while it may still be running.
* Native refund already exists: match immutable metadata/reference/amount/payment to operation, inspect native execution evidence and provider success, attach receipt; do not resend. Row alone is provisional evidence.
* Record exactly one negative OrderTransaction referencing that native refund, plus exactly one required native commercial adjustment. Designate each native step; validate amount/reference, observe after crash. History missing or ambiguous write -> attention, not another dispatch. Existing native transaction reference indexes are not a uniqueness guarantee.
* Failed/unknown native commercial reconciliation after provider success: provider remains succeeded; customer copy distinguishes refund sent from whole-case completion. Repair only missing local/native evidence; never recapture or issue another refund to fix bookkeeping.

| Failure/race | Required outcome |
| --- | --- |
| Response lost / HTTP error / process restart | Same operation remains reserved. Correlate event/readback; exact POST replay only with proven safe provider window and terminated prior native execution. |
| Pending indefinitely / webhook lost | Bounded due worker, backoff and deadline -> ATTENTION_REQUIRED; no repeated POST to learn current state from a cached response. |
| Provider key >=24h old | No automatic POST, even same key. Require verified readback/provider resolution. |
| Webhook before HTTP response | Persist first; monotonic success cannot be overwritten by stale pending/failure; reconcile same designated operation. |
| Duplicate/reordered events | Same event dedupes; conflicting payload for same ID rejected; operation-specific correlation; never assign by “latest refund of same amount.” |
| refund.failed / provider says already refunded | Reconcile actual balance/operation. No new key or credit without authoritative non-movement/resolution proof. |
| Store-credit native success/local failure | Read exact transaction reference; attach once. Missing proof -> attention; no second credit. |
| Inventory failure after financial success | Keep refund/credit succeeded and separate inventory attention; no repeat settlement. |

Existing M10 late-compensation ownership stays distinct. Its replay path currently permits pending/uncertain replay without an explicit 24h deadline in the inspected claim method; the full-amount guard limits exposure, but it is not a general safe-retry primitive. Before C shares any code, add separately scoped regression-backed replay-window protection without weakening M10's no-Order/never-dispatched criteria. A is not authorization to change it.

## 8. Webhook routing and external gates

Retain `/hooks/gospaza/yoco`, raw-body signature verification, timestamp bound, body limits, durable inbox and event-id collision check. Extend normalized refund evidence with only validated provider correlation fields required for commercial refunds. Keep payment handling and technical compensation unchanged except explicit compatible fixes.

Route a refund to exactly one operation owner: technical compensation or M18 commercial resolution. Never apply one event to both. Unknown/unmatched events stay bounded pending-correlation/attention where an HTTP receipt may arrive later; they must not cause money movement. Do not irrevocably discard a valid early event merely because a refund HTTP response is missing.

**External gate:** prove a trustworthy per-refund identifier or echoed opaque operation reference for multiple partials, including webhook-before-response and same-amount repeats. Published event examples alone do not prove this. Serializing one outstanding refund helps but does not disambiguate a delayed earlier event after another operation begins. If unavailable, repeated partial-refund automation remains disabled; use attention/readback, not a guessed match.

Freeze provider account/mode and compare current credentials by nonsecret fingerprint. No raw payment/card payloads, signatures, secrets, DOB, recipient observations, OTP or GPS in financial events or logs. Safe provider metadata is an opaque financial operation reference/version only. Never send rejection notes or compliance sub-reasons to Yoco.

## 9. Store Credit — approved MVP direction and integration gates

Neither package manifest/lockfile nor installed package directory contains `@medusajs/loyalty-plugin` or Store Credit Module; no module/plugin is configured. No account, issue/claim workflow or guest-credit path is currently usable. Native cart/order credit lines exist, but GoSpaza freezes Yoco-payable checkout economics and requires a positive provider amount; zero/part-credit checkout must be designed and regression-tested explicitly.

Routine partial omissions, successful deliveries with omissions and approved small compensation/goodwill adjustments default to **STORE_CREDIT**. Customers are not automatically offered cash versus credit. Acceptance/use of credit where applicable is not authority to choose an otherwise ineligible original-payment refund. Legal/policy-required original-tender resolution remains an explicit exception.

Frozen MVP policy, subject to a demonstrated native integration blocker:

| Property | Policy |
| --- | --- |
| Currency / recipient | ZAR only; registered customer only |
| Transfer / cash-out | Neither allowed |
| Expiry | No expiry unless legal/accounting requirements require one |
| Balance | No negative balance; native Store Credit is the balance authority |
| Issuance source | Approved financial adjustment only |
| Redemption | Usable on future GoSpaza orders |
| Duplicate issuance | Transactional prevention with immutable source/effect identity and native receipt readback |

No loyalty points, rewards, cash deposits, peer transfers, withdrawals or manual top-ups. Customer presentation may say “GoSpaza balance: R82.50”; it must project the native account, not a custom wallet table.

**Guest recommendation: B — original-payment refund as a server-authorized guest fallback**, subject to product approval and proven ownership/payment correlation. Existing GoSpaza checkout is authenticated; this is a contingency for a proven guest entitlement, not a new guest-checkout feature. Native claiming is not installed/proven, and requiring account claim/creation would add a new identity/recovery flow. This recommendation avoids anonymous reusable balances and unimplemented claim machinery. A browser assertion of guest status cannot select this exception. Pending/unknown prior settlement still blocks another method.

Prefer Medusa-native Store Credit. Before implementation, select/pin a compatible plugin version and inspect source/license/deployment availability, transaction reference uniqueness, atomic balance/debit/reservation behavior, refund hooks and lost-response recovery; review migrations/module links and native route permissions. Confirm checkout apply/remove/freeze/reconfirm, mixed tender, fully credited zero-Yoco completion and allocation to original tenders. Issuance without usable redemption is incomplete.

Plugin absence is an integration gate, not permission to silently change routine adjustments to original-payment refunds or issue unusable credit. Hold unresolved cases truthfully until supported settlement exists. A demonstrated native blocker requires an explicit architecture/policy decision; no custom balance engine is authorized. No installation or compatibility claim is made in A.

## 10. Native Return and inventory recommendation

Recommend **B: native Return only in selected physically fulfilled/returned cases**, after M17 receipt and explicit condition/disposition. It is the native commercial record, not a second custody record. Do not make omission or rejection look like a customer returned shipped goods. Native Return is not the refund transport; its balance change and M18 refund bookkeeping must be coordinated so no duplicate credit line is created.

For already received M17 goods, plan native Return/request/receive without a second return shipping option/fulfillment, exact actual shipped manifest and origin native Stock Location. Select normal versus damaged native receive actions from a separately authorized disposition. Inspect and test the full native order-change/preview result before live execution; no guessed refund on native outstanding difference. A receipt with no condition inspection stays non-sellable pending review; do not falsely label it damaged simply to suppress stock increase.

Minimal disposition vocabulary recommended: AWAITING_INSPECTION, RESTOCK_APPROVED, NON_SELLABLE. DAMAGED may be a bounded reason for NON_SELLABLE; defer separate quarantine/discard workflows and warehouse subsystem unless required. Restore sellable native inventory only through the chosen native receive operation after inspected approval. One disposition quantity cannot be restocked twice or switch from non-sellable to sellable through replay.

Rejected/unfulfilled and omitted quantities: native stock has not been decremented for those units; **release residual reservations, do not increment stock**. M16 prepares fulfillment only for picked units; native create decrements those and retains omitted residual reservations. Release only after terminal nonfulfillment/omission proof and no in-flight pickup/completion, using supported native reservation APIs and existing lock protocol. Never delete unrelated reservations. Stock availability must remain native authority.

This native integration is multi-step, not atomic with GoSpaza PostgreSQL evidence. Designate, observe and retain attention on ambiguity. Do not undo money merely because stock reconciliation failed. Native cancellation workflow is not approved as a shortcut: it initiates refunds and other effects. Any future cancellation product requires its own guarded orchestration.

## 11. Approved settlement matrix and unresolved delivery-fee policy

Shipping is a native Order shipping-method total, with native tax/discounts, captured with merchandise in M10. There is no implemented merchant payout share or driver-earnings allocation here. Customer fee is not driver compensation; do not create M19/M21 economics.

Calculate the financial adjustment from actual net paid merchandise and associated tax for eligible unprovided units; avoid punitive fees or repricing discounts. Settlement method does not change that calculation. Fee treatment is an explicit versioned platform policy, not reviewer free arithmetic.

| Case | Settlement policy |
| --- | --- |
| Partial omitted items | STORE_CREDIT by default |
| Successful delivery with omitted items | STORE_CREDIT by default for the omitted value |
| Approved small compensation / goodwill adjustment | STORE_CREDIT by default; bounded entitlement policy still required |
| Full merchant rejection after capture | ORIGINAL_PAYMENT; approved policy, no order received |
| Technical captured-payment failure with proven M10 compensation eligibility | ORIGINAL_PAYMENT through the existing M10 owner; no duplicate M18 entitlement |
| Full order definitively cannot be fulfilled | ORIGINAL_PAYMENT after authoritative operational disposition |
| Legal/policy-required original-tender refund | ORIGINAL_PAYMENT under the applicable explicit policy |
| Restricted whole-order return | ORIGINAL_PAYMENT preferred recommendation, not finalized; no automatic Store Credit; delivery-fee treatment remains explicit |
| Platform-authorized exception | Explicit financial capability and policy determine eligible settlement; no arbitrary customer choice |

All original-payment refunds remain server-authorized, idempotent, audited and provider-confirmed. Ambiguous completion or payment recovery does not establish that no valid Order can exist; preserve M10 RECOVERY_REQUIRED and technical-compensation safeguards.

The following fee/economic recommendations remain subject to approval:

| Case | Merchandise/tax/discount treatment | Delivery fee recommendation / alternatives |
| --- | --- | --- |
| Merchant rejection before fulfillment | All remaining original net paid merchandise, subtract already allocated adjustments | Full net shipping/tax refund; store/platform did not provide service |
| Terminal omissions with successful remaining delivery | Omitted units' frozen allocated net/tax only | Retain shipping by default; no duplicate tax or adjustment using the entire undiscounted gross unit price |
| All units omitted/no physical delivery | Entire remaining merchandise entitlement | Full shipping refund recommended; coordinate retained assignment separately |
| Pre-pick cancellation, if later authorized | Unfulfilled remaining merchandise | Full shipping recommended; currently no customer cancellation route |
| Platform-caused dispatch/delivery failure, once definitively stopped | Unprovided goods according to physical evidence | Full shipping recommended; attention alone does not prove stopping |
| Failed restricted handoff, whole actual manifest returned | Returned paid goods plus prior omitted entitlement, less prior allocations; no double settlement | Recommend full net shipping refund for initial MVP simplicity. Alternative retain documented service fee under explicitly approved/legal customer policy; no automatic fault inference from sensitive compliance observations |
| Customer unavailable / after-pickup cancellation | Not presently a complete reachable general policy | Keep manual review until authorized policy/physical outcome; no invented fee forfeiture |
| Ambiguous native/physical outcome | No automatic monetary decision | Attention; preserve pending reservations and evidence |

The approved method matrix above governs settlement; routine partial cases do not offer cash versus credit. Financial review may begin at RETURN_REQUIRED; recommended execution for ordinary restricted-return entitlement waits for authoritative receipt, with no automatic deadline denial. Exceptional customer-protection resolution before receipt requires explicit policy, not a hidden admin override. All fee recommendations are proposals, not asserted legal entitlements; legal/policy approval remains necessary.

## 12. Authorization and proposed APIs

Follow current native user + server-owned explicit grants (existing restricted-commerce reviewer IDs are an example, **not** a financial grant). Proposed capabilities: FINANCIAL_REVIEW, FINANCIAL_RESOLUTION_APPROVE, FINANCIAL_RECONCILE, ORIGINAL_PAYMENT_EXCEPTION_APPROVE and INVENTORY_DISPOSITION_APPROVE. Revalidate grant and native user existence in mutation. No generic edit-status endpoint or unbounded amount override.

| Actor | Permitted proposed scope | Forbidden |
| --- | --- | --- |
| Customer | Own adjustment/settlement status; accept/use Store Credit where applicable with expected revision | Amount/reason/tax/fee/key/payment/tenant authority; forcing ORIGINAL_PAYMENT; switching after movement begins; provider retry |
| Merchant OWNER/MANAGER | Own tenant-safe financial consequence/disposition reads; condition proposal if approved | Platform refund/credit, settlement accounting, provider payload |
| PICKER | Existing physical return receipt only | Financial review/approval, credit/refund, inventory restock approval |
| DRIVER | Existing custody workflow only | Financial reads or actions, recipient evidence exported to finance |
| Platform user | Explicit capabilities for review/approval/reconcile/disposition, confirmation/reason/audit | Native user authentication alone grants no M18 capability |
| Worker | Only designated approved operations | Choosing entitlements, arbitrary amount/driver/customer, new operation on uncertainty |

Proposed routes (not implemented): GET `/store/gospaza/orders/:id/financial-resolution`; POST owned adjustment `/:adjustmentId/settlement-acceptance` only if acknowledgement is required (not a cash-versus-credit selector); GET `/merchant/orders/:id/financial-resolution`; admin `/admin/gospaza/financial-adjustments` list/detail, `/:id/approve`, `/:id/reconcile`, policy-bounded original-payment exception approval, and bounded inventory-disposition decision. Domain services derive Order->Store->Customer->Payment, strict schema rejects amount/actor/tenant/financial-state mass assignment. Unknown and foreign resources are indistinguishable; all lists bounded and tenant-filtered before pagination. Private no-store projections.

Before enabling M18 money operations, guard native Admin refund/Return/order-edit/credit-line/cancellation/credit-account paths that could bypass the designated-operation policy for GoSpaza resources. Existing middleware guards native cancellation/fulfillment and store payment/cart APIs, but not all native Admin return/refund/change routes. Do not broaden grants merely because the UI hides them.

Customer concepts: review required, approved, refund processing, refund confirmed by provider (bank posting may take longer), financial resolution needs attention, native store credit issued. No raw provider errors or recipient reasons. Merchant sees bounded case/reason/amount consequence, not customer credentials or M19 payout claims. Physical-return labels remain separately visible.

## 13. Locks, transactions, recovery scheduling

M11 uses merchant -> OrderOperation -> slot. M15/M16/M17 use merchant -> driver profile -> affiliation -> availability -> OrderOperation -> picking -> Delivery -> commitment -> relevant pickup/handoff/return evidence. Preserve those prefixes; never acquire a driver/merchant lock after holding a later financial/delivery row.

For financial-only work: merchant -> OrderOperation -> per-Order financial coordination -> allocations/operations in stable ID order. Do not subsequently acquire driver, slot, inbox or native-payment locks within that transaction. If current physical state must be locked, enter through the existing pickup/recipient ordered boundary first, then append financial locks. Capture bounded immutable evidence, commit; invoke native/provider APIs outside local transactions. Re-enter the same prefix for receipt publication. Inbox ingestion commits before reconciliation; it never holds inbox then waits for merchant while another path does the reverse. Native module transactions retain native lock order. No cross-module transaction atomicity is assumed.

Two approval/acceptance calls serialize on Order coordination; same exact decision is idempotent, conflicting revisions/methods conflict. Omission and whole-return allocations share that Order lock. Two workers claim the same operation once. No timeout grants a second native dispatch. Receipt versus refund initiation rereads exact current return source; inventory disposition has its own unique native effect identity. Operational completion/cancellation races require a terminal owner decision, not a financial service that changes Delivery status itself.

Events accelerate discovery only. Use bounded durable keyset repair over rejection/omission/return evidence and due resolution operations, like current order provisioning/dispatch patterns. Duplicate source events converge by source uniqueness. Skip locked work, bounded backoff/attempts and attention after horizon; no perpetual high-frequency replay. Store source revisions and terminal receipts beyond native workflow retention. Expose age/count of attention without logging sensitive payloads.

## 14. Static security review

No runtime attacks were executed in A. These findings distinguish source-proven behavior from integration design risks; no claim of an externally exploitable anonymous endpoint is made.

* Critical confirmed vulnerabilities: none identified in this reconnaissance.
* High-impact **design blocker**: wiring M18 to the installed bulk refund workflow can publish financial transactions after a provider failure; native pending has no status representation. Source is confirmed; an M18 path does not yet exist. Use designated single-payment execution and proof-based native recording.
* High-impact **design blocker**: checkout+amount-only event matching is insufficient for repeated equal partial refunds. Existing full technical compensation does not authorize commercial partials. Require exact operation correlation or fail closed.
* Medium **potential weakness / launch boundary**: native Admin Return/change/refund routes are not all constrained by GoSpaza finance capabilities. A trusted native user could bypass future commercial/disposition policy; test/close those paths before enabling M18. Yoco's current technical-only guard already blocks ordinary unauthorized provider refunds, so do not claim current anonymous refund access.
* Medium **recovery design concern**: existing technical replay lacks an explicit provider key-retention horizon. Do not copy it for partial refunds; resolve with a separately tested compatible change in execution scope.
* Low/hardening: bounded native/provider errors, exact money types, body/list limits, private projections and protected event retention remain mandatory, not an excuse to log raw evidence.

| SOURCE -> TRANSFORMATION -> TRUST BOUNDARY -> SINK | Required proof/test |
| --- | --- |
| Browser acceptance/line IDs -> strict schema + owned eligible allocation -> authenticated customer + PostgreSQL reservation -> designated settlement | BOLA, forged amount/currency/customer/store/payment/key, stale acceptance, ineligible method rejection, refund-vs-credit race |
| Native Order + terminal source -> deterministic net/tax/discount allocation -> immutable version/hash and cumulative caps -> approved adjustment | Catalogue price changes irrelevant; rounding and repeated partials cannot over-credit; omitted/returned overlap rejected |
| Admin command -> explicit capability/confirmation/reason -> Order locks and audit -> approval/native step | BFLA, removed grant, mass assignment, direct native bypass, repeated decision |
| Yoco bytes -> signature/timestamp/schema -> account/mode/operation correlation + event dedupe -> provider outcome | Spoof/replay, currency mismatch, same-amount old event, webhook-before-response, mismatched body fingerprint |
| Durable operation -> frozen key/body and single dispatch -> provider idempotency window -> refund POST | Lost response, duplicate worker, expiry beyond 24h, failed/succeeded conflict; never create new key on timeout |
| Settled provider receipt -> native proof/readback -> serialized native registration -> Refund/OrderTransaction/credit line | Provisional row not success; local crash cannot re-refund; order transaction repair not duplicate |
| M17 receipt + condition decision -> exact manifest/disposition -> origin tenant + native inventory contract -> stock/reservation change | Receipt alone never restocks; two dispositions race; non-sellable quantities and omitted residuals remain separate |
| Native credit transaction -> exact reference/amount/account -> ownership and entitlement lock -> issued-credit projection | No credit+refund duplication, wrong customer/currency, lost native response, double-spend redemption |

Financial audit allowlist: native Order/Payment and operation references, bounded reason, exact amounts/currency, actor/grant, timestamps, provider refund reference/status. M17 finance reason is RESTRICTED_HANDOFF_FAILED, not school-uniform/DOB/document/observation details. Notes never authorize amounts and must be bounded/redacted from customer/provider projections.

## 15. M19 handoff

After M18's verified completion, M19 may consume immutable native Order/Store linkage, original economic version, exact approved allocations, net/tax/discount components, settled original-payment amount, issued native-credit amount, shipping adjustment, resolution method, native/provider receipts and financially-resolved timestamp. Include separate inventory/commercial reconciliation state and superseding corrections.

M19 must not infer money from Delivery phase, merchant receipt, financial_review_required=false, refund HTTP acceptance or UI copy. Pending/unknown operations remain liabilities under M19's future ledger rules, not settled refunds. M18 records no commission, merchant payable, bank transfer or driver earnings. An original-payment refund and store-credit issuance are different economic outcomes, even when their customer-facing value is equal.

## 16. Implementation slices and acceptance gates

| Slice | Bounded deliverable | Gate |
| --- | --- | --- |
| A | This source-backed contract, policy recommendations, security/recovery findings | User reviews decisions below |
| B | Adjustment/source/allocation/decision models and migrations; exact frozen-Order calculation; server-derived STORE_CREDIT/ORIGINAL_PAYMENT eligibility; strict APIs/RBAC; audit; duplicate-source and cross-method reservation concurrency | No money-moving adapter, credit issuance, restock or new cancellation UX |
| C1 | Original-payment execution, provider correlation, inbox routing/recovery and native Refund/OrderTransaction/commercial bookkeeping | Provider per-refund proof; key-retention limits; native lost-response tests; bypass guards |
| C2 | Source-verified pinned native Store Credit integration, usable redemption boundary, native Return/disposition/residual reservation reconciliation | Plugin source/availability, approved credit policy and any required acknowledgement, fee/disposition policy; no duplicate native financial effects |
| D | Bounded admin/customer/merchant UX; security/privacy/API/real-DB/concurrency/browser and full regression | All critical C gates exercised, not only mocks |

C1/C2 are proposed subdivisions of M18-C because payment uncertainty and plugin/inventory integration are independently large boundaries. No C work is authorized by approving A or B. Store Credit is the approved routine settlement direction, not an optional refund-default add-on. Any source blocker or deferral requires explicit policy/acceptance revision; unavailable issuance is never complete.

Required later tests: source dedupe/backfill; actor/tenant known-ID attacks; exact discounted/taxed partial allocations and overlapping reasons; negative/overflow/currency inputs; same/opposite decisions; refund-vs-credit concurrency; provider pending/lost/failed/succeeded ordering; replay horizon; multiple equal partials; out-of-band refund; native provisional refund and lost bookkeeping; native route bypass; zero/full/mixed-credit checkout if enabled; returned normal/damaged quantities; omitted reservation release without stock increase; valid/invalid deferred branches reaching COMMIT; privacy/UI durable reload. Preserve M9–M17 suites. No manual DB/Redis clearing, sleeps, weakened prerequisite assertions or arbitrary retries.

## 17. Approved policy and remaining decisions

Approved: routine partial compensation is store-credit-first; captured full merchant rejection uses original-payment refund; M10 technical compensation stays with its existing owner; B models server-controlled method eligibility; customers cannot force methods or switch after movement; no duplicate compensation. Store Credit MVP restrictions in section 9 and the B/C1/C2/D boundaries are retained.

Remaining product decisions:

1. Finalize whole-order restricted-return settlement (ORIGINAL_PAYMENT recommended) and delivery-fee treatment. Other fee recommendations also need explicit versioned approval; sensitive recipient observations must not imply fault or forfeiture.
2. Approve guest fallback B as recommended in section 9 if guest entitlements become reachable; no anonymous balance or new guest flow is authorized.
3. Specify bounded goodwill reasons, amount limits and approval authority before enabling those entitlements. The STORE_CREDIT destination is approved; arbitrary compensation amounts are not.
4. Confirm detailed financial approval grants/acknowledgement requirements and restricted-return execution timing (receipt first recommended; exceptional earlier resolution requires policy).
5. Confirm original-net allocation/rounding rules and condition/disposition authority: merchant may propose condition, explicit platform inventory capability approves; custody alone never restocks.

External/source gates remain native Store Credit version compatibility and redemption/recovery proof, Yoco per-refund correlation/readback and native financial reconciliation. They do not justify changing the approved default or duplicating native authority.

B remains unimplemented and requires explicit authorization with applicable unresolved policy addressed. It can represent method eligibility/unavailability and attention without fabricating provider capabilities. No general cancellation UX is implied.

## 18. Answers to the twenty reconnaissance questions

1. Capture: verified Yoco payment.succeeded; native Capture recorded during reconciliation before successful completion and merchant acceptance.
2. Rejection: refund of captured money, not a provider void; operational rejection currently performs neither.
3. Partial refund: explicit positive major-unit amount to Payment Module, capture-minus-refunds guard, provisional Refund then provider; repeated calls create separate native refunds.
4. Safe idempotency: no caller-level durable refund key/status in installed DTO/model. Provide a server-designated operation and proof-based adapter/native registration, not transient refund.id.
5. Provider refunds: full technical compensation only, already pending-aware; no general partial product flow.
6. Identifier: durable yocoCheckoutId/checkout_id for POST; original yocoPaymentId for correlation.
7. Pending/failed: durable operation states retaining entitlement, never successful financial resolution or automatic credit fallback.
8. Events: existing payment events plus correlated refund.succeeded/refund.failed, same signed inbox, expanded partial-refund correlation.
9. Units: section 6; native major decimal versus GoSpaza/Yoco integer cents; Store Credit plugin boundary must be verified when pinned.
10. Store Credit: absent and unconfigured; credit lines are present but are not accounts.
11. MVP credit: registered-customer store-credit-first routine settlement, ZAR, no expiry unless legal/accounting requirements mandate expiry, no transfer/cash-out/negative balance/rewards; approved adjustments only, transactional duplicate prevention and native redemption integration, subject to source compatibility.
12. Financial sources: M11 rejection, M13 terminal omissions, M17 failed/returned manifest; additionally M10 and M15/M16 recovery cases listed in section 4.
13. Omitted value: original native discounted/taxed line economics with stable per-unit allocation and cumulative remaining caps; no current Product prices.
14. Fees: section 11 recommendations require product approval; no customer-fee-to-driver-earnings equation.
15. Return: selected fulfilled returned goods only, after receipt/condition; not omissions/rejection; financial effects coordinated separately.
16. Sellable stock: only after explicit condition approval plus exactly-once native receive/restock proof. Never from custody alone.
17. Double settlement: per-Order serialization, unique source/effect identities, overlapping allocation exclusion and settled+pending+unknown <= approved remaining entitlement.
18. Actors: customer owns status and applicable credit acceptance/use, never method/amount authority; merchant owns limited tenant reads/custody, no refund; platform requires explicit financial capabilities; driver/PICKER no finance.
19. M19 trust: immutable source/economics/allocation and terminal native/provider receipts, not physical/UI/request state.
20. Product input: remaining decisions in section 17; external correlation/readback/plugin proof remains explicit and fail-closed.

## 19. A verification and files

Only this milestone document was revised for the approved store-credit-first policy. No production, tests, schema, migration, dependencies or environment files changed. No verification command was executed. User-reported M17 completion is accepted; A does not require rerunning M17 or the entire monorepo.

No verification commands are required for this policy-only revision. Review sections 5, 9, 11, 12, 16 and 17. Later implementation slices must provide exact existing package scripts and environment-grouped verification commands; no test script is invented here.

## 20. M18-B implementation and frozen C handoff

### Authority and policy refinement

The B prompt freezes guest original-payment fallback and restricted whole-order original-payment eligibility. Registered partial omissions use STORE_CREDIT; full merchant rejection and completed all-omitted picking use ORIGINAL_PAYMENT. Goodwill is platform-created, registered-customer STORE_CREDIT only, with explicit amount and bounded reason. It starts REVIEW_REQUIRED and needs a separate approval capability. No customer method-choice mutation exists.

Recipient-caused restricted returns retain shipping. MERCHANT/PLATFORM-proven whole nonfulfilment includes native shipping net and tax. The bounded M17 recipient failure codes map to CUSTOMER_RECIPIENT inside Marketplace; no raw recipient observation is copied into financial models, events or DTOs. COMPLIANCE_RECOVERY_REQUIRED does not prove commercial fault: a received return with that cause remains REVIEW_REQUIRED/POLICY and generic approval cannot override it. There is no existing authoritative platform-cancellation/cause adjudication source to import; B does not invent one from text or a dispatch attention flag. Legal-policy exceptions likewise require an authoritative policy source, not client claims.

M17 DELIVERY_ADDRESS_MISMATCH also remains REVIEW_REQUIRED/POLICY: the existing boolean does not establish recipient attribution. No fee forfeiture is inferred from it. A later explicit, authoritative cause decision is required.

M10 compensation remains exclusively M10-owned. B requires a successfully completed native Order link and therefore creates no second entitlement for no-Order technical compensation. No historical financial movement is imported or replayed.

### Models, source identity and economic boundaries

Migration `Migration20261028120000.ts` adds `financial_adjustment` and `financial_adjustment_event` to Marketplace. These are entitlement and audit records, not native Refunds, payment transactions or customer balances. Native Order identity is retained through the existing OrderOperation/completion relationship; no redundant native link or commerce table is introduced.

Source uniqueness is `(source_type, source_id, source_revision, reason)`:

* ORDER_REJECTION: immutable OrderOperation rejection/revision with decision evidence.
* TERMINAL_OMISSION: noninvalidated M13 resolution/revision after authoritative picking completion.
* ALL_OMITTED: completed picking session/revision; one full entitlement including shipping, instead of simultaneous partial entitlements.
* RESTRICTED_RETURN: immutable M17 custody ID, after RETURNED_TO_STORE and merchant receipt audit; allocation covers the transported/picked units only. Earlier omitted units remain a distinct nonoverlapping entitlement.
* GOODWILL: platform request identity, with immutable actor/order/input fingerprint; changed-input replay conflicts.

Core facts are immutable even during review. Only REVIEW_REQUIRED -> APPROVED with revision increment is exposed. APPROVED never implies value issued. B has no settlement execution records; DTO reserved/settled values are zero and `execution_available=false`. No mutable remaining-balance column exists. C must add its operation components under the same Order lock, deriving reserved/settled totals and enforcing their sum <= approved amount before enabling execution. B's immutable allocation envelope and source identity remain unchanged.

The database enforces tenant/OrderOperation linkage, source uniqueness, component sums, unit-range nonoverlap within/between adjustments, matching economics fingerprints, aggregate entitlement <= original paid Order value, immutable economics, and an audit row for each revision through a deferred constraint. Deletion of financial history and audit mutation/deletion are rejected. Goodwill cannot consume more than the configured order-relative ceiling or push total adjustments over original paid value; a later conflicting full entitlement fails closed for review rather than rewriting prior goodwill.

### Native calculation and rounding

`financial-native.ts` uses the existing supported Order read with recorded items/tax lines/adjustments and shipping methods/tax lines/adjustments. Medusa 2.18 `item.total` is the discounted tax-inclusive line total; `item.tax_total` supplies its tax. MERCHANDISE is total minus tax. Native shipping method total minus tax forms DELIVERY_FEE, with a separate TAX component keyed to shipping. No Product, current Price, Promotion engine, Tax configuration or ServiceZone price lookup participates.

Native line quantities/totals and aggregate total/tax are checked against the immutable M10 checkout snapshot; the native captured Payment is read through Payment Module and matched to M10's capture receipt. Prior native refunds fail closed for C reconciliation. Existing `minorPrice`/`checkoutMoney` centralize exact decimal-to-cent conversion, reject sub-cent/negative/unsafe values, and never multiply floating-point money. Account eligibility comes from native Customer.has_account; lookup failure is not guest evidence.

Each line/component uses integer division over stable unit ordinals. First `amount % quantity` ordinals receive the remainder cents. Picked units occupy `[0,picked)` and omitted units `[picked,ordered)`. Returned physical units use the former range, preventing omission/return overlap. Example 1001 net cents over three units allocates 334,334,333; tax is allocated independently by the same rule. Component sums equal adjustment totals, with no current promotion repricing.

### Authorization, routes and transaction order

Server-controlled grants follow the existing explicit user-ID capability pattern; native User existence is revalidated. Default grants are empty:

* `FINANCIAL_VIEW_USER_IDS`
* `FINANCIAL_APPROVE_USER_IDS`
* `FINANCIAL_GOODWILL_CREATE_USER_IDS`
* `FINANCIAL_GOODWILL_MAX_BPS`: explicit integer 1–10000; unset/invalid disables goodwill. No arbitrary fixed currency cap is assumed.

Merchant reads reuse M4 MERCHANT_ORDER_VIEW (OWNER/MANAGER); PICKER/DRIVER receive no finance capability. Customer reads use M11 native customer ownership plus completed-order identity before materializing an adjustment. Store/merchant/customer IDs and economic fields cannot be assigned from payloads.

Routes:

* GET `/store/gospaza/orders/:id/financial-resolution`
* GET `/merchant/orders/:id/financial-resolution`
* GET `/admin/gospaza/orders/:id/financial-resolution`
* GET `/admin/gospaza/financial-adjustments` (bounded pagination)
* POST `/admin/gospaza/orders/:id/goodwill`
* POST `/admin/gospaza/financial-adjustments/:id/approve`

Approval/goodwill use one Medusa workflow step owning an atomic Marketplace transaction; no financial compensation step can reverse committed entitlement. No refund, credit issuance, generic state-edit or customer settlement-choice route exists.

Lock order: merchant -> OrderOperation -> existing picking source locks where applicable -> financial adjustment. Financial code never acquires driver locks after financial locks. Existing source owner validates completed picking. Scope/revision/policy is reread under locks. PostgreSQL uniqueness and allocation checks are final guards. Read-time ensure is restricted to one authorized Order; list does not scan native Orders or run unbounded repair.

### Security review and coverage

SOURCE (native completed Order + terminal Marketplace evidence) -> TRANSFORMATION (exact net/tax/unit allocation and bounded cause) -> TRUST BOUNDARY (ownership/capability and PostgreSQL Order lock) -> SINK (immutable entitlement + audit). Customer/admin payloads cannot supply source economics or settlement eligibility. Goodwill is the explicit exception for a bounded platform-specified amount, never a customer amount.

No confirmed critical/high vulnerability is claimed from static review. C release blockers remain provider correlation, native settlement reconciliation, Store Credit integration and native financial-route bypass guards. B introduces no provider transport or credit/stock mutation. Projections omit provider/session/workflow IDs, raw source receipts, recipient details, GPS and credentials. Domain failures use bounded HTTP errors.

Added `financial-policy.test.ts` covers conversion, odd-cent net/tax allocation, method/guest policy, bounded causes, shipping eligibility, goodwill configuration and independent grants. Added `verify-financial-adjustments.ts` composes existing M10/M11 assertions and exercises real omission/rejection sources, source dedupe, automatic/manual approval, native customer/merchant API isolation, PICKER denial, strict query validation, changed-input replay, exact SQL uniqueness, independent-connection row-lock contention, economic/audit immutability and deferred audit failure. Finance writes stay inside rollback transactions; deferred checks are explicitly forced. The verifier does not delete finance history, clear shared state or disable triggers. These checks are not a claim that concurrent committed settlement or C provider behavior has been tested.

### User verification

No commands were run by Codex. No migration or runtime pass is claimed. Stop at each failure.

A — repository root, stop Next dev servers before generated type checks/builds:

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — all workspace checks pass.
3. `pnpm --filter @gospaza/backend run test` — backend unit suite passes, including financial policy.

B — PostgreSQL/Redis available, local test-mode configuration; migrate before restarting backend:

4. `pnpm --filter @gospaza/backend run db:migrate` — new financial migration applied.
5. Start/restart only the backend with `pnpm --filter @gospaza/backend run dev` in a separate terminal; retain existing verified local test configuration, including disabled payment reconciliation worker and test Yoco credentials.
6. `pnpm --filter @gospaza/backend run test:financial-adjustments` — financial domain verifier plus its preserved M10/M11 prerequisites pass. Verifier grants/configuration are scoped to its own process and restored; no production capability grants are required.
7. `pnpm --filter @gospaza/backend run test:recipient` — preserve the M17 physical-return regression. No frontend servers are needed.

No browser or UI work belongs to B. C1 receives immutable entitlement/allocations/default method/source/cause and must correlate native/provider evidence without a second refund. C2 receives registered identity and Store Credit entitlement plus physical disposition prerequisites, and must implement native redemption/Return handling separately.

## 21. M18-C1 execution boundary — investigation, not implementation

C1 is authorized for original-payment refund execution only. No Store Credit, native Return, stock disposition, financial UI, commission, settlement or notifications are authorized. No verification commands have been executed by Codex.

### Reconfirmed provider evidence and unresolved correlation

Re-inspected the installed 2.18.0 Payment Module and local Yoco adapter. Native `refundPayment` creates a provisional Refund, calls the provider with that Refund's ID as `context.idempotency_key`, deletes the provisional Refund on provider exception, and updates collection totals on successful return. Refund metadata is not passed as an operation selector to the provider. Neither provisional native row existence nor an accepted/pending provider response proves settlement. Existing M10 full technical compensation remains unchanged.

Rechecked the official [refund endpoint](https://developer.yoco.com/api-reference/checkout-api/checkout/refund-checkout) and [partial-refund event](https://developer.yoco.com/api-reference/checkout-api/webhook-events/refund-notification-success-partial) on 2026-10-29. The endpoint documents integer-cent amount, optional metadata, Idempotency-Key and response `refundId`. The event example uses an event-like `payload.id` and metadata containing `checkoutId`; it does not establish an equality between that ID and HTTP `refundId`, or an echo contract for the refund request metadata. This is an unresolved documentation question, not proof that Yoco cannot supply correlation.

Required external evidence: a provider-confirmed field contract or a redacted, authentically received refund request/response/event sequence establishing the operation-specific correlation. For metadata correlation, distinguish refund-request metadata from metadata inherited from the original checkout. Include success/failure semantics and the case where the webhook precedes response processing. Do not initiate a live monetary test merely to obtain this evidence without explicit authorization. Never share provider secrets, signing secrets, card data or customer identity data.

### Frozen safety decisions for C1 implementation

- Consume approved B entitlement; never recalculate it from mutable catalogue or browser values.
- Reserve entitlement and freeze one server-generated operation/key/request before transport. Pending, lost-response and unknown outcomes retain reservation. A timeout cannot authorize another POST or a new key.
- Distinct equal-value partial operations cannot be correlated using amount, checkout or Order alone. Missing or ambiguous correlation must remain unresolved/ATTENTION_REQUIRED; it cannot create native refund accounting or settle entitlement. A previously successful operation must not consume a later operation's event.
- Preserve the existing signed raw-body ingress and durable inbox. Do not add a weaker webhook endpoint. Do not assume `payload.id` is the response `refundId`, invent an echoed metadata field, or manufacture provider lookup support.
- A separately frozen native-recording designation must ensure that recovery after provider success cannot call the money-moving transport again. Native Refund and OrderTransaction writes must use supported native APIs, exact readback and serialization. Do not use the plural refund workflow as settlement authority.
- Existing M10 technical compensation is not migrated into C1 and must be excluded from duplicate economic execution.
- C2 receives the unchanged approved entitlement, allocations, eligibility and the eventual authoritative reservation/settlement projection; it must not reinterpret an uncertain C1 refund as free entitlement.

The positive end-to-end C1 acceptance claim is deferred until safe operation-specific provider correlation is established. No RefundOperation migration, execution endpoint, provider mutation or automated refund worker has been introduced by this investigation. Failure-closed handling remains the required behavior; this section does not claim C1 completion or runtime verification.

## 22. M18-C2 compatibility inspection — implementation pending

The complete C2 prompt authorizes Store Credit settlement for approved B entitlements, future-order redemption and independently recoverable inventory disposition. C1 remains isolated; no refund correlation or execution changes are permitted. Registered customers only, ZAR only, no expiry/transfer/cash-out/manual funding. Restricted whole-order returns retain ORIGINAL_PAYMENT eligibility; physical receipt must not cause Store Credit issuance. Goodwill has no inventory effect. Omitted units are not returned fulfilled units and must not receive artificial stock increments.

Repository inspection found no Loyalty/Store Credit dependency in the backend manifest or pnpm lockfile. The official [v2.18.0 plugin manifest](https://github.com/medusajs/medusa/blob/v2.18.0/packages/plugins/loyalty/package.json) names `@medusajs/loyalty-plugin` version `2.18.0` and pins framework/Medusa peers to `2.18.0`. This is version alignment evidence, not a completed runtime or concurrency compatibility test. Do not install the unpinned latest version or infer newer single-account workflow APIs.

The [versioned service](https://github.com/medusajs/medusa/blob/v2.18.0/packages/plugins/loyalty/src/modules/store-credit/service.ts) exposes account statistics and credit/debit transactions with `reference` and `reference_id`. Its debit implementation reads balance and then inserts a debit in a transaction; that source alone does not establish serialization of concurrent balance consumers. Transaction scope alone is insufficient proof. Model constraints, workflow locks, compensation, account/customer links, cart application and completion hooks must be inspected from the exact packaged artifact before choosing the integration boundary.

Several versioned source files were unavailable through web retrieval. Next prerequisite: user installs the exact backend dependency with `pnpm --filter @gospaza/backend add --save-exact @medusajs/loyalty-plugin@2.18.0` and returns the output for peer/version review. Do not register the plugin or migrate yet: registration may expose native routes/hooks requiring GoSpaza authorization and checkout guards. Codex has not run installation or verification. No package manifest, lockfile, runtime configuration, model, route or financial behavior was changed during this inspection.

C2 is not complete. Native Return/disposition design, issuance/recovery/idempotency, redemption including zero-external-payment behavior, database enforcement, API boundaries, tests and the D handoff remain outstanding. No custom wallet or duplicate balance authority is authorized by this inspection.

### Installed 2.18.0 review, 2026-10-30

User supplied a successful exact-version installation result. The package is now readable at `apps/backend/node_modules/@medusajs/loyalty-plugin`; its manifest reports `2.18.0`. The reported Vite/picomatch peer warnings are under the existing Medusa dependency tree, not a reported Loyalty/framework version mismatch. No plugin registration or migration was performed. Installation success is not C2 verification.

Inspected packaged `.medusa/server/src` files (source-map trailers excluded):

- `modules/store-credit/models/store-credit-account.js`: native customer/currency account, optional code and metadata, transactions; customer/currency uniqueness. Native schema permits a null customer, so GoSpaza must enforce registered-customer-only policy at its boundary.
- `models/account-transaction.js` and all seven Store Credit migrations: native numeric amount/raw amount, credit/debit type, account, reference/reference_id, note and metadata. No unique economic reference or aggregate nonnegative-balance constraint found. Reference fields alone do not establish issuance idempotency.
- `modules/store-credit/service.js`: `creditAccounts` creates native credit transactions; `retrieveAccountStats` aggregates native transactions; `debitAccounts_` checks positive amount and current balance before inserting a debit. No account row/advisory lock or explicit serializable isolation is present in that path.
- `workflows/carts/workflows/confirm-cart-credit-lines.js` calls the debit workflow; `workflows/store-credit/workflows/debit-accounts.js` calls the debit step directly. Inspection of packaged non-admin JavaScript found no account-lock wrapper. Two independent debit transactions can therefore both pass the same balance check before either insert commits. This is a source-established race in the unguarded native path, not a claim that a runtime race test was executed or that GoSpaza currently exposes it.
- `workflows/store-credit/steps/{credit-account,debit-account}.js`: compensation calls `module.deleteTransactions(ids)`. The concrete service declares no such method. Installed framework `utils/dist/modules-sdk/medusa-service.js::buildMethodNamesFromModel` generates `deleteAccountTransactions` for the registered `AccountTransaction` model. The interface's `deleteTransactions` declaration does not create a runtime alias. The packaged compensation path has a source-level method mismatch.
- `workflows/carts/workflows/add-store-credits-to-cart.js`: derives account by cart customer/currency, caps applied credit at cart total, creates native `store-credit` credit lines and refreshes cart. This is application of credit, not a reservation of balance.
- `workflows/hooks/complete-cart-before-payment-authorization.js`: debits through `confirmCartCreditLinesWorkflow` during native completion and cancels that workflow on compensation. Enabling this unchanged would inherit the debit/compensation issues above.

Conclusion: package version compatibility is confirmed, but stock registration is not yet safe for C2's concurrent-redemption and rollback requirements. Keep it unregistered. Do not patch node_modules, upgrade dependencies, introduce custom balance persistence, or treat this finding as authorization to weaken the requirements. A supported integration must establish a PostgreSQL transaction-coupled account boundary and exact-operation recovery, and use a valid compensation API. Whether a narrow supported GoSpaza extension can do so remains to be established before enabling the plugin. C1 is unchanged. No runtime verification was executed, no C2 acceptance claim is made, and no production Store Credit path is exposed.

### C2 continuation: extension-seam report before implementation selection

The user requires the exact extension seam to be returned before choosing implementation, and requires passing serialization, compensation and issuance proofs before plugin registration. Those are explicit gates; source inspection is not a substitute for the user-run proof.

Installed-source seam: import the explicitly exported native module `@medusajs/loyalty-plugin/.medusa/server/src/modules/store-credit`, whose default export exposes `.service`; subclass that class in a GoSpaza module exported through `Module("store_credit", { service, loaders })`. The installed modules-sdk loader reads a module's exported service and supports explicit connection/container loaders. Framework `ModulesSdkUtils.mikroOrmConnectionLoaderFactory` accepts native entities and a migration directory. This provides a candidate extension without copying a balance implementation or modifying installed files. Native model/resource reuse and migration loading must be demonstrated in an isolated bootstrap before production registration. Setting `discoveryPath` to the stock module is NOT an override: `resolveModuleExports` reimports that module, and `loadResources` obtains its stock service.

Transaction seam: the installed `InjectTransactionManager` decorator uses `baseRepository_.transaction` and passes a `Context.transactionManager`; when already supplied, it preserves that transaction. A subclass can acquire native account rows with `transactionManager.getTransactionContext()("store_credit_account").whereIn("id", sortedIds).orderBy("id").forUpdate()` before calling the native balance check and mutation with the SAME context. Reject unsupported isolation/context rather than silently falling back to an unscoped connection. At READ COMMITTED the post-lock balance statement observes the preceding holder's committed debit. All affected accounts must be locked in stable ID order. Locks must cover compensation and credits as well as debits.

Required coverage includes generated `create/update/upsert/delete/softDelete/restoreAccountTransactions` entry points, not just `debitAccounts`. Arbitrary transaction mutation must be denied or routed through the same validated boundary. Native checkout confirmation reaches the service through container resolution, but all public native Store Credit/admin/cart routes require boundary review before enabling. Internal account/transaction CRUD must not become an alternate financial API.

Compensation mismatch is generated-name/interface/workflow drift: the interface and credit/debit step compensation name `deleteTransactions`; the concrete model key generates `deleteAccountTransactions`. The generated delete accepts exact primary-key IDs and optional context, delegates to the native internal service and returns void. A compatibility alias can delegate those exact IDs under the same account lock only after validating operation ownership and post-removal balance. Blind deletion of a credit already consumed by a concurrent debit is unsafe even with the corrected method name; it must fail closed into recovery instead of making the balance negative. An isolated workflow-failure proof must show only that execution's transaction is removed and historical transactions survive.

Implementation selection, adapter code, isolated database proofs, StoreCreditOperation issuance and production registration remain pending. No runtime commands were run in this continuation. Inventory/native Return work remains part of C2 after the required Store Credit safety proofs; it is not dropped or moved into D.

## 23. M18-C2A — guarded native Store Credit primitive

The approved C2A request supersedes the preceding investigation-only gate. C2A implements the safe module adapter and executable proofs; runtime verification remains user-owned. C2B is NOT implemented. C1 stays paused at the Yoco correlation gate; D is not started.

### Native ownership and registration

`src/modules/store-credit/service.ts` subclasses `.service` from the explicit 2.18.0 Loyalty Store Credit module export. `index.ts` exports `Module("store_credit", ...)` with explicit SDK connection/container loaders. Native `StoreCreditAccount` and `AccountTransaction` DML objects are reused via `MedusaServiceModelObjectsSymbol` and `toMikroOrmEntities`. No copied entity, wallet, balance column, dependency patch or custom Store Credit schema exists.

Both runtime connection loading AND migration execution explicitly point to the installed native migration directory. Migration discovery otherwise uses the wrapper directory despite the connection loader's migration path. SDK `buildMigrationScript`/`buildRevertMigrationScript` delegate to the native migrations. No `discoveryPath` points at the stock module. `medusa-config.ts` registers only this wrapper. The Loyalty plugin itself, its routes, admin funding surfaces, gift cards and checkout hooks are not registered. Runtime verifier asserts the resolved service is the GoSpaza subclass.

### Transaction, precision and lock boundary

For a fresh call, native `baseRepository_.transaction` opens READ COMMITTED and supplies its MikroORM PostgreSQL EntityManager as both `manager` and `transactionManager`. A caller-supplied transactionManager is preserved. Account locks use that manager's `getTransactionContext()` (Knex transaction), never `getKnex()` fallback. Unsupported/missing transaction state or isolation fails closed.

Collect every account ID, deduplicate, sort lexically, then acquire individual `SELECT ... FOR UPDATE` locks in that order before mutation. Credits, debits and compensation use this same boundary. Independent accounts have no global lock. A multi-account caller must submit its complete account set in one batch; callers composing further account mutations in an existing transaction must maintain the same global account order.

After locks, debit prevalidates aggregate batch consumption per account (including repeated IDs), then calls native `debitAccounts_` with the exact shared context. Its installed transaction decorator preserves the supplied manager; the native stats call, internal transaction create and flush therefore participate in the locked transaction. Native `creditAccounts_` is likewise called with that manager. Public underscored methods are guarded as well as their native public wrappers.

Native balance remains the aggregate of native transactions. The pinned native statistics method narrows SQL numeric SUM to JavaScript Number. The adapter overrides only that readback to preserve the SAME native aggregate as decimal strings (valid native `BigNumberValue`), preventing rounding at the debit boundary. No cached/parallel balance exists. Validation reuses M18-B `financialMinor`/the existing strict native decimal boundary; arithmetic uses decimal MathBN, never floating-point money multiplication. Amounts are positive, exact cents and within existing safe minor-unit bounds. Account currency must be exactly `zar`; anonymous accounts cannot transact. Account creation accepts customer/currency/metadata only, preventing nested transaction/initial-balance mass assignment.

### Mutation-surface audit (pinned 2.18.0)

All methods below are internal DI service methods, NOT HTTP authorization. Trusted application code is responsible for actor/customer/entitlement authority. No C2A route accepts account or transaction IDs from users.

| Method | Credit effect | Debit effect | Remove/change history | Reachability and protection |
| --- | --- | --- | --- | --- |
| `creditAccounts`, `creditAccounts_` | Yes | No | No | Native workflow/internal callers; positive cent validation, registered-customer-linked ZAR account, sorted account locks, native insert in shared transaction |
| `debitAccounts`, `debitAccounts_` | No | Yes | No | Native workflow/internal callers; same locks, batch sufficiency check and native balance check/insert under the same manager |
| `createAccountTransactions` | Possible in stock | Possible in stock | Can fabricate history | Rejected with `STORE_CREDIT_MUTATION_RESTRICTED` |
| `updateAccountTransactions` | Possible | Possible | Yes | Rejected |
| `deleteAccountTransactions` | Removing debit increases balance | Removing credit reduces balance | Yes | Rejected; only exact guarded compensation calls the native superclass implementation |
| `softDeleteAccountTransactions`, `restoreAccountTransactions` | Potential history effects | Potential history effects | Yes | Rejected; no reliance on the stock aggregate's soft-delete behavior |
| `deleteTransactions` | Reverses exact debit | Reverses only proven-safe exact credit | Exact IDs only | Native StepResponse compensation adapter; locks all affected accounts, re-reads IDs, validates reversal, delegates exact IDs to native deletion |
| `createStoreCreditAccounts` | No initial balance allowed | No | No | Registered-customer-linked, ZAR-only, strict field allowlist; native overload return shapes retained |
| `updateStoreCreditAccounts` | Could change financial owner/currency | Could change financial owner/currency | Identity mutation | Rejected, including metadata edits for this slice |
| `deleteStoreCreditAccounts`, `softDeleteStoreCreditAccounts`, `restoreStoreCreditAccounts` | Could affect linked history | Could affect linked history | Cascades/ownership | Rejected |
| `upsertAccountTransactions` | N/A | N/A | N/A | Not generated/exposed in installed 2.18.0; regression asserts absent |
| `retrieve*`, `list*`, `listAndCount*`, `retrieveAccountStats` | No | No | No | Native reads retained; stats precision override described above; actor projections belong to C2B |

The native internal repository/service and direct SQL are not actor-facing interfaces. Calling those behind the adapter, enabling stock plugin routes, or resolving a second stock service would violate this boundary. C2A does not claim to constrain an attacker with database credentials or arbitrary server execution.

### Exact compensation and recovery

Native credit/debit steps return exact transaction IDs in their compensation StepResponse. Their `deleteTransactions(ids)` call is repaired by the adapter: exact bounded ID array → discover account identities → sorted account locks → re-read exact transactions → validate → `super.deleteAccountTransactions(exactIds, sameContext)`. No amount/customer/timestamp/latest-transaction matching occurs. Already-absent exact IDs are idempotent. Historical equal-value credits are untouched.

A credit is automatically removable only when its account has no debit history and the native balance covers all selected credits. This is deliberately conservative: native transaction history does not allocate debits to credit provenance, so replenishment or timestamps cannot establish that a credit was unspent. Any debit history makes removal ambiguous. Such compensation throws bounded `STORE_CREDIT_ATTENTION_REQUIRED`, preserves native credit/debit history, and creates no compensating money. Native workflow compensation failure remains unresolved in stored workflow execution evidence; the integration proof requires readback of that evidence. An insufficient balance is not represented as a completed rollback.

C2A has no FinancialAdjustment settlement operation yet. C2B MUST persist the same recovery condition on its StoreCreditOperation and retain the entitlement reservation; neither a caught exception nor a failed workflow permits another issuance. Reference fields alone are NOT duplicate-issuance protection. Credits remain a trusted primitive until C2B adds transactional operation identity/reservation and authoritative native readback.

When all mutations share an outer DB transaction, its rollback is authoritative and no extra compensation is performed. Native workflow steps normally commit separately, so exact compensation is necessary for later workflow failure. The verifier exercises both paths and verifies native insert visibility plus disappearance after outer rollback.

C2A verification correction: the user-run outer-rollback proof exposed that native credit creation persists entities without flushing. With an outer transaction still open, SQL balance readback saw the original R20 instead of R70 and rejected the following R30 debit. The adapter now explicitly flushes the SAME transaction manager after native credit creation, before returning. This neither commits nor releases locks. The proof additionally checks SQL-visible credit rows and R70 before the debit, then retains its R40 and complete outer-rollback assertions. The earlier CLI tsconfig-paths warning did not prevent execution and is separate from this failure. Runtime re-verification is pending.

C2A retention correction: the subsequent user run reached the spent-credit durable-history assertion but found zero execution rows. Installed Redis workflow storage `save()` deletes a finished root execution when `retentionTime` is absent, even with `store: true`; failed compensation can finish the engine execution without resolving the financial problem. The verifier's two proof workflows now explicitly retain execution evidence for 86,400 seconds. The proof also checks the requested transaction identity, persisted state and retention value, while preserving the exact-row and recovery-error assertions. This is a verifier configuration fix, not a change to native Store Credit or compensation policy. C2B must retain unresolved StoreCreditOperation/entitlement reservations independently of finite native workflow-history retention; workflow expiry or engine `failed` state never authorizes another issuance. No runtime verification was executed by Codex.

### Security review: SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK

- Trusted debit batch → strict shape/cent validation → locked native account + live balance → native debit insertion. Stock negative-balance race addressed by PostgreSQL serialization; real concurrent proofs added, not yet executed.
- Internal generic CRUD → explicit rejection → no repository sink. Prevents direct debit, negative credit, reassignment, restoration and historical mutation bypass through the exported service.
- Native compensation IDs → exact-ID validation/re-read → same account lock + conservative reversibility → exact native deletion or bounded recovery failure. Addresses missing native alias and spent-credit rollback; historical amount equality is never correlation.
- Module config → local wrapper + explicit native-resource loaders → DI `store_credit` → guarded subclass. Stock routes/hooks stay unregistered; runtime identity proof added.
- Customer/account identity → trusted module input, no user route in C2A. C2B must derive authoritative registered customer and adjustment ownership; the primitive cannot establish actor authority from an account ID alone.

No current public abuse path is introduced by these internal APIs. Stock-service race and unsafe compensation are material integration hazards fixed at the adapter boundary, pending runtime proof. No claim is made that economic issuance idempotency or customer BOLA is complete before C2B. No secret, GPS, OTP, M17 recipient data or provider payload is included in errors or new logs. No unresolved credible external CRITICAL/HIGH/MEDIUM finding identified in the static C2A boundary review; runtime acceptance remains outstanding.

### Proofs and user-run verification

Added `tests/store-credit-policy.test.ts`: deterministic lock order, strict amounts/currency, mass assignment, guarded generated mutations, conservative reversal and native workflow type compatibility.

Added standalone `verify-store-credit-adapter.ts`: runtime subclass resolution; real R80/R80, R50/R50 and R100/R100 races; underscored debit race; unrelated-account progress while another row is locked; reversed multi-account order; direct CRUD denial with unchanged native balance; duplicate-account batch overdraw; shared-manager outer rollback; actual native credit/debit workflow compensation; historical +20/+50 retention; spent +100/-80 recovery with stored workflow evidence; compensation-vs-debit race; nonnegative native balances after supported paths. Uses barriers, not arbitrary sleeps. The bounded test deadline detects a stalled proof, not production correctness. Run only against development/test data. Scoped native financial fixture history is intentionally retained, not destructively cleared.

Commands from repository root, in order; stop on any failure:

1. No dev servers: `pnpm run lint` — zero errors/warnings.
2. No dev servers: `pnpm --filter @gospaza/backend run typecheck` — zero TypeScript errors.
3. No dev servers: `pnpm --filter @gospaza/backend run test` — backend unit suite passes.
4. PostgreSQL/Redis running, backend/Next servers stopped: `pnpm --filter @gospaza/backend run db:migrate` — native Store Credit migrations apply successfully. Do not manually create tables.
5. PostgreSQL/Redis only; APP_ENV development/test: `pnpm --filter @gospaza/backend run test:store-credit-adapter` — standalone C2A pass message. No HTTP backend is required by this verifier.
6. No dev servers: `pnpm --filter @gospaza/backend run build` — backend build succeeds.
7. Start backend only using the existing verified test environment (PostgreSQL/Redis plus configured M10 secrets; payment reconciliation worker disabled). Run `pnpm --filter @gospaza/backend run test:financial-adjustments`, then `pnpm --filter @gospaza/backend run test:payment-reconciliation` — existing B/M10 acceptance remains green with the safe module loaded. No Next stack or browser suite is required for C2A.

No verification commands were run by Codex. No dependency installation, migration execution, commerce data mutation, server startup or commit was performed by Codex.

### Frozen C2B handoff

C2A supplies the native safe mutation primitive only. After C2A user verification, C2B owns FinancialAdjustment → settlement reservation → StoreCreditOperation → exact issuance/reconciliation, registered customer authorization, future checkout redemption including fully credit-funded native completion, API projections, native Return decision and independent inventory disposition. It must preserve M18-B approved-amount allocation, C1 uncertain reservations, no double compensation, M10 authoritative payment semantics and M17 custody. Use stored workflow recovery plus durable StoreCreditOperation attention; never retry credit solely because a local response was lost. No direct caller-controlled native account/transaction IDs, whole-plugin registration or generated CRUD bypass is authorized. Inventory, native Return, C1 Yoco execution, UI, and D remain unimplemented.

## 24. M18-C1 implementation — confirmed Checkout refund correlation

This section supersedes the historical C1 external gate and the final sentence of the preceding handoff for **C1 only**. The user confirmed C2A user verification before authorizing this C1 work. C2A is preserved. C2B, D, native Return/inventory disposition, finance ledgers, settlements, earnings and notifications remain outside this slice.

### Provider facts and configuration

The user's supplied Yoco support evidence establishes:

- `POST /api/checkouts/:checkoutId/refund` accepts an integer-cent amount and refund metadata; HTTP 202 with `refundId` acknowledges creation, not settlement.
- Response `refundId` is webhook `payload.id`. Top-level `event.id` identifies the inbox event. `payload.paymentId` is a separate consistency check.
- Refund metadata is echoed, merged over Checkout metadata. Freeze `gospazaRefundOperationId` and `gospazaRefundAttemptId` in each exact request.
- Same request/key replay is guaranteed for 24 hours, including original error responses. Transport uncertainty is not a provider rejection.
- A confirmed provider rejection proves that request did not create a refund. A later explicit retry may create a new attempt/key; an unknown outcome may not.
- Only one processing refund per Checkout is permitted.
- Optional Business API readback uses `business/orders:read`, a separate credential, date-bounded `/v1/refunds` pagination and `client_transaction_id == Checkout refundId`. Its resource ID is different from Checkout `refundId`.

No Business API credential, lookup integration or speculative correlation is introduced. Missing final events enter attention after the 24-hour window; unknown requests cease replay. A later correctly correlated signed event can still establish the original attempt's outcome. Manual investigation must not be interpreted as permission to mint a new key.

`FINANCIAL_EXECUTE_REFUND_USER_IDS` is an explicit platform-user allowlist, empty by default. VIEW/APPROVE/GOODWILL grants do not imply execution. `REFUND_RECOVERY_WORKER_ENABLED=false` by default; opt in only intentionally. Existing signed inbox processing continues to use the M10 payment reconciliation worker. Yoco configuration, environment mode and frozen account fingerprint must match. No new dependencies or credentials are added.

### Authority, models and lifecycle

`financial_settlement` is the shared reservation owner for ORIGINAL_PAYMENT and future STORE_CREDIT. It links an approved FinancialAdjustment, frozen method/currency/amount and RESERVED/SETTLED/RELEASED status. The adjustment row is locked by its database trigger. Sum of RESERVED + SETTLED cannot exceed the approved amount. C1 always reserves the complete approved adjustment and never releases an uncertain or failed refund reservation automatically. C2B must reuse this owner, not invent a second available-entitlement calculation.

`refund_operation` is one economic refund per adjustment. It freezes order/customer/store, original native Payment/Capture, provider operation/Checkout/payment, account fingerprint, mode, ZAR amount and settlement reference. It is coordination/evidence, not a parallel payment ledger. States are CREATED, REQUESTED, UNKNOWN, FAILED_NOT_CREATED, FAILED, PROVIDER_SUCCEEDED, ATTENTION_REQUIRED and SETTLED. SETTLED requires exact native Refund and OrderTransaction references, verified provider evidence, reservation conversion and audit in one local commit.

`provider_refund_attempt` is the network request identity: attempt number, immutable key, exact JSON, SHA-256 fingerprint, schema version, first-send time, lease, provider refund ID and event reference. Parent identity freezes Checkout/payment/currency/amount. A new attempt is allowed only after FAILED_NOT_CREATED, with the caller's expected prior attempt number. Replaying that authorization returns the already-created next attempt. Unknown, pending or final-failed attempts cannot acquire a new key through this command.

`refund_event` is append-only, revision-unique audit: operation/adjustment/order/customer/store, actor or system, amount/currency, bounded action/state/attention reason and timestamp. Deferred constraints require the final revision's audit, matching settlement state and correlated APPLIED success event. Native commerce tables receive no direct GoSpaza writes.

The new migration is `Migration20261030120000.ts`; it is forward-only. No applied migration has been rewritten.

### Execution, inbox and crash recovery

1. Re-read authoritative M10 completion and native economics; require APPROVED and ORIGINAL_PAYMENT eligibility from B. Reject any M10 technical-compensation relationship or unknown native refund.
2. Lock merchant → OrderOperation → provider operation → FinancialAdjustment → RefundOperation/attempt. Reserve entitlement and freeze request, then commit before HTTP.
3. Atomically claim the attempt; network uses only frozen request/key. 202 → pending, recognizable completed provider rejection → FAILED_NOT_CREATED, timeout/lost/malformed/gateway outcome → UNKNOWN. Idempotency-mismatch 422 remains unknown, not proof permitting a new key.
4. M10 raw-body HMAC/timestamp verification and durable inbox remain the ingress owner. C1 handles its events before technical compensation. Primary match is `refundId`; early response-loss correlation requires both frozen operation and attempt metadata. All supplied identifiers, payment, Checkout, amount, currency, mode and account must agree. Neither payment ID nor Checkout+amount authorizes matching.
5. Signed success advances to PROVIDER_SUCCEEDED, never HTTP 202 or a redirect. Conflicting terminal evidence is rejected/held for attention. Duplicated event IDs and same-outcome events create no duplicate effect.
6. Native accounting is dispatched at most once per durable stage. A second worker rereads the claim; a provisional row is not enough. Missing/ambiguous results retain entitlement and enter attention. An explicit RECONCILE may retry exact readback of a missing native result but cannot repeat its dispatched native mutation or create another provider request.

Recovery runs on a bounded, opt-in minute job (20 due operations). Pending attempts are revisited at their final-event deadline rather than starving later work. Unknown sends reuse the same body/key strictly inside 24 hours, stopping 60 seconds early to budget for the 15-second HTTP deadline and transit/queue time. Reaching that conservative limit requires attention, not a fresh key. Sending leases prevent concurrent ordinary sends; provider idempotency remains the boundary if a process stalls past its lease. No sleep, browser timer, Redis state or process-local mutex authorizes financial progress.

### Pinned Medusa accounting boundary

Installed 2.18.0 `Payment.refundPayment` inserts a provisional Refund, invokes the provider, then updates the PaymentCollection. The stock single-payment refund workflow subsequently maps all historical refunds using the current input amount; C1 deliberately does not use that bulk mapping.

C1 calls supported `Payment.refundPayment` **only after signed external success**, with the exact native refund metadata. The provider's new record-only branch validates the native-generated refund ID against the designated C1 operation, native payment/amount, verified attempt and provider refund ID. It cannot call Yoco HTTP. The old M10 technical compensation branch remains unchanged.

Medusa passes native Refund ID but not Refund metadata into its provider callback. The narrowly documented exception is a read-only lookup of that native Refund in `PgYocoOperationStore`; it performs no native SQL mutation. The native callback binds one exact Refund ID. Recovery requires that binding, matching metadata/amount, and completed native collection refund accounting, not simply existence of a provisional row.

The owning Order module records one negative OrderTransaction referencing **that single Refund ID** through `addOrderTransactions`. Exact-reference readback recovers a lost result without mapping old refunds or issuing a second native write. Original commercial item prices/totals and immutable B economics remain unchanged; this slice does not create a commercial Return, edit Order prices, or infer cancellation. Customer financial resolution is projected from the approved adjustment plus verified settlement, not from an outstanding-balance guess.

### API, projections and security review

`POST /admin/gospaza/financial-adjustments/:id/refund` accepts only confirmed EXECUTE / RECONCILE / RETRY_NOT_CREATED intent, its bounded reason and (for a new retry) expected prior attempt number. Platform actor and current EXECUTE_REFUND capability are rechecked. The native `/admin/payments/:id/refund` route is blocked so it cannot bypass the policy. No customer/merchant/driver refund execution route exists.

Existing customer/merchant owned-order financial projections derive reserved/settled amounts and optional PENDING/SUCCEEDED/FAILED/ATTENTION_REQUIRED refund status. They do not expose refund-operation IDs, keys, native/provider references or attention internals. Admin execution returns bounded adjustment/status/amount/currency/attention reason. No raw provider errors or payloads, keys, DOB, recipient observations, documents, OTP or GPS enter the new audit/logging path.

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

- Admin intent → strict schema/current capability → approved B entitlement/native M10 proof → locked reservation/frozen attempt. Forged amount/method/customer/provider fields are rejected.
- Signed raw webhook → normalized event → exact attempt/ID/payment/account/mode/money checks → local state/audit. Unknown or conflicting identifiers cannot settle an amount.
- Network result → bounded recognized response → pending/not-created/unknown distinction → durable attempt only. Success copy never authorizes settlement.
- Verified refund → one durable native dispatch → native-generated exact Refund and OrderTransaction readback → local SETTLED/reservation conversion. Unknown native results cannot authorize second money movement.
- Customer/merchant order request → existing owner/RBAC boundary → allowlisted financial DTO → no foreign order or provider internals.

Static review corrected duplicate-worker provisional-read timing, stale retry-intent replay and pending-row repair starvation during implementation. No confirmed unresolved external CRITICAL/HIGH/MEDIUM finding identified in this static review. This is not a claim of runtime security acceptance; user-run tests remain required.

### Tests and verification status

Added `refund-policy.test.ts` for exact request identity, integer money, strict 24-hour boundary, capability separation, mass assignment, signed identity normalization/tampering/staleness and mocked transport outcomes. Added `refund-native.test.ts` for exact single-refund accounting amid historical equal-value refunds, incomplete collection accounting and mismatch rejection.

Added `test:refund-execution` real PostgreSQL/native verifier composed after existing M10/M11 assertions. It exercises same-key recovery, no implicit retry, explicit versioned new-key retry after confirmed non-creation, bad correlation, replayed failure, reservation over-allocation/cross-method denial, a separate connection's lock conflict, deferred audit/reservation rejection, early signed webhook, and real native Payment/Refund/OrderTransaction readback after deliberately lost responses. Financial history uses enclosing rollback transactions with deferred constraints explicitly executed; native fixtures use the parent's existing cleanup. No financial audit deletion or constraint disabling is used. The separate-connection proof checks lock exclusion; it is not represented as two independently committed financial settlements.

C1 implementation has not been executed by Codex. Migration, typecheck, lint, unit/native/integration behavior require user verification. C2A's user-verified implementation was not changed.

### Exact user-run commands (repository root; stop on every failure)

A. **No dev servers running** (avoid concurrent Next generated-state writes):

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — all workspace typechecks pass.
3. `pnpm --filter @gospaza/backend run test` — unit suite passes, including refund policy/native tests.
4. `pnpm --filter @gospaza/backend run build` — backend build succeeds.

B. **PostgreSQL/Redis running, backend and Next stopped**:

1. `pnpm --filter @gospaza/backend run db:migrate` — applies C1 coordination schema/constraints.
2. `pnpm --filter @gospaza/backend run test:store-credit-adapter` — verified C2A regression passes; no HTTP backend required.

C. **Backend only plus PostgreSQL/Redis**; development/test configuration, test-mode Yoco, existing verified M10 secrets/return URLs. Set both `PAYMENT_RECONCILIATION_WORKER_ENABLED=false` and `REFUND_RECOVERY_WORKER_ENABLED=false` in backend/verifier configuration before starting the backend. The verifier grants only its temporary user's execution capability inside its own process and substitutes Yoco transport; do not grant live financial credentials.

1. `pnpm --filter @gospaza/backend run test:refund-execution` — C1 pass message; existing composed M10/M11 prerequisite assertions pass.
2. `pnpm --filter @gospaza/backend run test:financial-adjustments` — B entitlement/ownership/audit regressions pass.
3. `pnpm --filter @gospaza/backend run test:payment-reconciliation` — standalone M10 regression passes.
4. `pnpm --filter @gospaza/backend run test:recipient` — M17 return-custody regression passes with unchanged financial ownership.

No browser stack is required for C1. D owns UI/browser acceptance. Successful user output, not static inspection, establishes verification.

### Frozen C2B / D handoff and limitations

C2B must consume `financial_settlement` under the same adjustment boundary and retain uncertain reservations. It must not issue Store Credit against a C1 reserved/settled entitlement or interpret FAILED/UNKNOWN as released. C2A primitives alone do not establish issuance idempotency. C1 does not change the frozen routine partial-compensation STORE_CREDIT policy. Future mixed Store Credit/Yoco funding must extend the authoritative funding receipt/allocation boundary: Store Credit-funded value is never Yoco-refundable value, and restoration of previously spent credit must not be routed through C1.

D receives immutable adjustment economics, shared reservation totals, bounded refund status, explicit admin execution/recovery command, and attention states. No browser assumes that refund acceptance is success. No customer financial-success copy is permitted before SETTLED.

Business API secondary readback, manual evidence resolution, automatic system creation of new refunds, commercial Return/inventory disposition, Store Credit issuance/redemption, customer/admin UI and browser tests remain unimplemented. The production worker recovers already-authorized operations only. Missing native outcomes can deliberately require attention instead of another write. No commit/merge or later milestone work is included.

### C1 file manifest

Modified:

- `apps/backend/.env.example`
- `apps/backend/package.json`
- `apps/backend/src/api/middlewares.ts`
- `apps/backend/src/lib/financial-http.ts`
- `apps/backend/src/lib/financial-native.ts`
- `apps/backend/src/lib/financial-service.ts`
- `apps/backend/src/lib/payment-reconciliation-service.ts`
- `apps/backend/src/modules/marketplace/financial-policy.ts`
- `apps/backend/src/modules/marketplace/provider-operation-store.ts`
- `apps/backend/src/modules/marketplace/service.ts`
- `apps/backend/src/modules/yoco/registered-service.ts`
- `apps/backend/src/modules/yoco/service.ts`
- `apps/backend/src/modules/yoco/types.ts`
- `apps/backend/src/modules/yoco/webhook.ts`
- `packages/contracts/src/financial.ts`
- `milestones/MILESTONE_M18_REFUNDS_ADJUSTMENTS_STORE_CREDIT.md`

Added:

- `apps/backend/src/api/admin/gospaza/financial-adjustments/[id]/refund/route.ts`
- `apps/backend/src/jobs/refund-recovery.ts`
- `apps/backend/src/lib/refund-native.ts`
- `apps/backend/src/lib/refund-service.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261030120000.ts`
- `apps/backend/src/modules/marketplace/models/financial-settlement.ts`
- `apps/backend/src/modules/marketplace/models/provider-refund-attempt.ts`
- `apps/backend/src/modules/marketplace/models/refund-event.ts`
- `apps/backend/src/modules/marketplace/models/refund-operation.ts`
- `apps/backend/src/modules/marketplace/refund-policy.ts`
- `apps/backend/src/modules/marketplace/refund-repository.ts`
- `apps/backend/src/modules/marketplace/settlement-repository.ts`
- `apps/backend/src/modules/yoco/refund-transport.ts`
- `apps/backend/src/scripts/verify-refund-execution.ts`
- `apps/backend/src/workflows/refund-adjustment.ts`
- `apps/backend/tests/refund-native.test.ts`
- `apps/backend/tests/refund-policy.test.ts`

## M18-C2B product settlement and returned inventory

C1 and C2A were user-verified before this slice. Native Medusa 2.18.0 Store Credit remains the sole balance owner. GoSpaza coordinates adjustment settlement and checkout funding. Store Credit is registered-customer, ZAR-only, non-transferable and has no MVP expiry or cash-out.

### Issuance and recovery

The platform user needs the explicit ISSUE_STORE_CREDIT grant. The command accepts confirmation and an adjustment identifier. It locks the approved FinancialAdjustment, verifies the registered native Order customer and economic snapshot, and reserves the entitlement through the same financial_settlement used by C1. Restricted whole-order returns are ineligible for this destination. Guests retain their original-payment eligibility where the approved adjustment allows it.

One StoreCreditOperation per adjustment freezes the source Order, customer, store, currency and minor units. CREATED precedes ISSUING. SETTLED requires native readback. ATTENTION_REQUIRED preserves the reservation on uncertainty. FAILED does not represent successful payment. Revision events commit with local transitions. Native account creation serializes per customer and native mutation serializes per account. Each credit carries reference gospaza-financial-settlement and the operation ID. Recovery compares the exact native row, account, type, currency and amount. Duplicate, deleted or mismatched evidence blocks settlement. Local reservation, operation and audit updates are separate from the native transaction. Reconciliation after a lost response uses that same reference.

### Redemption and cash boundaries

GET /store/gospaza/balance returns the authenticated customer's native balance in minor units. POST accepts only use_balance. The current customer cart, currency, native total and balance determine the native cart credit line. Confirmation freezes its identity, gross, credit and external payable. Pay revalidates ownership and debits under the account lock, atomically recording the native debit identity against the attempt. Order completion checks the native Order credit line, redemption receipt and captured external amount. A closed unpaid attempt can restore its exact debit once. Ambiguous payment or completion retains the debit for review.

R100 funded by R63.42 credit requires a real R36.58 Yoco capture. Full-credit checkout and external remainders below the Yoco minimum are refused before applying balance. The current M10 completion proof requires a genuine payment and capture. Future mixed-funded cancellations require separate restoration of credit-funded value and refund of the eligible cash portion. New original-payment execution on mixed funding is blocked pending that allocation.

### Returned stock

The native Return decision is option C. Pinned Medusa return confirmation can create a return fulfillment and confirm an OrderChange. Receipt confirmation can also adjust native inventory. Running those steps following M17 receipt would create a second path for custody and stock. The M18 disposition therefore references the existing M16 fulfillment and M17 terminal receipt.

An authenticated OWNER or MANAGER with MERCHANT_INVENTORY_MANAGE chooses RESTOCK or NON_SELLABLE for an owned returned fulfillment line. The server derives component quantities and location from the shipment. A unique disposition, durable dispatch claim and revision evidence precede the native inventory command. A lost inventory response requires operational attention. Retrying a disposition cannot dispatch a second stock adjustment. NON_SELLABLE leaves stock unchanged. PICKER retains physical receipt authority only. Goodwill and unfulfilled merchant rejections create no return disposition.

Terminal M13 omissions can release exact residual native reservation IDs after physical fulfillment is terminal, or after proof that nothing was picked. The release verifies ordered, picked and missing quantities against native fulfillment, inventory components and location. Reservation release creates no stock increment. Its bounded worker is opt-in. Inventory processing never holds a financial lock or retries a Store Credit operation.

### Security and D handoff

Customer intent passes through authenticated ownership checks before the native balance or cart mutation. Platform issuance passes through capability, approved adjustment, shared reservation and native readback. Merchant disposition passes through active membership, tenant lock, terminal custody, fulfilled line and durable dispatch claim before native inventory. Projections exclude provider credentials, native transaction identifiers, personal compliance evidence and location. The customer adjustment projection distinguishes pending credit, credit added and review pending.

D consumes adjustment status, settlement, C1 refund status, credit status, owned balance, native checkout credit and tenant-scoped disposition. Browser UX and final acceptance remain gated on user-run verification. The credit checkout verifier intentionally retains its immutable financial history and requires a disposable test database and explicit opt-in.

### Checkout and settlement concurrency acceptance

The user verified C2B, including the retained-history checkout and dedicated credit races. Temporary trace hooks were removed.

* One current cart per customer is an application invariant. With R100 available, the R80/R80 scenario races two independent Pay executions on one legitimate confirmed checkout frozen at R80 credit. The verifier requires one R80 debit, R20 remaining balance and one matching Order funding receipt. Two successive legitimate R50 checkouts each race their own Pay executions. The verifier requires a distinct R50 debit attributed to each checkout and its completed Order, with R0 remaining after the second checkout.
* Each FinancialAdjustment has exactly one eligible settlement method, its default. PostgreSQL enforces `eligible_methods = jsonb_build_array(default_method)`. The verifier races ORIGINAL_PAYMENT and STORE_CREDIT commands on each of two separate R100 adjustments, one per default method. Only the eligible command may reserve entitlement or create financial effects. The ineligible command must reject before reservation, provider execution or native Store Credit mutation. Across all races, `reserved + settled <= approved`.
* Caller-selected partial settlement amounts are unsupported. R60/R60 and R60/R40 submissions must both reject without financial effects. These cases verify input rejection.
* Pay takes the customer cart advisory lock, then the merchant commerce lock. The confirmation branch validates the address and delivery reservation before committing PAYMENT_PENDING. The native debit transaction locks the checkout attempt before the credit account. Refund preparation takes merchant, OrderOperation, ProviderOperation and FinancialAdjustment locks before reserving and creating the refund. Refund updates lock ProviderOperation, FinancialAdjustment, RefundOperation and the applicable provider attempt. Credit issuance reserves under the FinancialAdjustment lock, commits, then locks the native account in its own transaction. Local finalization locks FinancialAdjustment, financial_settlement and StoreCreditOperation. The native credit transaction reads the source without taking the financial row locks. The verifier preserves the existing lock timeouts and retry policy.
* Real concurrent Pay and settlement calls use independently committed transactions. The durable debit, settlement and adjustment histories reject deletion. A wrapping rollback would either hide fixtures from the other connection or leave independently committed records behind. Run on an isolated test database that permits retained fixtures; the same retained-history database may be reused. Refund transport is substituted locally. Keep refund recovery disabled on the serving backend and verifier.

### M25 checkout hardening handoff

* On the instrumented Windows test backend, checkout prepare completed through commit and response serialization in 32.696 s. The verifier aborted at 30.031 s. Native shipping-method attachment took 10.286 s, item/tax refresh took 8.264 s and cart update took 5.888 s. Profile these workflows under representative load in M25. The credit-races, payment-initiation and standalone payment-reconciliation verifiers give checkout prepare POSTs a 45 s deadline, including the M10 prerequisites composed by credit-races.
* Investigate the pg warning about issuing a query on a client already executing another query separately. Its call site and contribution to checkout latency are unverified.
* Measure advisory-lock admission waits separately from time spent holding locks. Earlier runs showed short-lived contention and transactions open for roughly 9–10 s after acquiring a lock. The sampled cart session in this completed request had no PostgreSQL blocker.
* The temporary backend prepare trace was removed after the M10 prerequisite passed. Pay maps a timeout acquiring its outer customer-cart advisory lock to HTTP 409 CHECKOUT_ALREADY_PROCESSING. A competing Pay may also enter after commit and read the same ready attempt. Either outcome still requires a single native debit, external checkout POST and correctly funded Order.

## M18-D role-specific financial UX

Customer Order detail shows adjustment reason, amount, method and published outcome. Mixed funding comes from the validated checkout snapshot. Account balance comes from native Store Credit. Checkout submits a balance-use choice and shows the server quote. Physical return, rejection and omission copy directs the customer to the financial outcome.

Merchant Order detail shows cause and settlement status after existing tenant and Order checks. Stock decisions require MERCHANT_INVENTORY_MANAGE and terminal store receipt. The portal refetches authoritative stock state after submission.

The platform queue and Order detail require the financial VIEW grant. Detail shows up to 30 adjustment events for the Order, with action, actor class and time. Up to 50 recorded stock decisions are visible only with the additional FINANCIAL_VIEW_DISPOSITION_USER_IDS grant. The financial console is read-only.

Balance history is represented by issuance and funding on individual Orders. No account-wide transaction statement is exposed. D adds no financial tables, endpoints or settlement transitions. Real API proofs and component tests precede separate browser and final privacy/security acceptance.

### M18-D browser and privacy acceptance gate

The dedicated browser suite signs in to the customer, merchant and admin applications against a loopback test backend. Its fixture retains synthetic Orders from the existing financial, checkout and recipient verifiers. The fixture substitutes the Yoco transport for reproducible refund outcomes. Browser reads and actions use the real role APIs. Replaying merchant disposition writes requires a fresh fixture because completed decisions are durable.

| Source | Transformation | Trust boundary | Observable result |
| --- | --- | --- | --- |
| Customer session and requested Order | Resolve native ownership and project the financial adjustment and funding | Customer Order API | Own mixed funding and settlement are visible. Known foreign and unknown Orders disclose no financial result. |
| Merchant identity and requested Order or returned line | Check active membership, store ownership, receipt and disposition capability | Merchant Order and return APIs | Foreign resources are denied. PICKER cannot decide stock. Confirmed write results are refetched. |
| Platform session and requested queue or detail | Check financial VIEW and separately check disposition permission | Platform financial API | Stock decisions are omitted without the additional grant. Removing it from an existing session preserves authorized financial access. |

Code-level verification was user-confirmed. Final browser acceptance remains pending until both the targeted suite and the live permission-revocation scenario pass. M25 retains the slow native checkout workflow, advisory-lock timing and PostgreSQL concurrent-client-query deprecation investigations.
