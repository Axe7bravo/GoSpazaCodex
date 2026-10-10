# GoSpaza — Milestone M10
## Checkout & Yoco Payments

Status: **Architecture approved after M10-A reconnaissance.**

M0–M9 are complete and verified. M10 begins from the verified M9 boundary.

M10 owns the minimum work required to move an authenticated customer from a valid single-store cart and valid M9 delivery selection into authoritative Medusa checkout, Yoco Hosted Checkout payment, verified reconciliation, and Medusa Order creation.

M11 owns merchant acceptance and operational order handling after commercial order creation.

---

# 1. Required skills / operating rules

Use:

- `gospaza-milestone-implementer`
- `medusa-first-architecture`
- `gospaza-security-review`

Before editing:

1. Read repository-level `AGENTS.md`.
2. Read this milestone file in full.
3. Inspect the pinned Medusa **2.18.0** implementation relevant to the current slice.
4. Preserve all verified M0–M9 behavior.
5. Do not infer or implement M11+ functionality.
6. Do not run command-heavy verification unless the user explicitly asks. Return exact commands for the user.
7. All PowerShell commands returned to the user must be single-line.

The active slice is the implementation contract. Do not broaden scope between slices.

---

# 2. M10 objective

An authenticated customer with:

```text
current GoSpaza cart
+ valid CartMarketplaceContext
+ complete owned M6 delivery address
+ valid M9 delivery selection/reservation
```

must be able to:

```text
validate checkout
→ attach the authoritative native Shipping Method
→ obtain authoritative Medusa totals
→ confirm a frozen server-derived checkout snapshot
→ create/reuse Medusa payment resources
→ initiate Yoco Hosted Checkout
→ reconcile verified payment events
→ safely complete the cart
→ create the Medusa Order
→ commit delivery capacity to that order
```

Browser redirects never prove payment success.

Medusa remains the commercial source of truth.

---

# 3. Approved provider strategy

Use **Recommendation C** from M10-A:

```text
fresh GoSpaza/Axe7bravo fork
from inspected upstream revision
with only required Medusa 2.18.0 / GoSpaza compatibility fixes
```

Reference snapshots inspected during M10-A:

```text
Upstream:
0513eda8db1adcf00bcf1806c436954ab9134f69

Historical Axe7bravo fork:
019c3663a2208490cacbd272d2e8f3f289251624
```

Both package manifests identified version `1.2.0`.

The historical fork is a **regression reference**, not the new base.

Do not use either inspected provider snapshot unchanged.

The maintained fork must be pinned to an exact revision when integrated into GoSpaza.

---

# 4. Provider defects / compatibility requirements

The maintained provider must correct all applicable issues identified in M10-A.

## 4.1 Money

Medusa 2.18.0 passes provider amounts in native major-unit semantics.

Yoco Checkout requires integer cents.

Therefore:

```text
Medusa native amount
→ exactly one precise major-unit-to-cents conversion
→ Yoco
```

Example:

```text
109.99 ZAR → 10999 cents
```

Requirements:

- reuse GoSpaza's established exact money conversion semantics;
- do not use JavaScript floating-point arithmetic as the source of truth;
- reject non-ZAR;
- do not multiply an already-minor-unit value a second time.

## 4.2 Session / identifier correlation

Preserve distinct identifiers.

Do not alias or conflate:

```text
cart id
checkout attempt id
Medusa payment session id
Medusa payment collection id
Yoco checkout id
Yoco payment id
provider operation id
```

Medusa injects its session ID into:

```text
data.session_id
```

not `context.session_id`.

The provider must preserve the Medusa session correlation in returned provider data.

`metadata` and `externalId` are correlation aids only. They are never authorization.

## 4.3 Initiation idempotency

A logical checkout attempt must have one durable, stable provider operation identity.

Requirements:

- persist the operation identity before or with initiation;
- reuse the same idempotency key for the same logical external operation;
- reuse the same immutable request payload with that key;
- never generate a random idempotency key per retry;
- never derive the identity from potentially empty/ambiguous request context;
- uncertain network outcomes must not cause a blind second payable checkout.

## 4.4 `updatePayment`

Do not allow `updatePayment` to create another payable Yoco checkout for a confirmed attempt.

A changed commercial amount requires a new explicit customer confirmation / new logical attempt, not silent provider mutation.

## 4.5 Authorization / capture mapping

