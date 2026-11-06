# M22 Notifications — architecture audit

Status: audit only, awaiting M22-A policy approval. Provider/channel amendment: the user has selected Resend as the initial EMAIL transport and IN_APP as the primary durable operational surface. This selection does not authorize implementation. Branch inspected: `milestone/m22-notifications`. M21 completion is supplied by the user; historical milestone headings saying “pending” do not reopen verified work. No production implementation, dependency installation, migration or verification command is part of this audit.

## 1. Existing infrastructure

The repository pins Medusa 2.18.0. `apps/backend/medusa-config.ts` configures Redis event bus, Redis workflow engine, Redis locking, Marketplace, native fulfillment, private files, guarded native Store Credit and conditional Yoco payment. It does **not** configure the Notification module or an email provider. `packages/config/env.cjs` has no notification-provider contract. Secret values were not inspected.

Installed transitive packages include `@medusajs/notification`, `notification-local`, and `notification-sendgrid`, all 2.18.0. `@medusajs/medusa` directly depends on these packages; the backend does not directly declare SendGrid. No SendGrid configuration or application references were found under apps/packages. It is unused transitive infrastructure, not the intended transport; leave it installed rather than altering Medusa dependency ownership for cleanup. Installation is not activation. In installed `@medusajs/modules-sdk/dist/definitions.js`, Notification has `defaultPackage: false`; `framework/dist/medusa-app-loader.js` only merges defaults having a default package. The notification provider loader supports conditional cloud email fallback when its module/cloud configuration exists; no such explicit notification/cloud configuration was found in this repository. This is static configuration evidence, not a runtime provider-health check.

Redis accelerates work; it is not notification, order or financial truth. Existing PostgreSQL patterns include the verified Yoco inbox, durable dispatch/pickup work, recovery records, immutable financial commands/audits and bounded repair cursors. Do not reuse the Yoco inbox as an unrelated email queue. PostgreSQL LISTEN/NOTIFY in cart admission is lock coordination, not user messaging.

## 2. Providers and native capability

Pinned source inspected:

- `@medusajs/notification/dist/models/notification.js`: recipient/channel/template/data, receiver/resource references, unique nullable `idempotency_key`, provider/external ID and PENDING/SUCCESS/FAILURE status.
- `dist/services/notification-module-service.js`: creates initial rows transactionally, then calls providers, then persists success/failure. The source explicitly notes a remaining idempotency race. Existing PENDING/SUCCESS keys are skipped; FAILURE is considered for processing. Its retry normalization/record-ID behavior needs a focused compatibility proof before use; do not assume every resubmission returns an existing receipt.
- `dist/services/notification-provider.js` and `dist/loaders/providers.js`: provider routing by configured channel; no provider credentials supplied by installation.
- `@medusajs/notification-sendgrid/dist/services/sendgrid.js`: API key/from configuration, template or subject/HTML, dynamic template data and attachments. It awaits SendGrid, discards its response and returns `{}`. It forwards no provider idempotency key. `provider_data.personalizations` can override recipients; that must never become an event/client-controlled input.
- `@medusajs/notification-local/dist/services/local.js`: logs recipient and serialized data; returns `{}`. It is not real delivery and is unsuitable for sensitive fixtures without a redacting replacement.

Resend is the approved initial EMAIL provider. No Resend SDK, compatible provider or configuration is currently present in the repository/installed dependencies. SMS, WhatsApp and push infrastructure is also absent. Sender verification, environment configuration and adapter compatibility remain implementation gates; provider selection is settled.

### Smallest Resend integration against pinned Medusa 2.18.0

Preserve `committed domain fact → GoSpaza intent → channel attempt → Medusa Notification → Resend provider`. Domain subscribers/planners never import Resend or call its HTTP API.

The installed SendGrid provider demonstrates the supported seam: export `ModuleProvider(Modules.NOTIFICATION, { services: [...] })`; implement a service extending `AbstractNotificationProviderService` with a stable identifier and `send(ProviderSendNotificationDTO): Promise<ProviderSendNotificationResultsDTO>`. Register the custom provider under the Notification module's `options.providers`, with explicit `options.channels: ["email"]`, avoiding native cloud fallback or competing email providers. No existing compatible Resend provider is present, so recommend a small repo-owned adapter. Do not add a broad third-party plugin or upgrade Medusa to obtain one.

Pinned `@medusajs/types/dist/notification/provider.d.ts` exposes to/from/channel/template/content/data/provider_data and returns optional `id`. It does **not** expose native notification `idempotency_key` to the provider DTO. Carry a validated server-only transport key through an allowlisted provider_data field; the adapter forwards that key and the frozen envelope, then returns Resend's ID as `{ id }` for native external_id persistence. Native row idempotency and provider idempotency are separate boundaries. The dispatch orchestrator must persist/link the native attempt and returned provider ID without assuming its own final write is atomic with external acceptance.

The adapter contains transport mapping, safe error classification and bounded provider calls only; intent eligibility, retry policy, claims and financial/dispatch truth stay outside it. Any retrieval/webhook normalization should sit behind the same transport integration boundary and expose provider-neutral evidence to the orchestration service. No subscriber-level Resend lookup logic.

Proposed environment contract for A: `RESEND_API_KEY`, a validated configured sender such as `RESEND_FROM_EMAIL`, and `RESEND_WEBHOOK_SECRET` only if webhooks are enabled. Wire through the established environment-validation/configuration path; do not hardcode credentials, invent values or log them. Keep the API destination fixed by the adapter, not request/event input. A direct bounded HTTPS implementation can avoid an SDK dependency; choose an official SDK only if justified during implementation, pin it and disable any hidden retries that would bypass orchestration bounds. No dependency was added in this amendment.

