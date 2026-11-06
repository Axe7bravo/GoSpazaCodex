# M22 — Notifications

## 1. Status, authority and scope

M22-A through M22-D are approved, complete and user-verified. M22-E is authorized and implemented pending final user verification, as recorded in [M22-E acceptance](M22_E_ACCEPTANCE.md). M22 remains open until that acceptance passes. The approved input is [M22 architecture audit](M22_NOTIFICATIONS_ARCHITECTURE_AUDIT.md), including its Resend amendment. This contract and the approved M22-A instruction supersede audit recommendations where they differ, particularly retention, preferences and the exact message matrix. M21 is user-verified complete.

The A slice changed documentation only. B implements the foundation described in section 27; C implements source/recipient/template mapping in section 28; D implements execution/repair/read operations in section 29; E adds role-specific presentation and final acceptance in section 30. No M8–M21 commerce, dispatch, compliance or finance redesign is authorized. Verification remains user-run and no commit is authorized.

## 2. Core architecture and ownership

The frozen flow is:

```text
authoritative committed domain fact
→ durable GoSpaza NotificationIntent
→ frozen recipient/content/channel decision
→ NotificationDeliveryAttempt
→ provider evidence
→ delivery state
```

For EMAIL, the transport path is Medusa Notification → a small Resend provider adapter. Resend is the initial transport, not domain truth. Domain subscribers must not import/call Resend. IN_APP uses durable application publication without an external provider.

Order, delivery, refund, native Store Credit, settlement and driver-payment owners remain authoritative. Notification failure never rolls back, reverts, compensates or invalidates their committed operations. A failed delivery notification does not undo delivery; failed refund email does not undo a settled refund. No provider work runs inside their financial/cart/dispatch transaction or locks. Notification work may fail independently and be repaired.

Medusa ownership decision: installed 2.18 Notification/provider types and persistence were inspected in the audit. Medusa owns email transport abstraction/receipts. It does not supply GoSpaza source admission, actor-owned in-app reads, stale-state policy or due/ambiguity repair. Minimal GoSpaza intent/attempt/read state is justified; no commerce or financial source of truth is duplicated. SendGrid is unused transitive infrastructure and is not selected or removed by M22-A.

## 3. Channels and mandatory policy

Initial channels are exactly IN_APP and EMAIL. IN_APP is the primary durable operational surface for authenticated actors. EMAIL is selected customer transactional communication via Resend. No routine merchant, driver or platform email is enabled. Dispatch must never depend on email or on a browser receiving an alert in time.

All mapped notices are service/transactional. No marketing system, opt-out system or preference center is included. No channel, frequency or digest preferences are implemented. Required service notices cannot be disabled through marketing preferences. Authorization suppression, invalid contacts and provider/configuration failures are distinct from user preferences. Mandatory policy never authorizes disclosing to a revoked actor or an arbitrary destination.

SMS, WhatsApp, mobile push, campaigns, newsletters, support inboxes and emergency-email broadcasting are outside initial M22. No guaranteed closed-browser driver alert is promised. Existing polling/revalidation and original operational APIs remain usable and authoritative; notifications do not replace them.

## 4. Exact customer audience/channel matrix

IN_APP recipients are authenticated registered customers owning the source Order. EMAIL may target the same customer's authoritative committed contact, or a proven guest Order contact under section 8. Each channel is independently planned and settled.

| Notification kind | Authoritative source/readback | IN_APP | EMAIL | Meaning / exclusions |
|---|---|---|---|---|
| ORDER_CONFIRMED | M10 terminal checkout completion SUCCEEDED/native done/receipt, attempt COMPLETED, valid native Order/customer/store/reservation handoff | Yes | Yes | Order confirmed, not merely payment initiated/authorized or raw order.placed. |
| ORDER_REJECTED_OR_UNFULFILLABLE | M11 committed REJECTED decision; or M13 proven completed all-omitted/full-unfulfillable outcome through its owning domain | Yes | Yes | Bounded inability to fulfil; no implied refund or credit. One notice per distinct proven source outcome, not per retry. |
| DRIVER_ASSIGNED | M15 committed winning ASSIGNED commitment, current delivery/generation/customer relation | Yes | No | Assignment update; no acceptance authority, private driver evidence or GPS. |
| ORDER_PICKED_UP | M16 SHIP operation SUCCEEDED/native done, proven PICKED_UP and picked_up_at | Yes | No | Customer wording may say “Out for delivery”; that is the same fact, not a second notification/state. PICKUP_REQUESTED/DISPATCHED is insufficient. |
| DELIVERY_COMPLETED | M16 completion SUCCEEDED/native done, exact native receipt and DELIVERED/delivered_at | Yes | Yes | Proven completion only; not driver click or workflow start. |
| DELIVERY_FAILED_OR_RETURN_REQUIRED | M17 committed RETURN_REQUIRED custody outcome with customer-safe projection | Yes | No | Restricted delivery could not be completed; return is required. No raw observations or financial promise. Generic failed-delivery variants require an existing authoritative customer-visible source; none is invented. |
| REFUND_CONFIRMED | M18 refund_operation SETTLED, exact provider/native accounting evidence and financial settlement | Yes | Yes | Original-payment refund confirmed by authoritative state, not API acceptance/webhook ingress alone. |
| STORE_CREDIT_ISSUED | M18 store_credit_operation SETTLED, exact native transaction/account and settlement match | Yes | Yes | Approved amount/currency credited to GoSpaza balance, not a second balance ledger. |

No additional customer notification kinds are approved in A: no arrival notice, offer, routine picking/shortage transition email, merchant settlement, driver earnings, internal exception or generic payment-failure email. Existing order/shortage/arrival/recovery UI remains intact. Adding a kind/channel requires a contract revision, not interpretation of a raw event name. Customer DELIVERY_FAILED_OR_RETURN_REQUIRED is not automatically recreated on each return progress update.

## 5. Exact merchant audience/channel matrix

All rows below are IN_APP only; merchant EMAIL is deferred. Resolve active authorized membership within the source merchant/store. OWNER/MANAGER eligibility always also requires the existing capability for the resource/action. No new role grants are implied. PICKER receives only the explicitly relevant operational rows below, never finance.

| Kind | Committed source / applicability | OWNER / MANAGER | PICKER |
|---|---|---|---|
| NEW_ORDER_REQUIRING_ACTION | M10 valid Order handoff + M11 PENDING_ACCEPTANCE; currently actionable | Current MERCHANT_ORDER_DECIDE members | No |
| ORDER_NO_LONGER_ACTIONABLE | M11 REJECTED decision removes a previously relevant order-management action | Current order-management members targeted by the original task | Only if a previously targeted picking task has an authoritative invalidation/closure; do not fabricate one |
| PICKING_OR_FULFILMENT_ATTENTION | Current committed picking/reassignment/shortage or fulfillment attention fact, bounded operational projection | Appropriate MERCHANT_PICKING_VIEW/PERFORM/REASSIGN or order-management capability | Only own assigned session/current picking task with applicable capability |
| DRIVER_ASSIGNED | Current M15 winning commitment for own store/delivery | Operational managers with existing order/driver read permission | Only current assigned picking session where pickup coordination is relevant and existing picking view allows it |
| DELIVERY_COMPLETED | Proven M16 terminal completion for own store | Authorized order-management audience | No routine completion notice |
| DELIVERY_RETURN_ACTION_REQUIRED | M17 RETURN_REQUIRED/return progress requiring store preparation or physical receipt | Authorized store operations/return-receipt members | Only current store physical receipt task with MERCHANT_RETURN_RECEIVE; no sellability decision |
| RETURNED_GOODS_DISPOSITION_REQUIRED | M17 merchant receipt plus M18 pending disposition source | Only existing disposition-authorized OWNER/MANAGER | No |
| SETTLEMENT_READY_OR_ATTENTION | M20 READY preparation for current statement or committed FAILED outcome requiring follow-up | MERCHANT_SETTLEMENT_VIEW, safe merchant projection | No |
| SETTLEMENT_PAID | M20 PAY command + exact payout receipt and PAID state | MERCHANT_SETTLEMENT_VIEW | No |
| SETTLEMENT_DISCREPANCY_ATTENTION | M20 committed OPEN discrepancy with merchant-safe attention projection | MERCHANT_SETTLEMENT_VIEW | No |

ORDER_CANCELLED is not an independent shipped source: do not add cancellation business behavior. ORDER_NO_LONGER_ACTIONABLE is the bounded implementation of the requested cancellation/no-longer-actionable concept only where the existing domain proves it. A technical dispatch/pickup recovery state may produce merchant attention if its existing projection requires merchant action; it does not prove goods failed delivery. Return receipt and returned-stock disposition are separate capabilities.

Prepared/attention variants use distinct source transitions under the stated semantic kind, not changing templates to force another send. DRAFT generation, routine ACCEPTED, APPROVED, RECONCILED and source posting are not additional merchant message kinds. Merchant PAY copy says an external payment was recorded; it does not claim GoSpaza initiated a bank transfer or the merchant acknowledged receipt. No customer balance, cross-store data, private payout evidence or platform goodwill controls enter merchant notices.

## 6. Exact driver audience/channel matrix

All driver rows are IN_APP only; driver EMAIL is deferred. Bind the recipient to the exact DriverProfile/native auth identity, never a request-supplied driver ID.