For verified Yoco:

```text
payment.succeeded
```

the GoSpaza integration maps the payment as **CAPTURED**, not merely authorized.

The provider/integration must not manufacture capture success without authoritative Yoco evidence.

## 4.6 Payment status

Provider uncertainty is not the same as confirmed `pending`.

Distinguish:

```text
confirmed provider state
vs
unknown / uncertain external outcome
```

Do not collapse network/API errors into a misleading final state.

## 4.7 Refunds

M10 permits only **automatic full technical compensation** when captured payment cannot safely produce or retain its intended M10 order.

General customer/admin refund functionality remains M18.

Technical refund requirements:

- exact amount conversion;
- stable durable refund idempotency key;
- authoritative provider outcome;
- `pending` remains pending;
- final success must be reconciled before recording success;
- one logical full technical compensation per captured payment.

## 4.8 Redirect URLs

Use fixed, server-controlled, allowlisted application URLs.

Do not trust arbitrary browser-supplied redirect URLs.

Do not depend on undocumented placeholder substitution.

## 4.9 Webhook envelope and verification

Use the correct Yoco event envelope.

Do not treat the entire Medusa provider wrapper as the Yoco event.

Before any business effect:

```text
exact raw body
+ webhook id
+ timestamp
+ signature
→ verify using documented Yoco HMAC rules
```

Parsed-and-reserialized JSON is not equivalent to the signed raw payload.

## 4.10 Payment failure events

Recognize and reconcile supported failure events such as `payment.failed`.

Do not silently ignore provider failure events.

---

# 5. Native vs custom ownership

## Medusa owns

```text
Customer
Cart
Line Items
Product / Variant
Prices
Discounts / Promotions
Taxes
Shipping Option pricing
Shipping Method
Payment Collection
Payment Session
Payment
Capture
Refund
Commercial Order
Inventory reservation during native completion
```

Do not create parallel commerce tables for these concerns.

## Existing GoSpaza domains own

```text
CartMarketplaceContext
Merchant / MerchantStore authority
M6 address ownership / serviceability
M9 DeliveryOptionConfiguration
M9 DeliverySlot
M9 DeliveryReservation
```

## M10 GoSpaza extension owns

Only orchestration / recovery state such as:

```text
CheckoutAttempt
verified webhook inbox
provider operation identity/outcome
technical compensation coordination
M9 reservation payment-pending / committed lifecycle
```

These records coordinate native commerce resources. They are **not** a second payment ledger or second order system.

---

# 6. Approved checkout flow

After explicit Pay confirmation:

```text
authenticated customer
→ customer advisory lock
→ current non-superseded CartMarketplaceContext
→ current Medusa cart
→ validate owned complete M6 address
→ revalidate M6 serviceability
→ validate current M9 reservation
→ resolve authoritative native Shipping Option
→ attach native Shipping Method
→ refresh/read native Medusa totals
→ customer confirms server-issued checkout revision
→ freeze checkout snapshot
→ transition reservation to PAYMENT_PENDING
→ establish native payment resources
→ initiate/reuse Yoco checkout
→ return safe redirect/status data
→ verified provider reconciliation
→ guarded native cart completion
→ Medusa Order
→ reservation COMMITTED to order
```

A redirect, browser timeout, browser close, or return URL does not advance payment authority.

---

# 7. Shipping Method attachment

Resolve shipping authority through:

```text
current CartMarketplaceContext
→ current owned DeliveryReservation
→ DeliveryOptionConfiguration
→ authoritative native Shipping Option
```

Do not accept a browser-supplied native Shipping Option as independent authority.

Before attachment:

- require a complete authenticated-customer-owned M6 address;
- re-read ownership;
- revalidate serviceability;
- revalidate reservation/selection revision;
- revalidate configuration revision;
- revalidate native shipping pricing;
- reject stale/expired reservation state;
- update the native cart delivery address through supported Medusa flows.

Use Medusa's supported native Shipping Method workflow.

Attaching shipping may change cart totals. Therefore it occurs **before** the payment snapshot is frozen.

Read the resulting native commercial totals after attachment.

If the customer-payable amount changed, require explicit reconfirmation before payment initiation.

GoSpaza must not duplicate native shipping price calculation.

---

# 8. Frozen checkout attempt

A confirmed payment attempt freezes a server-derived commercial snapshot.