## 3. Templates, subscribers and application surfaces

No project notification templates, mail helpers, notification subscribers, inbox/read-state DTOs, communication preferences, service-worker push, WebSocket or EventSource implementation were found in the inspected actor apps/contracts/client.

Project subscribers are `src/subscribers/order-placed.ts`, `dispatch-ready.ts`, `recognize-delivered-order.ts`, and `recognize-driver-delivery.ts`. They ensure order operations, wake dispatch, recognize marketplace finance and recognize driver earnings respectively; none sends notifications.

Installed Medusa has `dist/subscribers/configurable-notifications.js`: a hard-coded `order.created` email mapping to `order-created-template`, deriving an address from its event payload. It is not a GoSpaza template or proof of a configured email path. Before enabling Notification, explicitly prevent overlap with this native mapping and verify its loading behavior. GoSpaza must not accidentally send a generic early order email alongside its committed-order mapping. Existing pickup/handoff native workflows deliberately pass `no_notification: true`; preserve that boundary.

## 4. Authoritative event inventory

**Notation:** B = actual bus event; D = durable database fact/action, not a bus event name. D rows become externally observable only after their owning transaction commits, including deferred constraints. Proposed notification names are not presented as existing events. Payload column lists current evidence, not permission to copy raw JSON into messages. For every row, subscriber input is a hint: validate IDs and re-read the owning domain before creating an intent.