| Kind | Source / required currentness | Recipient and meaning |
|---|---|---|
| DISPATCH_OFFER_CREATED | M15 committed OFFERED commitment, current delivery generation, driver, expiry and eligibility | Only offered driver. Live action is separately revalidated; never email. |
| ASSIGNMENT_CONFIRMED | M15 winning ASSIGNED commitment + assignment snapshot | Only assigned driver; no second notice for an ACCEPT replay. |
| OFFER_EXPIRED_OR_NO_LONGER_AVAILABLE | Exact previously targeted offer's committed EXPIRED/CANCELLED/DECLINED or authoritative supersession | Only driver previously targeted by that offer. Non-actionable availability update to that offer card; no separate unsolicited stream for every declined/expired offer. |
| DELIVERY_PICKUP_ATTENTION | Committed current M16/M17 pickup/handoff/return task or recovery where the driver-safe projection requires action | Current assigned driver only, bounded directions to the existing workflow; no generic status override. |
| DRIVER_PAYMENT_RECORDED | M21 committed recorded-paid payment/whole earning allocations, including proven CONFIRMED_PAID resolution | Only payment's driver. External transfer recorded, not platform bank execution or receipt acknowledgement. UNKNOWN alone does not qualify as recorded-paid. |
| DRIVER_PAYMENT_RECONCILED | M21 committed reconciliation evidence for that payment | Only payment's driver; distinct from recorded state and deduped by reconciliation identity. |
| DRIVER_PAYMENT_ATTENTION | M21 committed UNKNOWN, confirmed nonpayment or discrepancy requiring driver-safe status explanation | Only affected driver, using existing safe projection; no bank evidence, internal reason fingerprint or other driver's amount. |

Operational suspension/current eligibility may suppress offers/actions. Suspension alone does not remove legitimate own financial-history notices/read access under M21. Revoked authentication is not bypassed by an old notice. No driver earning-created message is added in A; existing earnings remain visible through M21.

## 7. Exact platform audience/channel matrix

Platform EMAIL is deferred. Platform IN_APP is actionable attention only, with explicit named audience membership, active native platform identity and required source-domain permissions. Native admin existence alone is never an audience. Named audiences below are notification policy bindings to be configured/validated in B; they are not assumed existing grants. Binding an audience never grants access to underlying evidence or commands.

| Kind / explicit audience | Authoritative unresolved source | Required boundary |
|---|---|---|
| PAYMENT_RECOVERY_ATTENTION / payment recovery operators | Persisted M10 recovery/technical-compensation attention episode | Explicit payment-recovery audience; only safe summary. Link to a detail/action only if its existing authorization permits it; no new financial override. |
| FINANCIAL_SETTLEMENT_ATTENTION / customer finance operators | M18 refund ambiguity or Store Credit attention episode | Explicit audience plus relevant existing financial operation/view authorization; no automatic grant from general admin. |
| MERCHANT_SETTLEMENT_ATTENTION / settlement operators | M20 prepared approval task, FAILED or OPEN discrepancy | Explicit audience plus corresponding SETTLEMENT_VIEW and applicable PREPARE/APPROVE/PAYOUT_RECORD/RECONCILE action authority as needed. |
| DRIVER_PAYMENT_ATTENTION / driver payment operators | M21 UNKNOWN/nonpayment/discrepancy | Explicit audience plus existing driver-payment record/reconcile authorization for action/evidence; a financial viewer is not automatically an operator. |
| RECOGNITION_ATTENTION / marketplace or driver recognition operators | M19 or M21 persisted recognition exception | Separate explicit audience bindings for marketplace and driver finance, with their existing read/action authorizers. No cross-domain grant inheritance. |
| DELIVERY_OPERATION_ATTENTION / delivery operators | M15–M17 current actionable dispatch/pickup/handoff/return recovery | Explicit delivery-operations audience and existing source permission for any linked view/action; no recipient-compliance evidence in notice. |
| NOTIFICATION_DELIVERY_ATTENTION / notification operators | M22 terminal failure, uncertainty, missing required transport configuration or mismatched provider evidence | Explicit notification-ops audience/capability only. Notification recovery does not grant finance/dispatch authority. |

B must expose these bindings through repository-consistent server configuration and deny empty/unconfigured audiences. Do not fall back to all users, owners or arbitrary emails. Where there is no existing authorized detail surface, an in-app bounded attention summary does not authorize inventing an M23 operational console. An unbound audience is observable configuration attention, not permission to invent a recipient.

One persisted source episode → one notice per eligible actor, not every worker poll. Resolving a task removes actionability without falsifying the historic summary. Notification-system attention is IN_APP only and must not recursively create notification-failure storms; use stable episode identity and engine metrics when no recipient exists.

## 8. Registered customers, guests and contact provenance

Recipient resolution is server-owned:

- Customer: committed Order/customer relation and authoritative persisted checkout/Order contact.
- Merchant: current active tenant membership and native identity; applicable role/capability/store.
- Driver: exact DriverProfile/native identity relation and permitted contact.
- Platform: active native user plus explicit audience and current capability.

Freeze recipient actor identity, source/tenant scope and resolved destination on the intent. No event.email/event.phone, browser destination, arbitrary receiver ID or email equality determines ownership. Historical transactional/financial notices are not silently retargeted after staff, ownership or contact changes. Recheck binding/authorization before publication/send/read; suppress or hold a revoked/changed binding. A new contact does not receive the old private envelope through an implicit retry. No automatic recipient expansion to later-added members during repair.

Current GoSpaza checkout is authenticated; the audit found no reachable anonymous cart flow. M22 does not create guest checkout, force registration, auto-create an account or create an anonymous in-app inbox. For a genuinely proven guest financial/order source, selected transactional EMAIL is allowed without an account, using only committed order contact. No IN_APP without an authenticated owning surface. STORE_CREDIT eligibility remains M18's registered-customer rule; guest email does not create guest credit.

For guest intent identity, use an immutable source-scoped contact principal/reference bound to that Order, not an invented customer account or raw email as actor ownership. The EMAIL channel still has exactly one frozen recipient identity. Future authentication/claim features require separate authorization.

The audit found no explicit email in create-marketplace-cart input or frozen M10 checkout snapshot. Implementation must prove native final Order contact provenance/readback before enabling email mapping. Missing contact is handled below; it does not justify trusting an event address or adding new checkout identity rules. Account authentication is not a claim that email ownership verification exists. This contract authorizes transactional use of the authoritative commerce contact only, not identity/security credentials or sensitive evidence delivery.

## 9. Missing contact and sender configuration

An eligible EMAIL intent without a valid authoritative destination becomes SUPPRESSED with reason NO_RECIPIENT (`SUPPRESSED_NO_RECIPIENT` conceptually). This is neither provider failure nor success and never a business failure. Registered customer IN_APP planning is independent. Preserve the source/dedupe record so repair does not regenerate it indefinitely; a later contact change is not an automatic resend.

Sender configuration comes from validated environment/configuration only: RESEND_API_KEY and RESEND_FROM_EMAIL required for enabled EMAIL; optional RESEND_FROM_NAME and transactional reply-to/support address if configured. RESEND_WEBHOOK_SECRET is required only for enabled webhook verification. No hardcoded production address, client sender, CC/BCC, custom header or endpoint override. Validate bounded names/addresses and reject header newlines. Sender must be approved/verified for Resend before activation.

Missing/invalid transport configuration disables/fails EMAIL safely with bounded CONFIGURATION attention, never marks it accepted and never breaks domain operations or IN_APP. Distinguish this from NO_RECIPIENT. Do not make ordinary business startup depend on optional email being available. Configuration changes must not mutate a frozen retry envelope; mismatch/uncertainty goes to attention. Secrets and addresses are not printed by diagnostic summaries.

## 10. Committed source admission and event readback

Bus events accelerate discovery; domain persistence decides. Validate source IDs → re-read through owning domain contract → prove committed source/recipient → create or reuse deterministic intent. Applies to raw order.placed, payment/dispatch events, verified provider ingress and custom post-commit hints. Never copy raw event payloads into notices.

The audit section 4 is the source inventory. Binding source rules for this matrix:

- M10: final checkout handoff/receipt, not native early order event, browser redirect, provider request or capture alone.
- M11: exact order_decision_event/operation/native Order relation.
- M13: completed picking + proven all-omitted outcome; line edits or unresolved shortages are not full unfulfillability.
- M15: exact dispatch_event/commitment revision/generation and current ownership/eligibility for actionable notices.
- M16: observed native pickup/delivery receipt plus SUCCEEDED operation and committed domain transition.
- M17: custody/merchant receipt and safe outcome; no raw restricted_event evidence.
- M18: exact settled operation/native accounting and immutable settlement/audit linkage; approval/ISSUING/UNKNOWN alone cannot confirm compensation.
- M19–M21: exact immutable posting/exception/statement/command/receipt/reconciliation source, not notification state or requested action.

Source-domain interfaces own calculations and authorization. No generic arbitrary table/event-to-email mapper. If a required projection/source reference is missing, document the specific gap and add only an approved owning-domain extension in its implementation slice. No fake events, amounts, statuses or direct client financial arithmetic.

## 11. Source identity and deterministic idempotency

One logical fact + notification kind + recipient + channel produces at most one NotificationIntent. Conceptual uniqueness:

```text
source_type + immutable source_id + semantic transition/revision
+ notification_kind + recipient_type + stable recipient_id + channel
```

Use canonical completion/commitment/command/audit identities; not subscriber invocation ID, current template text/version, random UUID alone, Redis state, process identity or customer+amount. Different real transitions may create distinct notices; replay of the same transition cannot. Template version is frozen but never a resend trigger. IN_APP and EMAIL are independently unique channel intents with the same logical source; an implementation may share immutable metadata without weakening channel uniqueness.

Subscriber, repair and worker races must converge via PostgreSQL uniqueness/conditional writes. A duplicate key with mismatching frozen provenance/payload is conflict/attention, not permission to overwrite or create another key. Native Medusa idempotency is a transport safeguard, not the sole logical identity. No intentional resend function bypasses this identity in initial M22.

## 12. Intent and attempt separation

Intent freezes source identity/transition, source commit evidence, recipient principal/destination/provenance, tenant, kind/channel, template/version, rendered title/subject/body, safe internal route descriptor, sender/envelope where applicable, creation time, applicable activation, expiry/suppression policy and current delivery state. Store bounded data, not source objects. Source IDs are internal linkage, excluded from user content where not permitted.