At minimum preserve safe references/snapshots for:

```text
customer
cart
merchant/store context
owned delivery address reference
reservation
delivery option/config revision
native shipping option/method references
native payment collection/session references where available
amount
currency
checkout revision
provider operation identity
payment-pending deadline
```

Later tariff/configuration changes do not rewrite an already-confirmed attempt.

They apply to later attempts.

Browser-supplied totals, shipping fees, merchant IDs, store IDs, zone IDs, Sales Channel IDs or payment amounts are never authority.

A live confirmed payment attempt must prevent cart mutations that would invalidate its frozen commercial snapshot.

This is a payment-in-progress restriction, not a general new serviceability gate.

---

# 9. M9 → M10 reservation lifecycle

Extend the M9 lifecycle conceptually:

```text
HELD
→ PAYMENT_PENDING
→ COMMITTED
```

Existing release/expiry states remain applicable where appropriate.

## HELD

Existing M9 behavior remains:

- bounded original expiry;
- effective capacity only while valid;
- no silent refresh extension.

## PAYMENT_PENDING

Transition only after:

- explicit Pay confirmation;
- fresh server validation;
- authoritative native totals;
- checkout attempt creation.

`PAYMENT_PENDING` has a separate configurable GoSpaza-owned payment deadline.

This does **not** silently extend the original M9 `HELD` expiry. It is a new explicit capacity commitment caused by the customer entering payment.

`PAYMENT_PENDING` consumes capacity independently of the original hold expiry.

## COMMITTED

A successful Medusa commercial Order commits delivery capacity to that Order.

Committed capacity remains authoritative even though the original cart is no longer the current shopping cart.

---

# 10. Payment deadline / late-success rule

If the GoSpaza payment deadline expires without accepted authoritative payment success:

```text
PAYMENT_PENDING
→ released capacity

CheckoutAttempt
→ locally expired / superseded
```

An expired/superseded attempt never regains order eligibility.

If a later valid Yoco success arrives for that expired/superseded attempt:

```text
verified late payment
→ DO NOT create an order
→ DO NOT reclaim capacity
→ create durable full technical compensation
→ REFUND_PENDING if necessary
→ reconcile to REFUNDED / final state
```

A delayed payment may not retroactively reclaim capacity already released or allocated elsewhere.

The payment-acceptance-vs-expiry decision must be serialized in PostgreSQL using fresh database time.

Browser cancellation is not provider cancellation.

Do not claim the Yoco hosted checkout became unpayable unless the provider supplies authoritative evidence.

---

# 11. Payment Collection / session lifecycle

Use Medusa-native payment resources.

Requirements:

- reuse a correctly linked collection where valid;
- create only when absent/required;
- refresh commercial totals before external payment initiation;
- never blindly recreate sessions to recover an uncertain Yoco checkout;
- preserve historical external correlation needed for late-payment compensation.

Important Medusa 2.18.0 finding:

```text
createPaymentSessionsWorkflow
```

can replace/delete existing sessions.

Therefore it is not a blind retry mechanism.

## Hard implementation gate

Before implementing replacement/retry checkout attempts:

```text
inspect and prove the Medusa 2.18.0 native payment-resource/link lifecycle
for retaining historical payment/session correlation
while establishing a later logical attempt
```

The implementation must retain enough evidence to:

- identify a late success from an old attempt;
- distinguish old attempt from current attempt;
- correlate its Yoco checkout/payment;
- technically refund that late success if required.

If the pinned Medusa lifecycle cannot safely support this with native links/resources plus a small orchestration record:

**STOP and report.**

Do not invent a parallel payment ledger.

---

# 12. Dedicated Yoco webhook ingress

Use:

```text
POST /hooks/gospaza/yoco
```

or the closest established repository convention.

Required sequence:

```text
receive exact raw bytes
→ verify signature/timestamp
→ validate event envelope
→ persist deduplicated verified receipt
→ acknowledge durable receipt
→ reconcile asynchronously / transactionally under appropriate locks
```

Do not allow business effects before successful verification.

The durable webhook inbox should track processing/recovery state without exposing raw sensitive contents through customer DTOs or routine logs.

Duplicate events must not produce duplicate effects.

---

# 13. Redirect / return behavior

Success/failure/cancel return URLs are UX only.

They may:

- display payment progress;
- request authoritative checkout-attempt status;
- show order if server reconciliation completed;
- show pending/uncertain/retry-safe states.

They may **not**:

- mark a payment successful;
- mark a payment captured;
- complete a cart based on query parameters;
- create an Order because the browser returned from Yoco.

No browser endpoint may exist that means:

```text
"mark paid"
```

or acts as an unrestricted native cart-completion proxy.

---

# 14. Cart / order completion

Use:

```text
completeCartWorkflow
```

Do not create Medusa Orders directly.

Before completion, establish:

- authenticated/current relationship is valid for the attempt;
- attempt is eligible for order creation;
- correct immutable merchant/store binding;
- accepted captured payment;
- paid amount/currency match the frozen authoritative snapshot;
- correct shipping/address references;
- payment-capacity commitment is still valid;
- no already-linked Medusa Order exists.

Unknown completion outcome:

```text
query authoritative native order/cart/payment relationships
before any replay
```

Do not blindly replay native completion because the HTTP/workflow response was lost.

Commit the DeliveryReservation to the resulting Medusa Order only after authoritative Order creation is established.

---

# 15. Technical compensation

M10 may automatically issue a **full technical refund** only when captured payment cannot safely produce or retain the intended commercial Order.

Examples include:

- verified late payment for an already expired/superseded attempt;
- captured payment where native completion irrecoverably fails and no intended order exists;
- other narrowly equivalent M10 recovery cases established by the implementation.

M10 must not introduce:

- customer-initiated refund UX;
- partial refund product flows;
- discretionary admin refund tools;
- store-credit refund choice;
- refund policy management.

Those remain M18.

Technical compensation must be:

```text
durable
idempotent
full-value
provider-authoritative
recoverable after uncertain outcomes
```

A pending refund remains pending.

Do not represent a refund as complete before authoritative provider/native confirmation.

---

# 16. Concurrency and idempotency

Retain the existing customer-scoped PostgreSQL advisory lock as the outer customer/cart boundary.

Preserve M9 deterministic slot locking for capacity changes.

Use database constraints/locks where applicable.

Required race coverage includes:

```text
double-click Pay
two simultaneous checkout starts
cart mutation vs payment start
reservation expiry vs Pay
config/tariff change vs Pay
same attempt initiation retry
unknown provider initiation outcome
webhook before initiation response
redirect before webhook
webhook before redirect
duplicate webhook
delayed webhook
payment deadline vs payment success
late success after released capacity
duplicate cart completion
lost completion response
technical refund retry
late success from an old attempt while a newer attempt exists
```

At minimum enforce logically:

- one active checkout attempt per current cart;
- unique provider operation identity;
- unique verified webhook event identity;
- unique external payment correlation;
- one logical full technical compensation per captured payment;
- no duplicate Order business effect for one attempt.

No process-local lock, browser flag or in-memory map may be required for correctness.

Use fresh database time after waiting for relevant locks.

---

# 17. Native route bypass protection

Preserve existing M8/M9 native cart/shipping restrictions.

M10 must inspect and protect all relevant native Store routes related to:

```text
payment collections
payment sessions
shipping method mutation
cart completion
Yoco/native payment hooks
```

Customers must not bypass GoSpaza:

- single-store authority;
- serviceability;
- scheduling;
- reservation lifecycle;
- shipping authority;
- frozen checkout snapshot;
- Yoco initiation;
- payment reconciliation;
- completion rules.

The native Yoco webhook/automatic-completion path must not become an alternate unverified route around GoSpaza reconciliation.

Apply protection at backend route boundaries, including the configured provider identifier.

Absent UI controls are not security.

---

# 18. Security / hostile-input requirements

Use:

```text
SOURCE
→ TRANSFORMATION
→ TRUST BOUNDARY
→ SINK
```

for security-sensitive data flows.

Explicitly test hostile use of:

```text
another customer's cart
superseded cart
foreign address
foreign reservation
foreign delivery option
foreign Shipping Option
foreign Payment Collection
foreign Payment Session
foreign CheckoutAttempt
foreign Yoco checkout/payment id
forged merchant id
forged store id
forged ServiceZone id
forged Sales Channel id
forged delivery fee
forged total
forged currency
stale reservation revision
stale checkout revision
stale configuration revision
expired attempt
replayed webhook
tampered webhook
known provider IDs
native completion/payment route bypass
```