| Candidate / actual name | Producer and transaction boundary | Current payload / authoritative evidence | Replay, commit safety and repair |
|---|---|---|---|
| M8 cart binding (D) | `workflows/create-marketplace-cart.ts`, switch workflow and `lib/cart-service.ts`; native cart creation plus canonical binding publication | Customer/cart, `cart_marketplace_context`, merchant/store | Creation/restoration can replay. Not an order or receipt notification. Canonical binding is rediscoverable; no routine cart email recommended. |
| `order.placed` (B) | Installed core-flows `cart/workflows/complete-cart.js`, emitted alongside link/cart completion/reservation/promotion work | `{id: createdOrder.id}` | Native workflow event can precede GoSpaza M10 terminal receipt. Duplicate/recovery possible. Never sufficient alone for confirmed-order communication. |
| Committed checkout completion (D) | `lib/payment-reconciliation-service.ts` completion observation; one final transaction | `checkout_completion` SUCCEEDED/native done/terminal receipt, attempt COMPLETED, native order, reservation COMMITTED, exact context/customer/store links | Rediscover through `modules/marketplace/order-operation-repository.ts` `completedOrderCandidates`/`readOrderHandoff`. Those checks explicitly reject early native events. Unique completion/order is the logical fact. |
| Payment authorization (native fact) | Native payment session/Payment module; M10 provider authorization/capture path | Native payment/session/collection and M10 operation correlation | No standalone GoSpaza authorized bus producer found. Native module/workflow state is not GoSpaza order completion. Re-read correlated persisted evidence; no separate “order confirmed” message. |
| `payment.captured` (native B) / verified capture (D) | Installed `payment/workflows/capture-payment.js`; GoSpaza verified-payment acceptance and final completion are separate boundaries | Native capture ID; `verified_payment`, provider operation/checkout and accepted timestamp | Native capture can belong to a late/closed checkout needing technical compensation. Native event alone unsafe. Repair correlated M10 state, not amount/customer matching. |
| `payment.succeeded`, `payment.failed` (provider ingress, not GoSpaza bus) | Verified webhook → `yoco_inbox` RECEIVED; `applyInbox` performs separate business transaction | Unique event ID, normalized verified evidence/fingerprint, correlated checkout/operation | Ingress acknowledgement is not business application. Duplicates and late/contradictory events possible. Inbox repair exists. Never use ingress alone to announce success/failure. |
| Payment FAILED/EXPIRED/recovery (D) | `payment-reconciliation-service.ts`, initiation/recovery services; committed attempt/operation changes and capacity release | Checkout attempt, deadline, provider operation and completion evidence | Same operation readback is idempotent; payment can recover. Suppress obsolete failure notices before send; unresolved recovery is not settled refund. Rediscover persisted attempt/operation, not transient HTTP errors or Pay contention. |
| Merchant ACCEPTED/REJECTED (D) | `lib/order-operations-service.ts` `decide`; decision, operation revision and rejection capacity release in one transaction | `order_decision_event`: operation, merchant/store, member, from/to, bounded reason, decided_at | Idempotent decisions must map to the same durable decision, not each request. DB repair from decision + operation/native order ownership. No decision bus event currently. |
| Picking CLAIM/LINE/REASSIGN/COMPLETE (D) | `lib/picking-service.ts` merchant/operation/session transaction | `pick_event` session/revision/action/member/native line/request/before/after; unique session+revision | Not all line edits warrant notices. COMPLETE requires completed source/audit, not workflow dispatch. Read persisted session/line evidence; event payload contains fields unsuitable for wholesale disclosure. |
| `gospaza.picking.completed` (B) | `workflows/update-picking.ts`, after awaited mutate commits; only when `DISPATCH_WORKER_ENABLED=true` | `{id: order_id}` | Best-effort dispatch wake-up; emission can fail or replay. Cannot be sole notification source because disabled worker prevents emission. Repair committed COMPLETE/session. |
| SHORTAGE_CREATED / OMITTED_BY_PREFERENCE / CUSTOMER_OMITTED / SHORTAGE_INVALIDATED (D) | `modules/marketplace/shortage-resolution.ts`, owning picking/customer decision transaction | `shortage_event` case/generation, operation, revision, actor, evidence; current `shortage_resolution` | CONTACT_ME currently supports CUSTOMER_DECISION_REQUIRED → RESOLVED_OMITTED; NO_SUBSTITUTION may omit automatically. No shipped replacement-selection/deadline notification should be invented. Re-read live generation, invalidation/session state. Durable cases/events support repair. |
| OFFER_CREATED (D) | `lib/dispatch-service.ts` offer transaction | `dispatch_event`, delivery/revision/generation, commitment ID/driver, OFFERED state and expiry | No offer bus event. Retry/worker restart must reuse exact commitment identity. Repair only currently valid offer, never every historical OFFER_CREATED row. |
| Offer DECLINED/EXPIRED/CANCELLED (D) | `dispatch-service.ts` `closeOffer`, transaction updates commitment, delivery/capacity/audit | Commitment status/revision/reason/decided time and corresponding delivery audit | These terminate actionable offer notices; no late offer email. Historical fact remains, current inbox card becomes non-actionable. DB can rediscover terminal status. |
| ASSIGNED (D) | `dispatch-service.ts` `decide`; accepted exact revision/generation, eligibility/compensation checks and capacity in one transaction | Assigned commitment, delivery revision/path, driver profile, assignment-time M21 snapshot | One winning commitment; two driver ACCEPTs must not create two notices of assignment. Re-read active relation; superseded assignment suppresses obsolete pending notice. MERCHANT/PLATFORM paths use same authority, different authorized recipients. |
| FULFILLMENT_PREPARED / PICKED_UP (D) | `lib/pickup-service.ts` observes exact native workflow receipt, then committed operation/audit | `pickup_operation` PREPARE/SHIP SUCCEEDED/native done, native fulfillment/shipment, `picked_up_at`, `dispatch_event` | DISPATCHED/PICKUP_REQUESTED is not proven pickup. Native success/local failure is repaired by existing observation. Notify only proven PICKED_UP, one operation/transition. |
| ARRIVED (D) | `lib/handoff-service.ts` owning pickup/delivery transaction | Delivery state/revision/arrival + `dispatch_event` ARRIVED | Persisted fact is repairable; Redis GPS/presence is not its authority. Message links to current order; no GPS or OTP in message. |
| HANDOFF_GENERATED/REGENERATED/VERIFIED and guesses (D) | `handoff-service.ts` controlled generation/attempt transactions | Handoff generation, hash/verifier, limits and dispatch audit | Do not turn guesses, OTP changes or verification internals into routine notices. Generation is never plaintext notification payload. Current customer API owns stage-bound code disclosure. |
| DELIVERED / `gospaza.delivery-completed` (D/B) | `handoff-service.ts` observation first commits completion SUCCEEDED/native_done, commitment COMPLETED, delivery DELIVERED/delivered_at and audits; then emits | Bus `{order_id}`; D includes native delivery receipt and completion ID | Emission is best effort after commit; already-SUCCEEDED replay returns without guaranteed re-emission. Repair durable delivered completion; never infer from driver click or native workflow dispatch. |
| Delivery ATTENTION_REQUIRED / recovery (D) | Dispatch, pickup or handoff service commits reason and recovery records/audit | Delivery/operation state, bounded reason and revision | Technical attention is not automatically failed delivery or a customer compensation entitlement. Authorized platform alert only, deduplicated per exception episode. Repair current unresolved evidence. |
| RETURN_REQUIRED / RETURN_STARTED / RETURN_ARRIVED / STORE_RECEIPT_ACKNOWLEDGED (D) | `lib/recipient-service.ts`, restricted-commerce event writer and custody transactions | `restricted_return`, delivery/receipt relation, terminal custody/audit; `restricted_event` action/evidence | Restricted verification failure evidence is private. Current custody and terminal exclusions must be re-read. Merchant receipt + terminal state are atomic; notifications occur after commit. Repair custody source, not raw recipient observations. |
| Financial adjustment created/approved (D) | M18 financial-adjustment service, atomic entitlement/source/audit | `financial_adjustment_event` CREATED_FOR_REVIEW/AUTOMATICALLY_APPROVED/MANUALLY_APPROVED; amount/currency/source/method | Approved entitlement ≠ settlement. Review-only goodwill is not credit/refund. Repair same adjustment/source ID; platform review notice can be useful, customer “paid” cannot. |
| Store Credit SETTLED (D) | `lib/store-credit-settlement.ts`; native issuance/readback then local settlement transaction | Exact native account/transaction match; `store_credit_operation`, `store_credit_operation_event` revision/status; financial_settlement SETTLED | Issuance retry/local recovery must not notify twice. Intent anchored to settlement fact/operation, not each attempt. Existing native balance remains authority. Rediscover settled operation. |
| Refund SETTLED / ATTENTION_REQUIRED (D) | `lib/refund-service.ts` and `modules/marketplace/refund-repository.ts`; verified provider correlation + native refund/accounting, then local transaction | `refund_event` action/revision, `refund_operation`, settled_at/native transaction, financial_settlement | Provider `refund.succeeded` ingress alone is insufficient. Recovery/duplicate webhook same operation yields same notice. Attention is ops-specific; customer persisted safe pending state only. Rediscover operation+audit. |
| M19 DELIVERY_RECOGNITION / exception (D) | `lib/marketplace-recognition.ts`; immutable posting/source and audit transaction | Marketplace finance posting, source fingerprint/recognition/exception | Internal recognition does not mean merchant payout. Delivery event is only wake-up. Repair source/unique posting, no customer ledger-spam notification. |
| M20 GENERATED/SUPERSEDED/READY/FINALIZED (D) | `lib/merchant-settlement-service.ts` statement/source claims/carry/preparation transactions | `settlement_transition_audit`, statement revision/manifest and payable | DRAFT generation/supersession are not paid messages. Repair valid prepared/current statement and its audit; freeze statement identity, not merchant+amount. |
| M20 APPROVE/PAY/FAIL/RETRY/RECONCILE/DISCREPANCY (D) | `lib/merchant-payout-service.ts` authorized command and evidence transaction | `merchant_settlement_command`, payable revision, payout receipt/reconciliation/discrepancy | PAY records an already-performed external transfer; no bank execution. Retry cannot create duplicate notice for same command. Repair exact committed command/receipt. OPEN discrepancy must not be described as successful reconciliation. |
| M21 RECOGNITION/EARNING/EXCEPTION (D) | `lib/driver-earning.ts` recognize transaction; delivery-completed subscriber is wake-up | `driver_earning_recognition`, earning, `driver_earning_audit`, compensation source | Successful proven delivery, not fee or offer, establishes ordinary earning. Replays/repair dedupe source. Exception goes to granted ops, not unrelated drivers. |
| M21 RECORD/UNKNOWN/CONFIRMED_PAID/CONFIRMED_NOT_PAID/RECONCILE/DISCREPANCY (D) | `lib/driver-payment.ts` command/item/hold/allocation/resolution transaction | `driver_payment_command` and payment items/allocations/holds/resolution/reconciliation | Recorded/unknown/reconciled have distinct semantics. Do not send “money received” or create another transfer. Repair committed command + exact payment projection; driver notification excludes restricted evidence. |