Attempt is append-oriented per intent: attempt identity/number, start/end, claim fencing/lease reference, safe result/error classification, native notification reference, provider ID/evidence when known and ambiguity/recovery status. Record each real dispatch attempt; no attempt for suppressed work. IN_APP has no external send but still needs idempotent publication evidence/read state.

Domain fact ≠ intent ≠ attempt ≠ transport result ≠ read state. Keep prior attempts/evidence; do not rewrite a failure into an invented acceptance. No duplicate balance ledger or financial operation reservation is added.

## 13. Frozen render and template policy

Freeze bounded rendered content at intent creation. Retries send the same message, destination, sender, subject/body and provider-relevant envelope; do not re-render from today's Order/finance state or silently change template versions. Template upgrade alone cannot recreate history. A new correcting business fact needs its own source identity.

Use repository-owned versioned allowlisted template identities, for example customer.order_confirmed.v1, customer.delivery_completed.v1 and customer.refund_confirmed.v1. B implements the registry/renderers; A creates none. Render from typed minimal role models, not ORM entities, arbitrary HTML, event blobs or client-selected template names. Escape dynamic values, bound lengths and use established integer-minor-unit money formatting/currency. No floating-point entitlement calculations.

Frozen content trades stable audit/replay for extra retained data and possible staleness. Minimize details, prefer safe authenticated links and perform state/authorization checks. Suppression changes availability/actionability metadata; it does not rewrite historical rendered business claims.

## 14. Actor-owned IN_APP and deep links

Minimum notice semantics: identity, recipient actor, kind, title/body, created_at, nullable read_at, source identity and safe route descriptor. Valid publication means durable application availability, not that a person viewed it. Reading changes read_at only; it cannot accept an offer, acknowledge receipt, approve disposition, settle money or change delivery state.

Actor-specific bounded list/count/read APIs derive identity from auth. Keyset pagination/maximum page size, own-ID authorization, tenant checks and no-store private responses are required. No generic actor_id query or client-side privacy filtering. Merchant/platform membership/grant revocation is checked on every read; drivers retain own financial access according to M21 independently of operational suspension. Account revocation is respected.

Generate deep links from trusted route templates that actually exist in the role app. The user's conceptual /customer/orders or /driver/deliveries examples are not authority to invent routes. No arbitrary event/user URLs, external redirect hosts, private storage keys, embedded session tokens or action-bearing magic links. Target APIs independently enforce source authorization; knowing a notice/Order ID grants nothing. Stale/foreign destinations fail safely. Read status and delivered/provider evidence remain separate.

## 15. Delivery lifecycle

Freeze conceptual states PENDING, IN_PROGRESS, ACCEPTED, RETRYABLE_FAILURE, TERMINAL_FAILURE, ATTENTION_REQUIRED and SUPPRESSED. B may use repository-consistent names with identical semantics. Suppression reasons distinguish NO_RECIPIENT, STALE and AUTHORIZATION_CHANGED; configuration failure is not recipient suppression.

Pending work is conditionally claimed with durable lease/fencing; commit claim before network work and persist result with the matching fence. Lease expiry alone does not prove nonacceptance. Expired in-progress EMAIL enters uncertainty recovery, never automatically a fresh-key send. Accepted evidence is retained; later bounce/complaint is separate transport outcome, not a reversion of domain truth or a trigger to automatically send another email.

EMAIL ACCEPTED means Resend accepted the request; it does not prove inbox placement, human reading or visibility. Provider-delivered evidence may refine transport reporting but cannot imply human read. IN_APP ACCEPTED means valid durable notice publication. read_at is independent. End users see safe domain outcomes; notification operators see bounded transport states, without raw bodies/provider payloads by default.

## 16. Resend boundary, key, provider ID and replay

Use the pinned Medusa 2.18 provider seam documented in the audit: AbstractNotificationProviderService/ModuleProvider with channel email; return provider ID for native external_id. Resend configuration remains inside that adapter boundary. Native ProviderSendNotificationDTO does not declare a provider idempotency-key field; implementation must carry the server-only stable key in a validated allowlisted integration field, prove forwarding and avoid arbitrary provider_data pass-through. Do not confuse native row idempotency with Resend deduplication.

For each EMAIL intent generate one deterministic provider key; every safe retry preserves key, destination, sender, subject, rendered payload and any provider-relevant tags/options. Persist native notification/attempt reference and returned Resend email ID on attempt evidence and linked intent result as appropriate. Provider ID is not business identity.

The approved audit records Resend's documented 24-hour replay retention. Persist first possible dispatch time before network work; recovery deadline is conservative within that window with clock/network margin, never reset by subsequent retries. Inside the safe window, replay only identical key/envelope and reconcile the returned ID/evidence. Known provider ID permits bounded retrieval; do not assume lookup by a lost key, or correlate by recipient+subject+amount/time. Payload-conflict responses require attention; concurrent same-key responses permit bounded retry under the same deadline.

Outside the safe window, unresolved possible acceptance → ATTENTION_REQUIRED, no automatic resend/key rotation/new intent. Same rule if evidence conflicts, envelope cannot be reproduced or safe replay cannot be proven. Native PENDING-key skip behavior must be explicitly handled/proved; resubmission is not evidence. An operator cannot bypass uncertainty with an unrestricted retry button. M22 does not promise globally exactly-once email. IN_APP remains independent and durable.

## 17. Provider webhook evidence

B includes the foundation for authenticated, bounded Resend evidence; no webhook implementation is authorized in A. A callback may update transport evidence/status of a known message/attempt only. It must not create a business notification intent or mutate order/payment/delivery/finance truth.

Verify authenticity against raw body and configured secret; deduplicate provider event identity; bind exact known provider email ID/attempt; store minimal event type/time/result metadata; tolerate replay/reordering without contradictory regressions. Reject forged evidence. Unknown IDs are rejected from state mutation; bounded quarantined metadata may support investigation, never guessed association. Do not log message bodies, destinations, secrets or raw provider payloads. Tags/echo require compatibility proof before they can help bind a lost send ID; a tag is neither authority nor automatic recovery proof.

Delivered means provider evidence about mail-server delivery, not human read. Bounce/complaint handling may suppress further transport where policy requires; it cannot settle a refund or reverse a delivery. Opens/clicks, analytics tracking and marketing are unnecessary in initial M22.

## 18. Bounded retries

Only classified retryable transport failures are retried. Rate limiting/known temporary nonacceptance can use bounded backoff; a network timeout/5xx with possible acceptance uses the ambiguity path, not presumed nonacceptance. No infinite retries, request-path sleeps or retries inside domain transactions.

B must freeze finite maximum attempts, bounded backoff/jitter/Retry-After, batch/claim limits and transport deadlines before implementation handoff. These operational numbers may be defined in B; A's mandatory bounds are expiry, provider-safe replay horizon and eventual terminal/attention disposition. The audit's proposed five attempts is advisory until B freezes its values. Exhaustion does not reset via repair or generate a new key.

Invalid destination/template, policy suppression and known terminal rejection are not transient retries. Configuration defects require bounded operator attention, not tight-loop sends. No swallowed transport error becomes ACCEPTED. Claim fencing, bounded fan-out and retry throughput prevent duplicate workers/outages from amplifying sends.

## 19. Staleness, supersession and dispatch offers

Before delayed send/publication and actionable display, re-read current source authorization and actionability. Suppress stale offers, invalidated picking tasks, recovered payment attention, resolved exceptions, superseded statement tasks and changed recipient bindings. Historical immutable outcome notices remain factual; never relabel a settled refund as failed because email failed.

Driver offers are IN_APP only. Source is committed exact OFFERED commitment/generation/driver with valid expiry and current eligible delivery relation. Another assignment winner, expiry, cancellation or supersession removes the accept action. Historical notice may show no longer available; its dynamic availability metadata does not rewrite frozen text. Existing decision API and expected revision enforce admission/races. Notifications never expose public first-come claim or bypass M15/M21 terms checks. Do not create an expired offer notice if that driver never had a corresponding targeted offer task.

Order action closure does not invent cancellation. Technical recovery is not a customer failed-delivery entitlement. State-at-send cannot recall sent mail; conservative selected email kinds and safe copy avoid stale actionable email. No domain transaction is held open to obtain notification delivery guarantees.

## 20. Financial wording and invariants

Customer REFUND_CONFIRMED means M18 authoritative original-payment settlement, not “refund completed” on a provider intermediate response. STORE_CREDIT_ISSUED is distinct GoSpaza balance value issued; not withdrawable cash or discount. Under-review/approved/unknown states remain distinct in existing role projections; A does not add customer pending/refund-review message kinds. Return custody alone never claims refund/credit, commercial Return or restock.

Merchant SETTLEMENT_PAID derives from M20 exact recorded external-transfer receipt, not request success. Driver payment recorded/reconciled derives from M21 payment/allocation/reconciliation evidence, not customer delivery fee or bank execution by GoSpaza. No bank beneficiary/private evidence or internal recovery IDs in user notices. M19 recognition exceptions are operational, not payouts. Notification delivery/read state has no effect on entitlement, reservations, finance posting, balance, transfer identity, reconciliation or economic idempotency. No notification retry executes those financial commands.

## 21. Repair, activation and cutover

Subscriber and repair invoke the same intent admission/creation primitive. B/C/D must support bounded discovery of eligible committed facts, missing intents, due retries, stuck/ambiguous attempts and known-provider-ID recovery. Domain owners expose discovery/projection contracts; any necessary direct cross-domain read must have a documented narrow reason. No generic database-to-email scraper.

M22 activation is explicit, prospective and server-authoritative, with no hardcoded production date. Unset/inactive → no automatic M22 intent generation. Persist the applicable activation boundary/version on admitted intent. Tests may set explicit fixture activation; never mutate production activation implicitly through a test.