A valid known ID is never authorization.

Frontend state is never authorization.

Do not expose provider secrets, webhook secrets, payment internals, raw webhook bodies, auth internals or cross-customer identifiers through DTOs/logs.

---

# 19. Proposed API families

Exact naming may follow established repository conventions.

Expected customer-facing concepts:

```text
GET  /store/gospaza/checkout
POST /store/gospaza/checkout/prepare
POST /store/gospaza/checkout/pay
GET  /store/gospaza/checkout/attempts/:id
```

Optional explicit abandon/supersede operation may be added only if it follows the approved safe backend rules and does not claim to cancel Yoco externally.

Provider ingress:

```text
POST /hooks/gospaza/yoco
```

Do not add:

```text
mark-paid endpoint
generic complete-cart proxy
generic payment-status mutation
browser-authorized refund endpoint
```

---

# 20. Likely schema / migrations

Minimum likely additions:

## CheckoutAttempt

Conceptual fields may include:

```text
id
cart_context_id
cart_id
customer_id or authoritative reference if required
reservation_id
state
checkout_revision
native_amount_snapshot
currency
address reference/snapshot required for recovery
shipping/config revision references
payment_collection_id
payment_session_id
provider_operation_id
provider_checkout_id
provider_payment_id
payment_deadline_at
order_id nullable
created_at
updated_at
```

Use exact fields only after inspecting existing repository patterns.

Do not duplicate native payment state.

## ProviderOperation / recovery identity

Persist durable operation identity/outcome where required for:

- uncertain checkout initiation;
- technical refund.

Do not make transient Medusa refund IDs the sole identity of a logical external compensation operation.

## Webhook inbox

Conceptually track:

```text
provider
provider_event_id UNIQUE
event_type
verification state
processing state
correlation refs
received_at
processed_at
safe error/recovery metadata
```

Store only what is required for secure recovery.

## DeliveryReservation extension

Add the minimum fields/states required for:

```text
PAYMENT_PENDING
COMMITTED
payment deadline
Medusa Order reference
```

Update occupancy/uniqueness constraints so payment-pending and committed capacity are enforced correctly.

Do not modify Medusa-owned tables directly.

---

# 21. M10 slices

Execute in this order.

## M10-A — Architecture / reconnaissance

**Complete and approved.**

No implementation.

Approved outputs are captured in this file.

---

## M10-B — Yoco Provider Compatibility

Objective:

Create/prepare the maintained provider fork and prove its Medusa 2.18.0 contract before GoSpaza checkout depends on it.

Required:

- start from inspected upstream baseline;
- port only required fixes;
- exact major-unit → cents conversion;
- explicit ZAR validation;
- correct `data.session_id` handling;
- distinct identifier storage;
- stable logical initiation idempotency;
- safe uncertain-initiation behavior;
- prevent silent second checkout from `updatePayment`;
- authoritative status behavior;
- `payment.succeeded → CAPTURED`;
- safe `payment.failed`;
- exact refund conversion;
- stable technical-refund idempotency;
- correct final refund state handling;
- server-controlled redirects;
- focused provider contract tests.

Do not yet implement GoSpaza checkout UI.

Do not begin M10-C until M10-B is verified.

---

## M10-C — Checkout Foundation

Objective:

Establish authoritative server checkout preparation before external payment.

Required:

- complete owned address requirement;
- M6 serviceability revalidation;
- current cart/context authority;
- current M9 reservation validation;
- native Shipping Method attachment;
- native total refresh/read;
- checkout revision;
- frozen CheckoutAttempt snapshot;
- one active attempt per cart;
- cart mutation freeze rules;
- authority/security APIs;
- native payment route/bypass foundation as required.

Do not initiate Yoco unless the slice boundary explicitly requires only minimal proof wiring.

Do not begin M10-D until M10-C is verified.

---

## M10-D — Payment Initiation & Capacity Commitment

Objective:

Safely transition from a confirmed checkout snapshot into one durable payable operation.

Required:

- `HELD → PAYMENT_PENDING`;
- configurable payment deadline;
- database-time expiry decisions;
- native Payment Collection/session establishment;
- durable provider operation identity;
- Yoco checkout initiation;
- uncertain-initiation recovery;
- no duplicate payable checkout after retry;
- safe redirect response;
- historical correlation preservation;
- payment-resource lifecycle gate resolved before replacement attempts.