No candidate above authorizes new business transitions. Native payment/entity events are not a substitute for M10 receipts. No GoSpaza generic “failed delivery” bus event, replacement offer event or notification preference event was found.

## 5. Actor/recipient model

| Actor | Authoritative recipient/eligibility | Relevant scope |
|---|---|---|
| Customer | Native Order/customer relation plus completed M10 handoff; native Customer/auth identity | Own order, shortage action, safe delivery and financial outcomes. No browser customer_id/email authority. |
| Merchant OWNER | Active `merchant_member.auth_identity_id`, resolved tenant and capability | Own store operational and financial notices. |
| Merchant MANAGER | Same tenant resolution; explicit capability matrix | Order decisions/operations and settlement reads where granted. Not automatically all platform finance. |
| Merchant PICKER | Active membership, PICKING capability and current assigned session where relevant | Assigned picking/shortage and physical return receipt. No settlement, goodwill, payout or sellability decision authority. |
| Driver | `DriverService` native auth identity → DriverProfile binding | Own live offers/assignment and own safe earning/payment outcomes. Suspension removes operational eligibility, not existing own financial history. |
| Platform user | Native user plus current explicit operation/finance grant | Domain-specific exceptions/approval tasks; not every native admin gets every alert or evidence. |

Merchant authorization sources: `modules/marketplace/team-policy.ts`, `merchant-authorization.ts`, Marketplace `resolveTenant`. Recheck membership/tenant/capability at intent planning, send and read. Event-time membership alone is not enduring permission. Driver display name/contact_phone are not verified email authority. Resolve merchant/driver native emailpass contact through validated auth identity; email verification/destination-change policy remains an A decision. Platform financial/view/record/reconcile grants are independent. Add explicit notification-ops inspection/recovery capability if needed; it must not confer original-domain financial authority.

## 6. Channel feasibility

| Channel | Current condition | Classification |
|---|---|---|
| Email via Resend | Approved transport; native Notification installed but unconfigured; Resend provider/SDK absent | Small custom Medusa provider plus environment configuration/templates and recovery proof required. Not already available. |
| In-app | Actor auth, safe projections, polling/revalidation patterns exist; no inbox/read persistence | Straightforward small GoSpaza actor-owned extension; not already implemented. |
| SMS | No configured transport, verified phone lifecycle or templates | New provider/infrastructure; outside proposed MVP. |
| Push | No subscription/device token/service-worker/provider infrastructure | New infrastructure; outside proposed MVP. |
| WhatsApp | No provider/business account/templates/consent infrastructure | New provider/infrastructure; outside proposed MVP. |

## 7. Recommended MVP channels

Approved starting assumption: IN_APP is the primary durable operational surface; EMAIL via Resend serves selected transactional customer communication. The exact audience/channel matrix belongs to M22-A. Email activation still requires verified sender/configuration and adapter compatibility proof; do not label local logs as sent mail. Merchant/driver/platform operational notices are in-app initially. No time-critical driver offer email. No claim of guaranteed background delivery when the driver browser is closed; that is a launch/product decision if polling is insufficient.

The roadmap (`docs/build/BUILD_PLAN.md`) names M22 “Notifications & realtime updates.” Revalidation/polling satisfies correctness; low-latency refresh can be added within this milestone if explicitly approved. WebSockets, mobile push and a generic realtime platform are not prerequisites.

## 8. Truth model

`committed domain fact → notification intent → channel attempt → acceptance/result`.

The domain owns whether an order was placed, delivered or paid. A notification never creates that fact or compensates it. A subscriber validates/re-reads and calls one intent planner; bounded repair calls the same planner. Provider work runs after the domain transaction and outside financial/dispatch locks. Notification failure cannot roll back delivery, settlement or payment.