Only source transitions **committed at or after** the applicable boundary qualify. A later subscriber/repair observation of an earlier fact does not make it postactivation. Source created_at, event delivery time, order creation time and worker time are not interchangeable with proven transition commit eligibility. B/C must define/prove the owner-specific activation ordering/evidence, including transactions spanning activation and late repair. If an existing timestamp cannot establish eligibility, fail closed and document the smallest source-evidence gap; do not backfill by guessing. New postactivation transitions on old Orders can qualify by their own source fact, not the Order's age.

Repair never invents facts, recipients or amounts, re-renders old intents, broadens frozen recipients, resets retry count/replay horizon, or sends preactivation history. Use bounded keyset cursors with late-commit/late-repair coverage and idempotent overlap/reconciliation; a cursor over parent creation IDs alone is insufficient. No historical backlog email flood. Unassigned audiences/missing contact remain explicit suppression/configuration outcomes. The absence of an email cannot change the source state.

## 22. Retention and preferences

No automatic notification purge/deletion in M22 MVP. This explicitly supersedes the audit's proposed 30-day content retention. Preserve intent/attempt/audit/retry/ambiguity evidence until an approved later operating policy exists. User reads remain bounded/paginated; minimal content and restricted access remain mandatory despite no purge.

No marketing/channel/frequency/digest preference features or transactional opt-out system. Future preferences or retention cannot retroactively redefine accepted evidence or recreate settled logical notices. No snooze/digest behavior is inferred from a generic notification library.

## 23. Privacy, authorization and static security contract

SOURCE (untrusted bus/user/provider input) → TRANSFORMATION (owning-domain re-read + typed allowlisted render) → TRUST BOUNDARY (actor/tenant/audience + adapter) → SINK (own inbox or exact approved EMAIL recipient).

Never include OTP, restricted ID/DOB/document/observations, precise GPS/address/contact beyond necessary recipient routing, private bank/beneficiary/originating account data, driver/merchant-private payment evidence, source fingerprints, internal request/recovery IDs, private storage keys or secrets in user content. Internal source/provider IDs may exist only in restricted linkage/evidence, not user copy. No M22 template sends handoff OTP; any future OTP communication needs an explicit contract addition. No sensitive notification bodies in logs.

Dynamic merchant/customer names/reasons are untrusted text, not HTML, headers or URLs. Escape/encode in each rendering context, reject header injection, allowlist templates/envelopes/routes and avoid event-controlled external network targets. Fixed Resend integration endpoint/configuration prevents request-driven outbound URL abuse. No arbitrary-send or mass-resend endpoint. Native local provider body logging is not an acceptable sensitive test transport; use a bounded redacted fake for deterministic proofs.

Actor reads/mutations recheck ownership; known foreign IDs, stale memberships and broad native admin roles are insufficient. Platform audiences do not expand original finance/evidence authority. Notification read changes no business state. All sensitive routing/recovery changes require bounded authorization/audit, not a generic status editor.

Static review: no new executable surface in A; no confirmed Critical/High/Medium vulnerability introduced or claimed. Design controls above address spoofing, tenant/driver leakage, BOLA/BFLA, injection, forged provider evidence, duplicate notices and retry amplification. Implementation acceptance must exercise these boundaries; documentation alone is not runtime proof.

## 24. Observability and evidence

Minimum metrics: intents created/suppressed, IN_APP notices available, EMAIL attempts/accepted, retryable/terminal failures, attention count, oldest pending/ambiguous age, repair discoveries, provider webhook/retrieval mismatches. Bound labels by kind/channel/provider/state; never use recipient address/message body as a metric label. Restricted structured logs may correlate intent/attempt/source without exposing user copy, bank evidence or raw source/provider data. Accepted is never labelled human-delivered/read.

Persist exact known provider ID and bounded evidence on its attempt; record uncertainty and operational resolutions. Notification-operator access does not imply original-domain actions. Engine failure must remain observable even if no notice audience is configured, without recursive alert generation.

Largest residual risk: Resend acceptance followed by loss of local persistence creates ambiguity. Identical-key replay within the safe provider window reduces duplicate risk; after it, choose attention over automatic resend. M22 provides strongly idempotent source admission and bounded transport deduplication, not globally exactly-once email delivery. IN_APP remains independently durable.

## 25. Remaining slices and verification boundaries

| Slice | Scope / dependencies | Schema impact | Highest-risk invariant / verification |
|---|---|---|---|
| B — durable foundation | After A approval: intent/read-state/attempt persistence, activation admission, registry/rendering, Resend Medusa provider, key/retry primitives and authenticated provider-evidence foundation | Forward migration for notification-owned records/constraints only; any source-evidence gap separately justified | One fact/recipient/channel → one intent. Pure identity/render/config tests; pinned native provider contract; real DB duplicate/claim/rollback and native success/local failure proof. No domain message mappings or UI yet. |
| C — domain mappings | After B: exact customer/merchant/driver/platform matrix, owning-domain source discovery/readback and recipient adapters | No new business truth; only specifically justified owner evidence/projection additions | Events accelerate, DB decides. Real committed M10–M21 transitions, absent/invalid/guest contact, tenant/driver/audience isolation, replay and preactivation exclusion. No raw-event sends. |
| D — execution, repair and projections | After B/C: bounded retry/ambiguity/state-at-send, source/due repair, read/unread actor APIs, metrics and operational controls | Required bounded work/cursor indexes only | Subscriber/repair/worker converge without duplicate sends; stale leases/late commits/provider horizon/unknown evidence, pagination/BOLA/revocation tests. Retry primitives/evidence foundation from B are completed here, not rebuilt. |
| E — role UX and final acceptance | After B–D: customer/merchant/driver/admin IN_APP surfaces, live-safe links, privacy/security and provider-failure acceptance | None expected | Correct actor sees correct notice only. Targeted code/browser tests with independent mutable fixtures; provider outage, stale offer/deep link, missing email, refresh/read-state and live revocation. User-run final regression. |

No later milestones, broad preference system, mobile alert infrastructure, marketing or M23 general ops console. Preserve M8 same-store initialization, M10 economic Pay/recovery contracts, M15 offer admission, M16/M17 verification/custody and M18–M21 financial idempotency. Notification failures must never require weakening those assertions.

## 26. Review readiness and remaining inputs

No unresolved product-policy question blocks A review. The exact channels, audiences, mandatory policy, missing-contact behavior, no-purge/no-preferences choice and ambiguity disposition are frozen above. Capability/audience binding values, production activation time, verified sender/credentials and support address are deployment inputs, not defaults to invent. B must freeze finite retry/lease/transport limits and prove exact Medusa/Resend forwarding; C must prove contact provenance and source activation evidence. An impossible source variant is deferred explicitly as specified in the matrices, not implemented by fabricating truth.

M22-A is ready for review; M22-B has not begun. Only this milestone contract was created. No production code/configuration, dependencies, migrations, templates, API/UI or tests changed. No verification commands were run and no commit was made. Commands for user to run: none for this documentation-only slice; review this contract before authorizing B. User-verified M21 results remain prior evidence, not new M22 runtime verification.

## 27. M22-B implementation — pending user verification

A is approved. B implements the foundation only; the preceding A closure paragraph is historical. No M8–M21 event mappings/subscribers, retry/repair jobs, full actor inbox HTTP surfaces, UI or browser tests are implemented. No verification commands were executed by Codex and no commit was created.

### Ownership, native boundary and dependencies

`notification-foundation.ts` owns trusted internal primitives over notification-owned PostgreSQL records. The existing Marketplace migration stream hosts their forward SQL, following M20/M21 raw-SQL evidence conventions; they are not registered as MedusaService CRUD models. This avoids generating public-like create/update/delete methods for frozen records. The logical notification owner remains separate from finance/dispatch.

The pinned Medusa 2.18 Notification module/provider loader and DTOs were inspected. `modules/resend.ts` exports a single-file ModuleProvider/AbstractNotificationProviderService adapter, which the pinned loader supports. `NativeNotificationTransport` invokes native createNotifications; only that provider's integration transport uses Resend HTTP. No domain subscriber calls Resend. The native PENDING-key skip concern is addressed by a separate native attempt key per durable M22 attempt, while the external provider key remains stable per EMAIL intent. Duplicate workers are excluded by PostgreSQL claims, not native row lookup alone.