Do not complete Orders here unless absolutely required by pinned provider mechanics and approved before broadening.

Do not begin M10-E until M10-D is verified.

---

## M10-E — Verified Reconciliation & Native Completion

Objective:

Turn authoritative Yoco events into exactly-once native commercial outcomes.

Required:

- dedicated raw-body webhook ingress;
- signature/timestamp verification;
- verified webhook inbox;
- deduplication;
- captured-payment reconciliation;
- failure reconciliation;
- payment deadline vs success serialization;
- guarded native cart completion;
- unknown completion recovery;
- Medusa Order resolution;
- `PAYMENT_PENDING → COMMITTED`;
- late-success compensation;
- technical full refund recovery;
- prevent native webhook/automatic-completion bypass;
- prevent native compensation from silently creating a new payable Yoco checkout.

Do not implement M11 operational order handling.

Do not begin M10-F until M10-E is verified.

---

## M10-F — Customer Checkout Experience

Objective:

Expose the verified M10 backend safely to the customer.

Required UX:

```text
checkout readiness
owned address selection/confirmation
authoritative delivery/shipping summary
native totals
changed-total reconfirmation
Pay action
Yoco redirect
return/status page
pending payment state
successful order state
payment failure state
local payment-expiry state
late-payment compensation status where customer-safe
retry/new-attempt path where allowed
```

The UI must never:

- calculate authoritative totals;
- calculate shipping fees;
- mark payment successful;
- mark payment captured;
- complete the cart based on redirect;
- silently renew capacity;
- create a second payable checkout automatically.

Do not begin M10-G until M10-F is verified.

---

## M10-G — Acceptance / Security

Final M10 acceptance must prove all hard invariants using real database/API/browser/provider-contract coverage where appropriate.

Minimum coverage:

- authenticated current-cart checkout;
- foreign/superseded cart rejection;
- foreign-address rejection;
- stale reservation rejection;
- shipping authority;
- native totals authoritative;
- changed-total reconfirmation;
- one active attempt per cart;
- double Pay;
- cart mutation freeze;
- stable initiation idempotency;
- uncertain checkout initiation recovery;
- webhook signature rejection;
- duplicate webhook;
- replayed event;
- forged event/correlation;
- amount mismatch;
- currency mismatch;
- webhook-before-initiation-response;
- redirect-before-webhook;
- webhook-before-redirect;
- payment-success-vs-deadline race;
- late success after released capacity;
- late success technical refund;
- duplicate completion;
- lost completion response;
- exactly one Order business effect;
- committed capacity after Order;
- native payment/session/completion bypass blocked;
- no browser payment authority;
- no M11 functionality introduced.

---

# 22. M10 hard invariants

These must never be violated.

1. **Medusa remains the commercial source of truth.**
2. **One cart/order remains bound to one merchant/store.**
3. **Checkout authority comes from authenticated customer + current CartMarketplaceContext.**
4. **Browser IDs are hints/choices, never independent authorization.**
5. **Browser totals, shipping fees and currency are never payment authority.**
6. **A complete owned M6 delivery address is required before Pay.**
7. **M9 serviceability and reservation authority must be revalidated before Pay.**
8. **Native Shipping Method is attached from the server-resolved M9 option.**
9. **Shipping attachment/native recalculation occurs before the payment snapshot is frozen.**
10. **A changed payable total requires explicit reconfirmation.**
11. **Each logical payable attempt has one stable external operation identity.**
12. **An uncertain external result never causes a blind second payable checkout.**
13. **Exactly one major-unit → cents conversion occurs at the Yoco boundary.**
14. **GoSpaza accepts only ZAR for the Yoco MVP.**
15. **Yoco redirects never prove payment success.**
16. **Only verified/correlated provider evidence may advance payment authority.**
17. **`payment.succeeded` is reconciled as captured payment.**
18. **`PAYMENT_PENDING` is an explicit new capacity commitment, not a silent M9 expiry extension.**
19. **Payment acceptance versus deadline expiry is database-serialized.**
20. **Expired/superseded attempts can never regain order eligibility.**
21. **Late success for an expired/superseded attempt never creates an Order.**
22. **Late captured payment is technically compensated idempotently.**
23. **A pending refund is never represented as completed.**
24. **Native Order creation uses Medusa cart completion, not direct custom Order insertion.**
25. **Unknown completion outcome is reconciled before retry.**
26. **One checkout attempt can create at most one commercial Order business effect.**
27. **Committed delivery capacity survives the shopping cart ceasing to be current.**
28. **Native payment/session/completion routes cannot bypass GoSpaza checkout rules.**
29. **Webhook authentication happens before business effects.**
30. **Duplicate/replayed webhook events cannot duplicate payment/order/refund effects.**
31. **Historical payment correlation required for late-success recovery must not be destroyed by replacement attempts.**
32. **M10 does not implement merchant acceptance, picking, dispatch, delivery, settlements or general refund product functionality.**