## 9. Persistence and Medusa ownership decision

Propose a minimal GoSpaza notification intent/outbox linked to native/customer and custom domain IDs, actor target and tenant scope. It owns eligibility, deterministic semantic identity, source revision, audience authorization, frozen safe content, expiry/suppression, claim/lease, next_due and recovery. Append attempts own attempt number, start/finish, safe error classification, provider/native receipt reference and ambiguity. An in-app receipt owns only publication/read_at for that actor; it is not another business ledger.

Use Medusa Notification for email provider dispatch and native transport records. It lacks the required source-fact admission, actor-owned unread model, expiry/authorization, due repair and bounded provider-ambiguity recovery. Its unique notification row does not make the external send atomic. Do not replace its commerce-independent provider abstraction with direct calls scattered across services.

One logical intent per fact/recipient; channel deliveries unique per intent+channel; append attempt rows per channel delivery. This prevents email acceptance from marking in-app read or one channel failure from changing another. Exact model count/names belong to B after A approval. Do not add competing customer balances, finance states or dispatch offer authority.

## 10. Idempotency

Unique logical key: `(semantic notification kind, immutable source fact ID, semantic source transition/revision, recipient actor type, recipient stable ID)`. Channel delivery uniqueness adds channel. Use committed command/audit/completion identities or a documented terminal transition, not delivery/customer+amount or arrival time. Template version is a frozen attribute, **not** a reason to resend the same fact.

Subscriber/repair/worker races converge on PostgreSQL uniqueness and conditional writes. Read/unread writes require actor ownership and are idempotent. Do not dedupe solely in Redis. Use a stable hashed server-derived provider key for the same channel delivery across retries; native attempt keys may distinguish native transport attempts. Before relying on that approach, B must prove native PENDING/FAILURE handling and exact adapter forwarding against 2.18.0. Blindly re-calling `createNotifications` with the original PENDING key is not recovery evidence.

## 11. Lifecycle and visible meaning

Propose channel states PENDING → SENDING → ACCEPTED, RETRY_WAIT, FAILED_TERMINAL, ATTENTION_REQUIRED or SUPPRESSED. Claims carry fencing token/lease so stale workers cannot overwrite a later result. Expired SENDING is **uncertain**, not automatically safe-to-resend. In-app publication commits a durable notice and is independent of external acceptance.

ACCEPTED means provider acknowledgement only. “Delivered” requires separately authenticated provider delivery evidence and is unnecessary for MVP. Recipient reads do not prove inbox delivery. Customers see domain outcome, not infrastructure retry states. Platform notification ops may see bounded attempt/error state with explicit grants; no message bodies/addresses by default.

## 12. Retry/backoff proposal

At most five send attempts total, with proposed retry delays 1 minute, 5 minutes, 15 minutes and 1 hour, bounded jitter/Retry-After and event expiry. These are policy recommendations, not existing behavior. No sleep in business requests. Worker claims bounded due batches with `SKIP LOCKED`, releases DB transaction before network send, then fences result persistence.

Classify provider errors explicitly: bad destination/template/config → terminal or ops attention; rate limit/confirmed nonacceptance → bounded retry; request possibly accepted but response lost → ambiguity path. A generic 5xx/network exception is not proof of nonacceptance. Exhaustion enters attention; repair cannot reset attempt count or create fresh keys to evade limits. Provider outage circuit/throughput bounds must prevent retry amplification.

## 13. Provider-success/local-crash ambiguity

Native SUCCESS persistence can be lost after external acceptance. An expired lease or PENDING native row cannot prove delivery absence. With a proven provider key contract, replay the **identical frozen envelope** with the same provider key within its retention window; converge on returned provider ID. Where that window has elapsed or provider behavior is unproven, stop in ATTENTION_REQUIRED and investigate; do not rotate keys and resend blindly.

For the selected Resend transport, apply the recovery contract below. SendGrid limitations above are historical dependency evidence, not the selected production design. Deterministic Message-ID alone is not recipient-visible deduplication. In-app still has exactly one durable notice. An operator retry must not bypass uncertainty merely by clicking “retry.” Provider webhook work, if added, needs signature verification, unique persisted event ID and exact provider-message correlation; no arbitrary callback changes business state.

### Resend evidence and residual risk