No dependencies or lockfile entries were added. Resend is not installed transitively. The supported [send](https://resend.com/docs/api-reference/emails/send-email) and [known-ID retrieval](https://resend.com/docs/api-reference/emails/retrieve-email) APIs need two bounded HTTPS calls; Node's built-in fetch avoids an SDK dependency and implicit SDK retry behavior. It follows a fixed API origin, rejects redirects, bounds response data to 64 KiB, times out and never logs provider response bodies. The official SDK preference was considered; this narrow integration requires no additional package. SendGrid remains unused/transitive.

### Persistence and activation

Forward migration: `Migration20261111120000`, using `notification-schema.ts`. Each top-level SQL statement/function/trigger is an individual addSql entry, with named dollar quoting and complete PL/pgSQL terminators. No already-applied migration is edited. Down migration refuses destructive removal of notification evidence.

Tables:

- `notification_activation`: immutable first activation, revision 1, actor/reason/request/fingerprint, recorded_at and activated_at. No default production date. Activation authority is an injected trusted authorizer, default deny, checked again inside the serialization boundary. No activation HTTP route or implicit activation exists in B.
- `notification_intent`: immutable source/transition/commit-evidence reference, actor/channel/destination, registry version, rendered output/route and frozen EMAIL envelope/hash/key. Composite logical uniqueness and hash uniqueness; source/template/actor/channel bounds enforced.
- `notification_delivery`: separately mutable current disposition/claim/due/count/time state, with revisioned immutable `notification_delivery_event` evidence. Frozen intent content never changes with delivery progress.
- `notification_notice`: one IN_APP publication/read-state row per intent. Title/body/route/recipient remain in the immutable intent and are joined on read; there is no redundant mutable content copy. Publication and accepted disposition commit atomically with the intent. Only read_at changes, once, through the actor-bound primitive.
- `notification_attempt`: immutable numbered claim/provider/key/envelope-hash record. `notification_attempt_started` marks possible network dispatch; `notification_attempt_result` appends one immutable completion/classification/provider/native reference. This gives append-only history without rewriting a single attempt status across failures/recovery.
- `notification_provider_message`: immutable unique known Resend ID and one intent binding. `notification_provider_evidence`: immutable deduplicated bounded event metadata and exact attempt/message binding.

Guards protect immutability, valid channel/state/suppression, activation admission, monotonic bounded attempts, active claim ownership, provider/envelope binding, and read-only notice mutation. Deferred consistency checks prove intent/delivery/audit/notice/attempt counts and accepted evidence at transaction commit. Direct frozen-row mutation/deletion is rejected. No automatic purge is added.

Activation is absent by default. Shared admission rejects a source before activated_at or in the future; exact existing intent replay returns its original frozen record. Creation never substitutes worker arrival time for source committed_at. As required by the A/C boundary, real owner-derived commit evidence and activation-spanning transaction ordering must be proven by C's domain adapters; B's source input is trusted internal evidence and its verifier uses synthetic committed dates. B does not claim that a browser-supplied timestamp proves a domain commit. Activation is one prospective initial publication, not an unrequested deactivate/reactivate product.

### Registry, recipients and bounds

The only registry entry is test.notification versions 1/2, allowed solely with APP_ENV=test. It declares channels, typed strict input and renderers. No production customer/merchant/driver template or generic HTML/file loader is included. C must add its approved registry entries and mappings explicitly. Existing-intent lookup/fingerprint comparison happens before rendering, so a registry version upgrade cannot rerender/resend old facts.

Logical identity is SHA-256 of immutable source type/ID/semantic transition, kind, recipient actor type/ID and channel. PostgreSQL also enforces those columns as a composite unique key. The request fingerprint includes recipient destination, evidence and semantic render input but excludes template version. An exact duplicate converges; changed payload/contact/evidence under the same identity conflicts. Separate channels remain independent.

Frozen EMAIL envelope includes from/to/subject/text/HTML/reply-to; envelope hash is checked before provider invocation. External key is `gospaza-m22-<logical digest>`, never attempt number/time/UUID. A server-only allowlisted provider_data envelope carries key/hash/deadline across the pinned native DTO seam; none is passed through as arbitrary provider headers/CC/BCC. The deadline is attempt admission metadata, not part of the Resend message body, so actual provider payload remains identical on replay.

Intent/attempt also freeze a one-way credential fingerprint, never the API key. The adapter checks the active credential against that fingerprint before transport. A change enters CONFIGURATION_CHANGED attention without sending; even a legitimate same-account key rotation requires review rather than assuming provider deduplication survives. This prevents silently replaying an old intent into another provider account. The fingerprint is restricted integration metadata, not user content or a log field.

Bounds: title 160, subject 200, body 8,000, HTML 24,000, deep link 240, destination 254, template key 80, identifier/provider ID 128 and safe error summary 120 characters. Input detail is bounded at 2,000. Oversize content fails; no semantic truncation. HTML values are escaped. Subject/sender/destination validation prevents header newlines. Only a test-gated route descriptor generates `/orders/<encoded ID>`; no arbitrary path/URL is accepted. Target authorization remains independent.

Missing/invalid EMAIL contact produces SUPPRESSED/NO_RECIPIENT without an attempt. Valid contact with unavailable transport produces ATTENTION_REQUIRED/CONFIGURATION and no send. IN_APP is independent. Supported suppression reasons are NO_RECIPIENT, STALE, POLICY and AUTHORIZATION_CHANGED; B does not decide real-domain staleness. Recipient/contact/tenant authority belongs to C, and current role authorization belongs to the later actor adapters. These internal primitives are not public HTTP mutations.

### Configuration and sender behavior

`.env.example` documents NOTIFICATION_EMAIL_ENABLED=false, RESEND_API_KEY, RESEND_FROM_EMAIL, optional RESEND_FROM_NAME/RESEND_REPLY_TO and reserved RESEND_WEBHOOK_SECRET. `notificationModuleConfiguration` only registers native Notification + Resend when explicitly enabled with valid configuration. Missing/invalid optional transport does not prevent commerce boot or IN_APP use; no secret/sender fallback is invented. An enabled deployment must supply a verified sender and run native module migrations with the matching enabled configuration before real transport use. Ordinary B verification disables real email and requires no Resend credentials.

The already frozen sender/destination is not silently rewritten when environment/contact changes. No client-bundle configuration is added. The adapter blocks its default live fetch in APP_ENV=test; tests inject a controlled request substitute explicitly. This is not a production fake-send mode and does not mark unavailable email accepted.

### States, claims, retry and crash points

Initial IN_APP → ACCEPTED with publication; EMAIL → PENDING, SUPPRESSED/NO_RECIPIENT or ATTENTION_REQUIRED/CONFIGURATION. Pending/due retry → IN_PROGRESS with one row-locked claim and monotonically numbered attempt. Short claim transaction commits, then a short begin transaction marks possible dispatch, then external work runs without a GoSpaza PostgreSQL transaction held, then a short fenced result transaction appends evidence and updates disposition.

Results: accepted → ACCEPTED; confirmed permanent rejection → TERMINAL_FAILURE; credential/payload conflict → ATTENTION_REQUIRED; RETRYABLE/AMBIGUOUS → RETRYABLE_FAILURE with finite due time, otherwise ATTENTION_REQUIRED. Pending/due work may be explicitly suppressed; accepted/history records are never rewritten. Failed claims/results cannot erase the intent. Claimed work has a 90-second lease; transport is bounded at 15 seconds and rejects an expired deadline. Native asynchronous persistence also runs outside the GoSpaza claim transaction. No worker, sleeps or hidden retries are added.

Numeric policy: four total automatic attempt admissions, with 1-, 5- and 30-minute delays after attempts 1–3; fourth failure goes to attention. Abandoned claims consume attempt budget conservatively. Replay horizon is 23 hours from the first possible dispatch marker, providing a one-hour margin inside documented 24-hour provider retention. Later attempts never reset it. Fixed bounded backoff is selected rather than jitter in B for deterministic primitives; D may add only bounded jitter without extending budgets/horizon. No provider Retry-After can extend the safety window.

Classification: 429 and documented same-key concurrent-request conflict are retryable; validation/auth/permanent rejection is terminal; unknown network/5xx/malformed acceptance is ambiguous. Raw response/error text is never persisted/logged. Controlled bounded markers preserve classification through native error wrapping, including bounded AggregateError nesting; unrelated exceptions remain ambiguous, not guessed success/nonacceptance.

Crash points:

1. Claim committed, no dispatch marker: lease recovery appends CLAIM_NOT_DISPATCHED/retryable result, then permits bounded next admission. No provider call is known to have begun.
2. Dispatch marker committed, response uncertain: immutable AMBIGUOUS result or expired-lease LOST_SEND_RESULT; same external key and frozen envelope only.
3. Provider accepted, local result transaction failed: original claim remains in progress and durable dispatch marker remains. Expired-lease recovery/replay within the safety window converges on the provider ID. Local acceptance is never fabricated from the mere claim.
4. Outside the safety window, exhausted budget or unprovable evidence: ATTENTION_REQUIRED, no automatic resend. Late stale owners cannot overwrite a recovered/current claim. Leases/fences control local ownership; provider idempotency handles unavoidable transport uncertainty. No globally exactly-once email claim is made.

### Provider evidence and webhook decision

Known-ID retrieval is implemented inside the Resend integration; no searching by recipient/subject/amount and no polling worker. Successful native transport results persist exact provider ID/native reference on the immutable result and unique logical binding. Acceptance is not delivered/read. Unexpected response IDs/shapes fail safely rather than being interpreted as success.

Actual Resend HTTP webhook ingress is deferred to D: B exposes no route that could accept unverified evidence. `recordKnownEvidence` is internal-only for a future authenticated raw-body verifier or known-ID retrieval adapter. It requires an already accepted matching attempt/provider binding, unique event identity/fingerprint, bounded event type/time and immutable metadata. Unknown IDs and changed replay are rejected; it cannot create an intent or mutate business state. Transport observations do not replace acceptance/read state. Signature configuration/authentication and out-of-order processing remain D work before enabling ingress.

### Security review and verification added

SOURCE → strict test registry/source contract → trusted actor/intent + frozen envelope boundary → own notice or Medusa adapter. No public arbitrary-send/CRUD routes, raw HTML/header/path input, secret logging or raw provider evidence storage. Foreign actor read/mark is denied; recipient/body/source/attempt history SQL mutation is guarded. Claims, stable keys, budgets and response-size/deadline limits address duplicate sending and amplification. No confirmed Critical/High/Medium finding remains from static review; this is not runtime security certification. C/D must prove real source/recipient/grant provenance before exposing actor APIs.

The installed native `/admin/notifications` GET uses generic notification refetch, not M22 audience/actor authorization. Enabling transport would expose a bypass for ordinary native platform users. `notification-http-boundary.ts` and middleware now block that entire native route family/all methods with private no-store 404, including potential retry/detail subpaths. Unit coverage proves the boundary predicate/response. This is a narrowly required integration-security fix, not a new inbox API; D must test live actor-safe HTTP surfaces separately.

`notification-policy.test.ts` covers semantic identity, registry upgrade, escaping/bounds, links, optional configuration, state/retry/horizon classification, frozen-envelope mismatch, fixed transport endpoint, known-ID readback and blocked live test network.

`verify-notification-foundation.ts` requires APP_ENV/NODE_ENV=test, an existing _test database and Redis /1, and checks the applied table. It builds only a generated private schema using the exact migration SQL, independent pool connections and real deferred guards. A private fixture clock supports deadline proofs with no sleeps; the public clock/constraints are not modified. It proves parallel duplicate IN_APP/EMAIL, independent channels/transitions, old-version replay, changed-input denial, missing contact, actor read ownership, claim/send competition, monotonic attempts, retry/terminal/exhaustion, stale suppression, accepted ID/evidence dedupe, persistence rollback and accepted-provider/local-failure same-key recovery. It executes COMMIT, including deferred checks. Private-schema cleanup follows existing M21 verifier practice; it never creates/drops a database or deletes public finance/domain records.

The controlled test substitutes the native module call wrapper and Resend HTTP request while invoking the real NativeNotificationTransport and ResendNotificationProvider. It asserts frozen wire bodies/keys and stores real M22 PostgreSQL acceptance evidence. It does not claim a live Resend send, native Notification database roundtrip or webhook signature proof; those are distinct provider-enabled integration/ingress boundaries. No ordinary verifier can send real email.

### Files materially changed

- `apps/backend/src/lib/notification-policy.ts`, `notification-config.ts`, `notification-foundation.ts`, `notification-transport.ts`.
- `apps/backend/src/lib/notification-http-boundary.ts`, `apps/backend/src/api/middlewares.ts` (native bypass prevention only).
- `apps/backend/src/modules/resend.ts`.
- `apps/backend/src/modules/marketplace/notification-schema.ts`, `migrations/Migration20261111120000.ts`.
- `apps/backend/src/scripts/verify-notification-foundation.ts`, `apps/backend/tests/notification-policy.test.ts`.
- `apps/backend/scripts/notification-foundation-environment.ts`, `apps/backend/package.json`, `apps/backend/medusa-config.ts`, `apps/backend/.env.example`.
- This milestone document. No M8–M21 production logic or audit source was changed.

### Commands for user to run

Repository root, PowerShell, one command at a time; **stop on every failure**. No commands were run by Codex.

1. `pnpm run lint`
   - Purpose: repository lint. Expected: zero warnings/errors.
2. `pnpm --filter @gospaza/backend run typecheck`
   - Purpose: backend/verifier compile. Expected: no TypeScript errors.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/notification-policy.test.ts`
   - Purpose: focused B policy/transport unit tests. Expected: all pass; no external email/network.
4. `pnpm --filter @gospaza/backend run build`
   - Purpose: existing Medusa build methodology. Expected: successful backend build.
5. `pnpm --filter @gospaza/backend run test:notification-environment -- migrate gospaza_m18_c2b_test`
   - Purpose: forward migration in the established existing isolated database. Expected: sanitized summary names gospaza_m18_c2b_test, Redis 1, test/test, recovery workers disabled; migration completes. Creates no database.
6. `pnpm --filter @gospaza/backend run test:notification-environment -- verify gospaza_m18_c2b_test`
   - Purpose: isolated real-PostgreSQL foundation proof. Expected: M22-B notification foundation passed, followed by finished execution; no real email.

The tiny environment launcher reuses `isolatedEnvironment` and `verifierPath`, not a competing isolation policy. Its explicit database argument prevents silent gospaza_test fallback; an inherited shell DATABASE_URL must already match that selected database or it rejects. It preserves .env secrets/configuration, disables external email/operational workers for these commands, and prints only the existing sanitized summary. No .env/global environment changes or server startup. The registered `test:notification-foundation` also works through the unchanged test:isolated helper when the shell already explicitly selects the existing _test database. No Playwright/server is required for B.

### B handoff / remaining boundaries

B was subsequently user-verified. Its provider activation requirements remain unchanged. C implements only approved source/recipient/template mappings below. D owns workers, repair, public actor reads/current-grant checks and authenticated webhook ingress. E owns UX/browser/final privacy acceptance. Existing M25 performance/deprecation/harness debt is unchanged.

## 28. M22-C implementation — user-verified

### Source mappings and templates

The complete [C mapping table](M22_C_MAPPING_TABLE.md) records every implemented template/kind, authoritative identity/transition, discovery, audience/channel, existing route and currentness rule. It was established before the subscriber. `notification-catalogue.ts` is the explicit version-1 production registry; rejection and full-unfulfillable copy are distinct variants of one approved kind. The five customer EMAIL categories remain exactly those frozen in A. Merchant, driver and platform are IN_APP only. No guest checkout exists; C introduces neither guests nor anonymous inboxes.

`NotificationSources` is an internal Marketplace-owned point-read contract, not a generic table-to-email mapper. All operational/finance SQL stays inside that owner; native Order/Customer identity comes through the existing native Order handoff reader plus native module services. M10 terminal completion/native receipt and exact customer/store/reservation lineage are mandatory. Native `order.placed` alone is insufficient. M11 rejection needs its matching decision. M13 all-omitted uses the existing picking owner's completed physical accounting. M15 offers bind commitment identity, generation, driver and exact audit; live expiry/eligibility is checked before intent creation. Assignment, pickup and delivery require their committed audit/receipt chains. M17 return custody never becomes delivered or a financial promise. M18 settled operation/entitlement/native references rely on the owning deferred database consistency guards, not notification guesses or a new native issuance/refund call. M20 PAY needs exact receipt and paid/reconciled state. M21 recorded-paid needs exact whole earning allocations; reconciliation is a separate command/receipt fact. UNKNOWN produces safe attention, never a paid claim.

Native Order email is preferred; registered native Customer email is the persisted fallback when Order email is absent. Invalid/missing contact becomes B's EMAIL NO_RECIPIENT suppression independently of IN_APP. Replays reuse the frozen destination and envelope. Templates accept only a bounded safe reference, with integer-minor amount/currency on financial templates. No arbitrary detail, names, HTML, private reason or event fields enter production models. HTML escapes all dynamic values, subjects are static, and no tracking/remote content is added. Internal source IDs, native receipts and fingerprints are not rendered. Existing ZAR formatting was extracted unchanged from `packages/ui/src/settlements.tsx` to `packages/contracts/src/money.ts`; the UI export remains compatible. This avoids a second finance formatter or a backend dependency on React.

### Recipient/currentness boundary

`NativeNotificationActors` verifies native identities and authoritative source relations. Merchant tenant resolution reuses `Marketplace.resolveTenant`; existing capability functions remain the only role authority. OWNER/MANAGER receive management, finance and disposition notices with their respective existing capabilities. PICKER receives only assigned picking/pickup coordination and store physical-return receipt tasks; never finance or sellability decisions. Closure targets only previously notified order managers. Driver assignment/payment recipients come from exact persisted commitment/payment lineage; suspension does not remove own financial history, while dispatch requires current eligibility. Platform recipients require a native user, an explicit named NOTIFICATION_AUDIENCE_*_USER_IDS list and the appropriate independent domain grant. Delivery operations has only a bounded summary with no invented admin detail/action route. Empty/unconfigured audiences never broadcast.

An immutable notification-owned `notification_mapping_audience` record freezes actor identities and trusted route descriptors at first source admission. It prevents late-added members or role changes from retargeting old facts. It contains no contact/body/source payload and does not replace B intent uniqueness. Current authorized candidates are intersected with the frozen audience. Empty audiences remain empty on repair; configuration changes are not implicit historical backfill. Independent recipient/channel transactions use B create/reuse and aggregate failures after other recipients have progressed. Optional state-at-intent callbacks recheck actionable source rows and merchant/store/role bindings on the same transaction; no native module request needs another database connection while that notification transaction is held. D still owns state-at-send/read authorization and stale-card behavior.

`Migration20261112120000` adds the audience table/append-only guard and replaces only B's route constraint with the explicit existing customer/merchant/driver/admin allowlist. It does not edit an applied B migration, add commerce fields or weaken intent/transport evidence guards. Each top-level SQL statement is its own addSql call. Destructive down is refused for historical evidence.

### Events, activation and gaps

One thin subscriber observes only `order.placed`, `gospaza.picking.completed` and `gospaza.delivery-completed`. It extracts only id/order_id. All supplied status, amount, tenant, driver and destination fields are ignored. The native early event safely finds no terminal handoff; custom picking/completion hints are emitted after their source commit. Producer behavior remains untouched, including existing best-effort/worker-gated delivery of hints. Mapping failure cannot undo an already committed source. No bus producers exist for several finance/dispatch/decision transitions: C exposes validated ID-based discovery for D's future repair/execution orchestration; C adds no scan, poller, sender or fake event.

All mappings call B's one shared activation/source-eligibility primitive, both before audience capture and inside intent creation. Source times are persisted owner transition/receipt timestamps observed after commit, never subscriber arrival. Such timestamps prove a lower bound on commit time, not the exact commit instant: a transition stamped before activation but committed later cannot be proven eligible and is conservatively excluded. No source transaction/schema was changed to fabricate stronger commit evidence. That crossing-boundary limitation remains explicit for deployment activation planning.

No separate offer-expiration card is created; D/E must revalidate the original generation's actionability. Generic cancellation/ordinary failed delivery lack an approved shipped source. M10 payment-recovery attention lacks a stable owning episode identity; it is deferred rather than inferred from mutable pending flags. Notification-delivery attention belongs with D execution. Recognition exceptions are immutable and currently have no owning resolution command; existing postings/earnings alone do not prove resolution. These gaps do not authorize new business actions or channels.

### Static security review

SOURCE (committed owning receipt/audit + native actor relation) → TRANSFORMATION (minimal fingerprint and strict template/route model) → TRUST BOUNDARY (current source/tenant/capability checks + frozen actor/channel identity) → SINK (B immutable intent/envelope, no provider call). Reviewed event destination/tenant spoofing, foreign membership/driver, revoked membership, late-added staff, contact retargeting, expired/superseded offers, false financial success, HTML/header injection and private evidence leakage. Mitigations are explicit adapters, currentness checks, frozen audience/destination and strict template allowlists. No confirmed unresolved Critical/High/Medium issue was identified in this static pass; runtime verification remains required. No new public API or permission grant was introduced.

### Verification added and limits

`notification-mappings.test.ts` covers the exact channel matrix, template/version/actor binding, strict models, HTML/CRLF injection, exact ZAR formatting, safe returns copy, role/tenant rules, explicit platform audiences, spoofed payload fields and real route descriptors.

`verify-notification-mappings.ts` uses a generated private schema in the existing selected _test database, exact B/C SQL, independent PostgreSQL pool contexts, private fixture clock and production mapping/readback code. It proves activation, authoritative M10 parsing, duplicate/concurrent discovery, actor-owned channels, frozen contact/audience, missing contact, speculative completion exclusion, assigned picker-only attention, expired/lost and new-generation offers, committed assignment/pickup/completion, return custody versus disposition authority, settled credit versus refund message selection, settlement finance exclusion for PICKER, explicit platform targeting and suspended-driver own payment notice. No transport attempt is created.

These are real-PostgreSQL **source-contract fixtures** with controlled native identity/Order reads. They are not a claim that the verifier recreates every M8–M21 commerce mutation or re-proves native finance receipts. Existing owning database guards remain the authority for those already verified domains. No live Resend calls, public data cleanup, database creation/drop or server is required. Only the private schema is removed. The established explicit-database launcher gains `verify-mappings`; migrate/verify and shared isolation safety remain unchanged.

### Commands for user to run

Repository root, PowerShell, one command at a time; **stop on any failure**. Codex ran no verification commands.

1. `pnpm run lint` — expected zero errors/warnings.
2. `pnpm run typecheck` — includes changed contracts/UI/backend; expected no TypeScript errors.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/notification-policy.test.ts tests/notification-mappings.test.ts` — expected focused B/C tests pass, no network.
4. `pnpm --filter @gospaza/backend run build` — expected Medusa build succeeds.
5. `pnpm --filter @gospaza/backend run test:notification-environment -- migrate gospaza_m18_c2b_test` — expected explicit existing database, Redis 1, test/test and migration complete. A conflicting shell DATABASE_URL is rejected.
6. `pnpm --filter @gospaza/backend run test:notification-environment -- verify gospaza_m18_c2b_test` — expected M22-B foundation proof remains green after its shared admission extension.
7. `pnpm --filter @gospaza/backend run test:notification-environment -- verify-mappings gospaza_m18_c2b_test` — expected M22-C notification mappings passed and finished execution, no email.

No broad M8–M21 regression was needed for an added subscriber with unchanged producers; the shared formatter extraction was covered by focused exact-cent tests plus workspace typecheck. C was subsequently user-verified. M25 debt is unchanged. At C handoff no D worker/API or E UI/browser work was implemented; the separately authorized D implementation is recorded in section 29.

### Files materially changed by C

- Backend lib: `notification-catalogue.ts`, `notification-recipients.ts`, `notification-mappings.ts`, `notification-policy.ts`, `notification-foundation.ts`.
- Marketplace: `notification-sources.ts`, `notification-mapping-schema.ts`, `migrations/Migration20261112120000.ts`.
- `src/subscribers/notification-discovery.ts`, `src/scripts/verify-notification-mappings.ts`, `tests/notification-mappings.test.ts`.
- `scripts/notification-foundation-environment.ts`, `package.json`, `.env.example`.
- `packages/contracts/src/money.ts`, `packages/contracts/src/index.ts`, `packages/ui/src/settlements.tsx`.
- This contract and `milestones/M22_C_MAPPING_TABLE.md`.

## 29. M22-D implementation — pending user verification

### Execution, ownership and configuration

The native Medusa 2.18 Notification/provider send path and B's `NotificationFoundation` remain authoritative for transport attempts. D adds orchestration rather than a second sender/attempt model. `notification-delivery` and `notification-repair` are native Medusa scheduled jobs (one-minute cadence). Both default **off** and require their respective `NOTIFICATION_DELIVERY_WORKER_ENABLED=true` / `NOTIFICATION_REPAIR_WORKER_ENABLED=true`. APP_ENV=test always disables background execution, even if a flag is inherited as true. The explicit isolated launcher also forces both flags and webhook enablement false. There is no custom timer, listener, Redis subscription or process-local lock to shut down; Medusa owns job scheduling/lifecycle. Tests invoke bounded cycles directly with controlled transport. Ordinary test execution cannot reach a live send through the executor without an explicitly substituted transport; B also rejects live test fetches.

Execution selects at most 20 due EMAIL intents in stable creation/id order. Currentness/configuration checks happen before claim and outside an open PostgreSQL transaction. B then claims with its row lock, persists the dispatch marker, releases the transaction, sends through Medusa, and persists a fenced result. Two contenders converge at B's claim; no transaction spans provider network work. Frozen envelopes are never rerendered. Invalid envelope/configuration or changed credentials enter attention before spending an attempt, rather than generating a retry storm. PENDING/RETRYABLE suppression uses B's conditional state primitive and cannot suppress another worker's IN_PROGRESS claim.

B's schedule is unchanged: four total claims/attempts, immediate then +1/+5/+30 minutes, authoritative DB time, and 23-hour replay horizon from the original dispatch marker. Claim records and actual provider dispatches remain distinct; an undispatched claim consumes a finite claim slot but is never counted as a provider execution. Expired undispatched claims close as CLAIM_NOT_DISPATCHED/RETRYABLE; dispatched claims without a result close as LOST_SEND_RESULT/AMBIGUOUS. Replays use the original logical key and immutable envelope. Attempt exhaustion or elapsed horizon enters ATTENTION_REQUIRED; no fifth attempt, new key, force-send or manual mark-accepted action exists.

All current C customer EMAIL kinds are retrospective. Send validation reuses exact owning source readback/fingerprints and current registered customer/contact binding; it does not suppress issued credit because it was later redeemed. The confirmation-only source read avoids making ORDER_CONFIRMED delivery depend on unrelated later picking work; C's normal discovery behavior is unchanged. Missing/superseded facts suppress STALE, changed recipient binding suppresses AUTHORIZATION_CHANGED, and infrastructure failure is not falsely classified as either. IN_APP remains atomically published by B; no second publication worker exists.

### Provider reconciliation and authenticated ingress

Known provider IDs rotate through bounded retrieval (20 per repair cycle), using B's fixed-host, deadline/response-size bounded Resend adapter. Retrieval never searches by recipient/amount, creates an intent or changes a domain fact. Exact-ID/status mismatch creates a bounded RETRIEVAL_MISMATCH observation. A retrieval snapshot has no historical provider event timestamp: `notification_provider_observation` freezes its first-observed time once, and concurrent retrievals reuse that timestamp/evidence identity. Unknown acceptance after a local crash is recovered with keyed replay inside the horizon; retrieval does not pretend an unavailable provider ID can be guessed.

`POST /hooks/gospaza/resend` is independently opt-in with `NOTIFICATION_WEBHOOK_ENABLED=true` and RESEND_WEBHOOK_SECRET. It uses preserved raw bytes (64 KiB cap), svix-id/timestamp/signature, whsec_ base64 key, HMAC-SHA256 over id.timestamp.raw-body, constant-time canonical v1 comparison and a five-minute freshness bound. This follows the documented [Resend verification contract](https://resend.com/docs/webhooks/verify-webhooks-requests) and [Svix manual algorithm/test vector](https://docs.svix.com/receiving/verifying-payloads/how-manual); no unsupported secret format or new dependency is invented. The official fixed vector plus locally signed Resend payloads are included in tests. [Known-ID retrieval](https://resend.com/docs/api-reference/emails/retrieve-email) retains only its bounded status projection.

Only authenticated supported events bound to an already-known accepted provider ID/attempt persist. Unknown IDs or changed data under an existing event identity return a generic 409; unknown acceptance may become bindable after safe replay, but no intent is manufactured from ingress. Invalid signatures return 400; disabled/missing configuration returns 503; storage failures are not acknowledged. Webhook receipt fingerprint and B evidence persist in the same transaction. Raw payload, destination, signature and secret are never stored/logged. Verified but unsupported email events are ignored. Evidence remains append-only: complained > bounced > failed > delivered > sent > delayed > accepted is the conservative disposition precedence. Late delayed evidence cannot undo delivered evidence; permanent evidence never authorizes automatic resend or contact mutation. Provider accepted/delivered never means human read.

### Bounded source repair and recovery

`notification-repair-sources.ts` is the Marketplace-owned audit-discovery contract. It returns only source identity and time from approved families:

| Family | Indexed discovery evidence | Reused C method |
|---|---|---|
| ORDER | Terminal checkout receipt, M11 decision, M13 picking audit/shortage creation | ORDER |
| DELIVERY | Delivery dispatch/pickup/completion audits and restricted custody audits | DELIVERY |
| REFUND / CREDIT | Current/historic operation audit transitions | REFUND / CREDIT |
| SETTLEMENT | Preparation audit and settlement commands | SETTLEMENT |
| DRIVER_PAYMENT | Payment commands | DRIVER_PAYMENT |
| MARKETPLACE_EXCEPTION / DRIVER_EXCEPTION | Owning immutable exception records | Corresponding exception method |

A durable fenced checkpoint holds source family, one-hour window, (timestamp, unique audit key) cursor and a ten-minute lease. One cycle processes at most one 20-row page, then releases/advances the checkpoint. Source readback/mapping occurs outside the lease transaction. Concurrent processes skip active leases; stale owners cannot advance another owner's cursor. A failed mapping records safe failure and does not advance past the obligation. Every candidate goes through the same C discovery/admission/intent primitive, not a repair-only creation path. Initial discovery begins at activation, not all M8–M21 history. Each complete postactivation sweep pauses for an hour before another bounded sweep; revisiting bounded windows catches late visibility behind an earlier cursor. This intentionally trades repair latency for completeness rather than imposing an arbitrary lookback that loses old postactivation obligations. Large postactivation backlogs take multiple cycles; no single unbounded scan or offset is used. Only specific indexed audit/receipt ranges are read, never whole native commerce history.

Source timestamps before activation remain excluded by B, including the already-documented ambiguous crossing-boundary case. Sweep recovery does not authorize historical backfill or recipient expansion. C's frozen audience/destination and PostgreSQL uniqueness converge subscriber + repair + duplicate repair races. Stuck delivery recovery uses B's existing fenced closure. An ACCEPTED state missing its required projection/evidence is already rejected by B's deferred database guard; D does not fabricate acceptance to repair corruption.

### Actor APIs, DTOs and current authorization

Each actor has GET list, GET detail and POST :id/read under its existing route family:

- `/store/gospaza/notifications`
- `/merchant/notifications`
- `/driver/notifications`
- `/admin/gospaza/notifications`

The existing authentication/origin boundaries apply. Fresh native identity/provider binding is read every request; customer/user native app metadata must still bind that actor. Merchant tenant/member identity comes through existing Marketplace resolution. Driver ownership comes through existing profileForIdentity, preserving suspended-driver historical access while denying revoked identity/session access. Merchant revoked membership loses authority on the next request; role changes cannot retain finance/disposition access. Platform notices recheck their explicit audience/domain grants; knowing an ID never grants read/mark access.

All inbox queries bind frozen recipient actor type + ID and IN_APP. Foreign detail/mark returns private no-store 404, not content. Mark-read uses B's conditional once-only timestamp and is idempotent. No unread mutation/counter is added. Keyset cursors use (created_at, id), strict bounded input and default 20/max 50 rows. Filtering a newly unauthorized category may produce a short/empty page with a continuation cursor; there is no unbounded fill loop. Trusted frozen deep links are returned unchanged; their destination still enforces its own authorization.

`ActorNotice` exposes only id/kind/title/body/deep_link/created_at/read_at. It excludes destinations, source/provider/attempt/repair/activation evidence. Contracts and typed clients expose list/detail/mark-read, with no generic create/send/edit. No visual components are added.

### Notification operations and observability

`GET /admin/gospaza/notification-operations` and `/health` require the independent `NOTIFICATION_OPERATIONS_VIEW_USER_IDS` grant plus current native platform identity. Native platform existence and M18/M20/M21 finance grants are insufficient. The ordinary platform inbox does not become a shared all-actor inbox. Operations returns only safe notification status/kind/channel/time/attempt count/last category and derived provider disposition—no rendered message, recipient contact, secret, raw evidence or source fingerprint. There is no MANAGE grant because no manual override action is implemented.

Health exposes worker enablement, last successful cycle, safe last error, oldest eligible pending age and bounded 24-hour samples for states, in-app publication, claimed versus dispatched attempts, ambiguity, stale suppression, webhook evidence, retrieval mismatch and repair discoveries. Count subqueries cap at 10,000; the intent sample exposes truncation. This is bounded operational health, not lifetime financial/notification analytics. Persisted checkpoints/health/observations survive process restart. Cycle error logging contains only worker and fixed safe category; message content/contact and provider credentials are never logged.

### Schema and security review

`Migration20261113120000` adds notification-only health/checkpoints, append-only runtime observations, webhook receipts and first provider observations, plus notification pagination/health and specific owning-audit discovery indexes. No finance arithmetic, entitlement, dispatch state or native commerce structure/authority is changed. Each SQL statement/function remains separately submitted; destructive rollback of evidence is refused. Existing B guards/claim/retry/source uniqueness remain intact. The B primitive gains only conditional suppression, pre-claim attention and caller-transaction evidence persistence; old call behavior remains available.

SOURCE (authenticated actor/current native identity or verified raw webhook) → TRANSFORMATION (strict pagination/DTO/evidence allowlist) → TRUST BOUNDARY (frozen actor ownership + current membership/grants / exact known provider binding) → SINK (own IN_APP projection/once-only read mark or notification-only transport evidence). Reviewed BOLA/BFLA, revocation, role changes, CSRF, mass assignment, cursor/resource abuse, signature/replay/body substitution, SSRF, duplicate claims, late result fencing and secret/private-content logging. Fixed the credible retrieval race where independently sampled observation times could falsely conflict: first observation is now transactionally frozen. No unresolved confirmed Critical/High/Medium issue was identified statically; runtime/HTTP/browser acceptance is not claimed.

### Verification and limitations

Unit coverage adds retry/worker policy, evidence ordering, cursor validation, DTO/role/ops allowlists, official signature vector, mutation/replay rejection and controlled known-ID retrieval. API-client tests cover each actor route, credentialed no-store requests and the sole mark-read mutation.

`verify-notification-runtime.ts` reuses C's private schema/source fixture setup via an opt-in callback; ordinary C verification is unchanged. It proves real repair + subscriber + duplicate repair convergence, postactivation late visibility on a new repair instance, preactivation exclusion, retrospective readback/contact-change suppression, competing execution, accepted evidence, stale no-send, absent configuration/no attempt storm, exact retry delays/four-attempt budget, terminal no-retry, undispatched versus ambiguous recovery, accepted-provider/local-result rollback recovery with identical key, and outside-horizon attention. It verifies signed known-ID evidence once, changed/unknown binding rejection, late ordering, retrieval/mismatch and actor-own/foreign list/detail/mark routes, current membership/identity/grant revocation, suspended driver access, cursor stability and private DTOs. No live Resend request is made. Real PostgreSQL/deferred guards are used; native identity/Order and provider responses are controlled module boundaries. API-level tests invoke the real route handler/service against that database, not a browser or live-cookie middleware session. E must separately prove the live browser/session/privacy experience.

The existing activation crossing-boundary limitation remains conservative. Exactly-once human email delivery is not promised. Repair latency grows with postactivation backlog. Uncertain sends outside the replay horizon and configuration attention remain read-only operator attention—no force resend policy is invented. Deployment must configure/verify the real sender, API key, webhook secret/subscriptions and explicit audiences/ops grant before enabling workers/ingress. M25 performance/deprecation debt is unchanged.

### Commands for user to run

Repository root, PowerShell, **one at a time; stop on every failure**. No verification commands were run by Codex. Filesystem directory creation only was required for new route folders.

1. `pnpm run lint` — expected zero warnings/errors.
2. `pnpm run typecheck` — expected all workspace TypeScript checks pass.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/notification-policy.test.ts tests/notification-mappings.test.ts tests/notification-runtime.test.ts` — focused B/C/D units, no network.
4. `pnpm --filter @gospaza/api-client exec tsx --test tests/notifications.test.ts` — typed actor/ops client route tests pass.
5. `pnpm --filter @gospaza/backend run build` — expected Medusa build succeeds.
6. `pnpm --filter @gospaza/backend run test:notification-environment -- migrate gospaza_m18_c2b_test` — forward migration on the existing explicit _test database/Redis 1; no database creation.
7. `pnpm --filter @gospaza/backend run test:notification-environment -- verify-runtime gospaza_m18_c2b_test` — expected M22-D notification runtime passed and finished execution; no email.

No broad C source/M8–M21 suite or Playwright is requested. The runtime verifier supplies the smallest C repair integration proof and checks the confirmation-only read. D is ready for user verification, not declared green. E remains separate: visual inbox/notification-ops UX, read presentation, deep-link navigation and final browser/privacy/provider-failure acceptance.

### Files materially changed by D

- `apps/backend/src/lib/notification-runtime-policy.ts`, `notification-currentness.ts`, `notification-runtime.ts`, `notification-repair.ts`, `notification-inbox.ts`, `notification-http.ts`, `notification-webhook.ts`, `notification-foundation.ts`, and the narrowed permission-only parameter type in `notification-recipients.ts`.
- Marketplace `notification-repair-sources.ts`, `notification-runtime-schema.ts`, `notification-sources.ts`, `migrations/Migration20261113120000.ts`.
- Jobs `notification-delivery.ts`, `notification-repair.ts`; actor notification list/detail/read routes in four families; notification-operations list/health and hooks/gospaza/resend routes; API middleware raw-body configuration.
- `src/scripts/verify-notification-runtime.ts`, opt-in fixture reuse in `verify-notification-mappings.ts`, `tests/notification-runtime.test.ts`.
- `packages/contracts/src/notifications.ts`, `packages/api-client/src/notifications.ts`, both index exports and API-client `tests/notifications.test.ts`.
- Backend `package.json`, `.env.example`, `scripts/notification-foundation-environment.ts`, this contract.

## 30. M22-E — role presentation and final acceptance

A–D are user-verified; the historical D command/report section above records its original handoff, not the current verification status. E adds compact customer/merchant/driver inboxes and a separate safe platform operations surface using D DTOs. Read state changes only from authoritative responses; frozen messages render as text; stored role-safe links confer no destination authority. Driver offers route through existing dispatch validation. No kinds, mappings, channels or retry policies change.

The customer notification client now supplies the publishable key required by pinned Medusa store middleware. No DTO expansion or business-domain change is required. Purpose-specific native actors, a private notification acceptance schema, one persisted manifest pointer, live HTTP authorization/revocation checks and exactly three browser journeys provide final acceptance. No real email is sent.

[M22-E acceptance](M22_E_ACCEPTANCE.md) records material files, fixture authority/limitations, security review, lifecycle, exact ordered PowerShell commands and closure criteria. E is ready for user verification, not declared green. M22 closes only after that verification passes and no confirmed Critical/High/Medium security issue remains. M23 is not authorized.