---

# 23. Explicitly out of scope

Do NOT implement in M10:

```text
merchant accept/reject
OrderOperation acceptance state machine
picking
substitutions
driver onboarding
driver assignment
dispatch
live driver tracking
delivery execution
delivery OTP
alcohol doorstep verification
customer/admin general refund UX
partial refunds
store-credit refund choice
merchant ledger
commission ledger
settlements
manual merchant payout
driver earnings
broad notifications/realtime
M11+ operational order workflows
```

Automatic full technical payment compensation required to recover an M10 captured-payment failure is the only refund exception.

---

# 24. Verification model

For every slice:

```text
implementation
→ user verification
→ targeted correction only if needed
→ verified slice
→ next slice
```

Never claim a command passed without user-provided output.

When a verification command fails:

- diagnose the smallest observed failure;
- do not restart the entire milestone;
- do not weaken assertions;
- do not hide failures with sleeps or larger timeouts;
- do not clear Redis/database state to conceal an idempotency defect;
- fix only the demonstrated problem and add regression coverage where warranted.

Playwright suite-level timing failures should be isolated before modifying production behavior.

---

# 25. Expected test strategy

Use the smallest appropriate layer.

## Provider contract tests

Cover:

- amount conversion;
- ZAR rejection;
- session correlation;
- idempotency identity;
- uncertain initiation;
- update behavior;
- captured mapping;
- failed-event behavior;
- technical refund amount/idempotency/final status.

## Unit tests

Use for pure:

- revisions;
- state transitions;
- validation;
- request fingerprinting;
- money conversion;
- deadline policy.

## Real database / API integration

Use for:

- ownership;
- tenant/cart isolation;
- checkout-attempt uniqueness;
- M9/M10 state transitions;
- concurrency;
- webhook deduplication;
- payment-success/deadline races;
- completion idempotency;
- late-payment compensation identity;
- native bypass.

## Browser E2E

Use for critical customer journeys only:

- prepare checkout;
- changed quote/reconfirmation;
- redirect/status restoration;
- successful completion;
- pending state;
- failure state;
- local expiry;
- safe retry/new attempt.

Critical financial/concurrency rules must not rely only on mocked browser tests.

---

# 26. M25 residual / production-hardening concerns

Do not prematurely optimize these during M10 unless they expose a correctness defect:

```text
cross-store/global lock contention
load/connection pool behavior
authenticated request-volume controls
provider transport/commit uncertainty under infrastructure faults
historical checkout/refund cleanup retention
long-lived webhook inbox archival
mobile/background timer throttling
clock skew observability
provider outage operational tooling
```

Record new production-hardening findings for M25.

---

# 27. Completion report for each implementation slice

When a slice is implemented, stop and report:

```text
MILESTONE M10-<slice> COMPLETE

1. Implemented
2. Medusa ownership decisions
3. Yoco/provider decisions
4. Schema / migrations
5. API routes / workflows
6. Reservation / checkout state behavior
7. Authorization / security
8. Idempotency / concurrency
9. Tests added
10. Verification status
11. Commands for user to run
12. Explicitly NOT implemented
13. Known limitations / later-slice dependencies
14. Files/modules materially changed
```

Do not begin the next M10 slice automatically.

---

# 28. M10 final completion criteria

M10 is complete only when M10-B through M10-G are verified and all hard invariants are proven.

Final M10 acceptance must establish:

```text
authoritative native checkout
+ correct Shipping Method
+ correct Yoco amount
+ durable initiation
+ authenticated webhook processing
+ captured reconciliation
+ exactly-once Order creation
+ delivery-capacity commitment
+ late-payment safety
+ technical compensation safety
+ native-route bypass protection
+ customer checkout UX
```

Then and only then may M11 begin.