- [Idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys): same key/payload replays within 24 hours return the original result; key limit is 256 characters. Payload-conflict 409 requires attention; concurrent-request 409 permits bounded later recovery. Never remove/change the key to evade either condition.
- [Send API](https://resend.com/docs/api-reference/emails/send-email): returns an email ID. Persist it in native external_id and the linked delivery evidence. Server-generated opaque correlation tags can assist investigation; they are not a uniqueness guarantee or authorization.
- [Retrieval](https://resend.com/docs/api-reference/emails/retrieve-email): known email ID can recover status/last_event. It does not establish lookup by lost GoSpaza key. Do not match by recipient+amount/subject/time.
- [Webhook events](https://resend.com/docs/webhooks/event-types) include sent, delivered, bounced and complained. Delivered means the recipient mail server accepted it, not that a person read it. Keep acceptance and later delivery evidence separate.
- [Webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests) requires the signing secret and raw body. Persist/dedupe the authenticated event, correlate the exact email ID, and tolerate reordered/duplicate callbacks. If the send ID was lost, an otherwise uncorrelated callback remains unmatched evidence until a proven exact mapping exists; do not guess. Webhook correlation/tag echo must be compatibility-tested before relying on it to repair a lost ID.

Record first possible dispatch time durably before network work. Recovery uses the same frozen envelope/key and a conservative deadline inside Resend's retention window, accounting for clock/network uncertainty. Do not reset that deadline on every attempt. Beyond the safe window, or where exact evidence remains unavailable, enter ATTENTION_REQUIRED and stop automatic sends. A pending native row still needs orchestration recovery rather than blind resubmission with its existing skipped key.

Strongest truthful claim: one durable logical notice, bounded keyed API replay, and evidence-based transport convergence. Neither this API contract nor delivered webhooks prove exactly-once human-visible email. If an unresolved send is deliberately resent after key retention, duplication is possible; normal recovery must not do that automatically. An unchanged source fact cannot acquire a fresh intent/key merely to resend. This trades possible missing email for avoiding blind duplicate sends, while IN_APP retains the authoritative service notice.

## 14. Recipient resolution and destination freezing

Server derives identity from the source and owning domain. Freeze target actor, tenant, destination provenance/version and minimal envelope; never accept `to`, CC/BCC, sender, raw HTML, provider_data or link host from a client/event. Immediately before dispatch, revalidate current eligibility and destination binding. A revoked membership or changed destination suppresses/holds the old intent; do not silently reroute historical private content to a new owner/address. Any explicit replacement must retain provenance and dedupe semantics.

Native Order.email may be used only after proving it is populated from an authoritative contact and tied to the final Order. The current `create-marketplace-cart.ts` passes customer_id but no explicit email, and M10 `checkoutSnapshot` freezes identity/address/economics, not a notification email. Do not assume native workflow population or a verified destination without a readback test. A contract-approved minimal contact snapshot may be necessary; that is not permission for new checkout identity rules.

## 15. Guests

Current GoSpaza cart HTTP routes require authenticated actor_type customer + actor_id, block native-cart bypass, and bind customer_id server-side. No reachable anonymous GoSpaza checkout was found. M18's native Customer.has_account/guest fallback is a financial contingency, not a shipped guest checkout feature.

Do not auto-create accounts or anonymous inboxes. If a real guest source is introduced later, email-only transactional delivery requires an authoritative frozen Order contact and approved ownership rules; otherwise fail closed/attention. Do not borrow another registered account by matching email. Registered-customer in-app ownership uses stable customer identity, not email equality.

## 16. Templates and rendering

Recommend repository-owned, typed allowlisted templates under the backend notification domain with stable kind/version and tests; no editable generic HTML admin API. Freeze version, locale, safe scalar payload and rendered text/HTML/envelope at intent creation after recipient validation. Retries use byte-equivalent provider payload, including links, to preserve idempotency. Escape all interpolated values, reject header newlines and allow only application-generated same-origin links. No long-lived bearer links or private evidence URLs.

Freezing makes audit/retry stable but duplicates personal data and can become stale. Minimize stored content and use generic “open your order” bodies for sensitive/current details; validate/suppress before send. Do not re-render a historic amount from a changed order or silently upgrade old messages to new templates. A distinct genuinely correcting fact can create a new notice.

## 17–20. Recommended actor message sets

| Audience | Recommended service messages | Exclusions / delivery |
|---|---|---|
| Customer | Committed order confirmation; merchant rejection/acceptance status; live shortage decision required; proven pickup/on-the-way; arrived/open order; proven delivered; bounded return required/return received; settled Store Credit issued; settled original-payment refund | In-app; email for confirmation/rejection/completion/settled compensation initially. No each-line edit, payment contention, raw compliance reason, OTP, internal refund recovery or implied refund from custody. Pending state stays truthful in existing order UI. |
| Merchant OWNER/MANAGER | New committed order requiring decision; picking ready/current assignment where relevant; driver assigned/pickup; restricted return requiring physical receipt; returned-stock disposition task for authorized roles; prepared/approved settlement availability and external transfer recorded/reconciled | Own tenant only. In-app initially. Explicit settlement capability required; no customer balance, platform goodwill controls or private payout proof in notification. |
| Merchant PICKER | Assigned picking work, current shortage/customer response and return receipt task where capability permits | Current assigned session/receipt authority only. No settlement/payable/disposition approval or finance audience inheritance. |
| Driver | Current offer; assignment accepted; bounded pickup/handoff/return task; own new earning and payment-recorded/reconciled notice where useful | In-app. Do not notify every expired offer or individual guess. Own financial history remains accessible when suspended; live offer eligibility is separate. No other driver's identity/earnings or private payment evidence. |
| Platform | Current dispatch recovery; restricted return operational attention; financial adjustment review; refund/credit uncertainty; settlement approval/discrepancy; driver compensation/payment exception; notification engine attention | Separate current domain grants and target resource scope. Do not broadcast all events to all admins. In-app queues/deep links; email escalation is an optional later policy choice, not assumed. |

These are recommended mappings, not an approved promise to emit every row. A should freeze the exact subset and message matrix. Mandatory service category means no marketing opt-out can remove required operational notices; it does not mean every state change needs an external email.

## 21. Finance boundaries

M18 approval is entitlement, not money delivered. Notify customer credit issuance only for exact settled native transaction/local settlement; refund only for authoritative settled refund. Preserve minor-unit amount/currency from existing projection; no browser recalculation. Do not put total current balance into email if it will be stale; link to current balance.

M19 posting is internal recognition, not merchant payment. M20 READY/APPROVED is distinct from PAID external transfer recorded and RECONCILED evidence review. Use “external payment recorded,” never “GoSpaza sent a bank transfer.” M21 earning, unknown outcome, recorded transfer and reconciliation remain separate; no claim the driver acknowledged receipt. UNKNOWN/discrepancy notifications should link to the recipient's bounded projection or the explicitly granted ops view. Notification retries never reserve/settle entitlement or run original financial commands.

## 22. Dispatch boundaries

Offer identity must include exact commitment/generation/driver and current delivery relationship. Validate OFFERED, unexpired, current generation, eligibility and absence of a competing winner at planning/publication/read. Delivery dispatch is server-controlled; notifications never grant claiming authority. Use existing offer decision API and expected revision when user opens the operational card.

Existing offer expiry is short (30 seconds in current dispatch policy); email queues are unsuitable. A persisted in-app historic notice must not remain an actionable offer after expiry/assignment. Mark/suppress it and return current authoritative availability. Even validation immediately before a network send cannot prevent state changing during transit, which is another reason not to send offer emails. Merchant-priority/platform spillover does not create a second assignment authority.

## 23. Staleness/supersession

Before sending: suppress expired offers, invalidated shortage generations, obsolete assignment, recovered payment failure, revoked audience/destination and superseded DRAFT tasks. Coalesce optional progress notices by a documented kind/resource policy, not by overwriting financial history. Committed historical confirmation/settlement facts remain true but can have expiry to avoid stale external backlog spam. Sent messages cannot be recalled; safe copy and live authorized deep links are essential. No notification cancellation may cancel a domain transition.

## 24. Preferences

No preference model exists. Recommend no full preference center or marketing subscription work in M22. Freeze a small mandatory service taxonomy; in-app service notices remain available. If optional external operational digests are approved, add only explicit channel/category preferences with actor ownership. Distinguish user preference, invalid destination/provider suppression and authorization suppression; mandatory does not justify sending to an unverified or revoked recipient. Marketing consent/campaigns remain out of scope.

## 25. In-app model

Recommend actor-specific list/count/read endpoints using existing route families and role DTOs; no generic client-supplied actor lookup. Keyset pagination by stable created_at+ID, bounded page size, idempotent own read_at update and no arbitrary content creation. Apply source-domain authorization on read/deep link, including immediate merchant membership/grant revocation. Safe generic card summaries avoid copying financial evidence. Marking a notice read is not acknowledging a return, settling a payment or accepting an offer.

Retention proposal for A approval: 30 days of ordinary in-app/message content, with smaller operational expiry for offers; minimal identity/dedupe tombstones survive content expiry so repair cannot recreate expired notices. Financial history stays in M18–M21, not in retained email bodies. Explicit cutover/lookback prevents historical bootstrap floods. Retention numbers are proposals, not legal determinations. Purge must not remove ambiguity evidence while a send is unresolved.

## 26. Privacy

External notifications should carry bounded order reference/status, merchant display name where appropriate, approved amount/currency/method and a safe authenticated link. No delivery street address, precise GPS, DOB/ID/document, recipient observations, OTP, private proof, bank beneficiary details, provider operation IDs, recovery fingerprints or secret values. Driver/merchant names only where the existing recipient projection permits. Restricted failure uses customer-safe copy; physical return does not imply credit/refund/restock. Avoid alcohol/item detail in email subject/lock-screen-style summaries.

## 27. Repair and recovery

Use bounded source-specific keyset cursors and immutable fact IDs; source domain exposes a narrow discovery contract rather than generic cross-domain table scraping. Existing order/dispatch/finance repair demonstrates this repository pattern. Cross-domain SQL in a notification repair adapter needs an explicit documented exception if no owning contract exists.

After an approved activation/cutover, discover missing required intents, then recover due attempts/stale leases using the same idempotent planner. Cursoring must account for late commits and late domain repair: terminal source transition timestamps/IDs, bounded overlap with uniqueness, and periodic bounded anti-join reconciliation; never rely only on monotonically scanning an older parent ID. Domain repair may establish a late authoritative fact; notification repair cannot fabricate one. Cap batch size, recipient fan-out, attempts and backlog age. Disabled workers leave durable due state; health exposes that condition.

## 28. Observability

Counts by kind/channel/provider/state: created, accepted, retry due, suppressed, terminal, attention; oldest pending/ambiguous age; claim expiry, provider latency/error class, repair discoveries, backlog and retry exhaustion. Correlate intent/attempt/source IDs in restricted operational logs; hash or omit destinations and never log rendered body/provider raw payload. Explicitly distinguish accepted from delivered. No native local-provider body logging for sensitive tests. Audit operator suppression/recovery with reason and original-domain authorization; do not add a mass resend endpoint.

## 29. Static security review

No current deployed notification endpoint/provider was found, so this audit does not claim an exploitable new application vulnerability. The following are concrete integration hazards and required implementation controls.

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Credible risk / required control |
|---|---|
| Event/customer payload → target mapping → tenant/auth boundary → inbox/email | Recipient spoofing/BOLA/cross-driver or merchant disclosure. Accept source IDs only; re-read ownership and current role; actor-specific DTO and foreign-ID/revocation tests. |
| Raw domain audit → generic template payload → recipient boundary → email/log | M17 observations, OTP or finance evidence leakage. Typed projection allowlist; never serialize raw evidence/request/before/after. |
| Sender/provider_data/content → provider adapter → external recipient/header → email | The selected Resend adapter must accept only a server-owned allowlisted envelope/key; native provider_data is not an arbitrary recipient/header override. No CC/BCC/input HTML/host; HTML escaping/header validation and malicious-input tests. |
| Local provider/native errors → logger → operations boundary → logs | Installed local adapter logs to/data. Do not enable for sensitive production/test messages; redact fake/adapter errors and sanitize native integration logging. |
| Duplicate bus/repair/lease expiry → retry planner → external API → duplicate financial-looking notice | SQL identity/fencing, stable provider key, bounded ambiguity handling; never imply a second economic settlement. |
| Deep link → browser navigation → actor resource boundary → detail/action | Allowlisted server-built paths, no arbitrary URLs/open redirects/auto-actions; known foreign IDs denied by original API. |
| Forged provider callback → delivery-state transition → provider-auth boundary → notification result | If callbacks added, verify signature/raw body, persist unique ID/correlation, monotonic authenticated evidence; cannot mutate order/payment. |
| Admin/event flood → fan-out/repair → worker/provider boundary → mass sending | Explicit ops grants, no generic arbitrary-send API, bounded audience/rate/retries and event identity. |

Severity is conditional on implementing an unsafe integration; dormant dependency behavior is not reported as a confirmed HIGH production finding. Final implementation requires executable tenant/identity/capability, injection, concurrency and privacy tests.

## 30. Proposed implementation slices

| Slice | Scope / dependencies | Schema | Highest-risk invariant | User verification boundary |
|---|---|---|---|---|
| M22-A contract | Approve channels/provider gate, exact audience/event matrix, frozen-contact policy, cutover/retention, retry/ambiguity and templates; depends on this audit | Documentation only | Do not invent business facts or promise external delivery | Static policy/source review; provider contract evidence, no production mutation |
| M22-B durable engine | Intent/channel/attempt/read-state foundation, SQL uniqueness/fencing, Medusa provider extension, fake transport; depends on A/Resend adapter contract | Forward migration for minimal notification-owned state | Provider accepted/local crash cannot cause blind duplicate send | Unit/native adapter compatibility + real DB subscriber/repair races, crash/lease/unknown-window proofs |
| M22-C domain mappings | Approved M10–M21 source discovery and recipient-safe templates; after B | Prefer no new domain truth; only justified source/contact extension | Exact committed fact and authorized audience, no stale offer or early order email | Real domain transitions/rollback/replay and foreign-actor tests, no mocked economic truth |
| M22-D delivery operations/read APIs | Bounded worker/repair, actor inbox/read DTOs, current grants, suppression, metrics; after B/C | Only required cursors/indexes, not new finance/dispatch state | Repair/revocation cannot leak, resend uncertain work or amplify retries | Worker restart/late commit/cursor gaps, pagination/read BOLA/revocation, outage and backlog tests |
| M22-E role UX/final acceptance | Existing four-app conventions, polling/deep links, empty/error/unread states, final privacy/security and provider sandbox acceptance | None expected | Notifications display persisted domain outcomes and cannot grant actions | Targeted browser journeys with dedicated mutable fixtures, disabled-provider/outage/revocation tests; user runs verification |

M23 admin operations, M24 reporting and M25 hardening remain separate. M22 includes only minimal notification recovery UI/API required for safe delivery. No marketing, newsletters, support inbox, SMS procurement, mobile push, WhatsApp, experiments, broad operations dashboard or new business workflow.

## 31. Genuine unresolved decisions

1. IN_APP primary + selected transactional customer EMAIL via Resend is decided. A must freeze the exact audience/channel matrix and decide whether closed-browser driver alerting is a launch blocker.
2. Resend is selected. Approve the sender/contact policy, bounded ambiguity recovery and webhook scope; prove the custom Medusa adapter mapping before activation. No compatible Resend adapter is already installed.
3. Approve contact provenance/verification and contact-change handling; current authenticated checkout does not itself prove a frozen verified email destination.
4. Freeze exact mandatory event/channel/audience list and platform grant audiences; financial read alone must not unlock evidence.
5. Approve activation time, lookback, suppression of historical backlog, retention/tombstone policy and bounded retry schedule.
6. Decide whether earning-created/payment-reconciled merits separate driver notices and whether merchant approved/reconciled statements need external email; avoid routine alert overload.

These are policy/integration gates, not reasons to invent credentials, add anonymous checkout or alter previous milestone truth.

## 32. Recommended M22-A contract decisions

Use the approved IN_APP primary surface and Resend EMAIL transport for selected customer transactional messages; freeze exact mappings in A. Sender/configuration and compatibility verification precede activation; no SMS/push/WhatsApp. Medusa transports email; GoSpaza owns source-linked intent, due-state recovery and actor read state. Unique fact/transition/recipient identity plus channel uniqueness is authoritative. Freeze minimal versioned content; recheck authorization/currentness before send/read. Domain facts always re-read, even for the two post-commit custom bus wake-ups. Early native order/payment events are hints only. Guests are not newly enabled. Mandatory service categories require no marketing preference center. Offers stay in-app/live and expire with authoritative commitment. Unknown external acceptance stops for bounded keyed reconciliation/attention, never blind resend. Use source-specific bounded repair and explicit cutover. End users see safe domain outcomes; notification ops see restricted transport state. Largest unresolved risk: proving provider crash recovery together with a trustworthy recipient destination.

## Audit handoff and verification status

Only this audit document was added. No production code, configuration, dependencies, schemas, routes, UI or tests changed. No commands, tests, migrations, builds or runtime probes were executed. Installed source and repository files were inspected through filesystem reads; provider documentation was consulted as linked above. No audit claim is a new runtime verification result.

Commands for user to run: none for this documentation-only audit. Review sections 31–32 before authorizing M22-A. M22 implementation has not begun.
