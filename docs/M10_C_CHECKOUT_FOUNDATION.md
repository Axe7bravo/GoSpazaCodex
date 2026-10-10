# M10-C — Checkout Foundation

Implementation complete; user verification is pending. No verification commands were executed by Codex.

## Scope and ownership

Medusa 2.18.0 still owns the cart, line items, prices, discounts, taxes, Shipping Method and commercial totals.
Marketplace owns only an immutable `CheckoutAttempt` orchestration snapshot. Its native cart reference is
constrained to the existing `CartMarketplaceContext`, which already has the read-only native Cart link.
No parallel payment, shipping-price, inventory or order model was added.

The verified M10-B provider, reference snapshots, dependency versions and provider configuration are unchanged.
Yoco is **not registered, activated or called** by this slice.

## Pinned implementation findings

Inspected the installed 2.18.0 implementations of:

- `updateCartWorkflow`: supported native delivery-address update and native refresh.
- `addShippingMethodToCartWorkflow`: obtains native eligible/priced Shipping Options, validates them,
  replaces the applicable method, and refreshes the cart.
- `listShippingOptionsForCartWithPricingWorkflow`: native Sales Channel → Stock Location → Fulfillment Set
  applicability, native address filtering, native price calculation and provider validation.
- `refreshCartItemsWorkflow`: force-refreshes native item prices, shipping, tax lines and promotions.
  Its result is not a final post-workflow total read; checkout explicitly retrieves the native cart afterward.
- Cart Module `shouldIncludeTotals` / `addRelationsToCalculateTotals`: totals must be selected;
  this hydrates item/shipping tax lines, adjustments and credit lines.
- `refreshPaymentCollectionForCartWorkflow`: can delete sessions when collection amounts change.
  M10-C therefore refuses preparation/abandonment when any native Payment Collection is linked.
  It does not create collections or sessions.
- Native `/store/payment-collections`, nested payment-session routes, cart completion/shipping routes,
  and `/hooks/payment/:provider`.

The historical payment-resource retention gate remains for M10-D. This slice does not establish, replace,
retry or delete payment resources.

## API contract

All endpoints require the existing authenticated **customer** actor and return private/no-store responses.

| Endpoint | Input / behavior |
| --- | --- |
| GET `/store/gospaza/checkout?cart_id=...` | Owned current cart hint; returns its active confirmation or null. |
| POST `/store/gospaza/checkout/prepare` | `cart_id`, `address_id`, `expected_reservation_revision`; returns a fresh server quote. Does not confirm it. |
| POST `/store/gospaza/checkout/confirm` | Preparation fields plus `confirmed: true` and `checkout_revision`; refreshes again and freezes only the matching quote. |
| GET `/store/gospaza/checkout/attempts/:id?cart_id=...` | Attempt must belong to this authenticated customer's current context. |
| POST `/store/gospaza/checkout/abandon` | `cart_id`, `attempt_id`, `checkout_revision`, `confirmed: true`; closes this pre-payment confirmation idempotently. No external cancellation claim. |

All schemas are strict. Customer/merchant/store/zone/channel/context/option/payment identifiers, amounts,
fees and currency are not accepted as authority. A reservation is resolved from the current context,
not selected by a caller-supplied reservation ID.

There is deliberately no `/pay`, complete-cart proxy, webhook ingress, UI or provider operation in C.

## Preparation and confirmation

1. Acquire M8's customer-scoped PostgreSQL advisory lock and resolve the authenticated customer's current,
   non-superseded native cart and immutable marketplace context.
2. Reject empty/invalid carts. Read the active checkout, expiring a previous pre-payment confirmation only
   if its original M9 hold has ended or its original deadline passed.
3. Acquire the existing M6 customer-address lock and read the native address by both address ID and customer ID.
   Completeness uses the M6 schema (names, street, city, province, postal code and ZA country; existing optional
   address-line-two/phone behavior is retained).
4. Enter M9's existing configuration/store/slot lock order through its service contract. Reuse M9's
   serviceability, assignment, configuration revision and native pricing validation.
5. Require the current owned HELD reservation and exact selection revision, an enabled unexpired slot, and
   the selected address. A coordinate-based hold can use an owned address at those same resolved coordinates;
   a different destination requires a new M9 selection.
6. Update the native delivery address and attach the **server-resolved** Shipping Option using native workflows.
   An already-correct method is reused. Force native price/tax/promotion/shipping refresh, then read native totals.
7. Convert amounts using the existing exact `minorPrice` boundary. Missing/invalid monetary fields fail;
   they are never interpreted as zero.
8. Recheck fresh database time after native work. Preparation returns a quote/revision without freezing.
9. Confirmation recomputes the quote. Any snapshot change returns `409 CHECKOUT_RECONFIRM` with the new quote
   and no attempt. A matching explicit confirmation inserts one immutable attempt in the locked transaction.

The revision covers server-derived native totals, line quantities/prices/totals, delivery address,
reservation/configuration and native Shipping Option/Method references. It is a comparison token, not authentication.

## Confirmation lifecycle and freeze

C is pre-payment only:

`CONFIRMED → ABANDONED | EXPIRED`

Its expiry is exactly the existing M9 HELD expiry, not a new payment deadline. No capacity is extended.
M9 release/replacement remains available; ending the associated hold makes this C confirmation ineffective.
Reads and subsequent cart operations close that old attempt without rewriting its snapshot.

An effective confirmed snapshot blocks add, quantity update, removal and store switch before native cart mutation.
The error is `409 CHECKOUT_FROZEN`, not uncertain mutation. Explicit pre-payment abandonment permits editing again.
Ordinary M8 decrease/removal without location remains unchanged outside this bounded confirmation freeze.

M10-D must extend the lifecycle for explicit Pay, PAYMENT_PENDING and its separate deadline, after proving native
payment-resource retention. C's unpaid-cart guard and original-hold lifetime must not be casually removed.

## Concurrency and recovery

- Customer advisory lock is the outer boundary for prepare/confirm/read/abandon and existing cart mutations.
- Existing M6 address lock and M9 configuration/store/slot locks protect the checkout inputs.
- Database partial unique indexes independently enforce one active attempt per native cart and context.
- Composite foreign keys prevent mismatched cart/context and reservation/context relationships.
- A database trigger prevents snapshot/revision/binding/deadline rewriting and reopening closed attempts.
- Duplicate matching confirmations converge on the same attempt; they do not reprice a frozen snapshot.
- Confirmation racing with quantity mutation yields either a confirmed snapshot plus blocked mutation,
  or a changed native cart plus reconfirmation requirement.
- Native workflows retain their compensation. A later custom snapshot-publication failure cannot pretend those
  separate native writes rolled back. The API returns refresh-required, and explicit preparation reads/reconciles
  the native Shipping Method before attaching anything again. No non-idempotent workflow is blindly replayed.
- No payment can have been initiated by this slice, including in failure/recovery tests.

## Static security review

No confirmed critical/high vulnerability was identified in the implemented C paths during static inspection.
This is not a claim of runtime verification.

| Source → transformation → trust boundary → sink | Enforcement |
| --- | --- |
| Browser cart hint → M8 current-cart lookup → authenticated native customer ownership → native cart workflows | Foreign, superseded, completed and unbound carts cannot authorize checkout. |
| Browser address choice → native customer-address lookup → owned M6 complete address and coordinates → native shipping address | Ownership and completeness precede native mutation; geography remains M6 authority. |
| Browser reservation revision → M9 current hold/config resolution → serviceability, configuration and slot locks → server Shipping Option | Caller cannot inject reservation, option, store, zone or fee authority. |
| Browser confirmation revision → full native refresh and fingerprint comparison → customer lock plus DB uniqueness → immutable attempt | A known revision alone cannot access another customer's cart or attempt. |
| Browser native payment/cart routes or provider hook → backend middleware → disabled alternate entry → no native mutation/reconciliation | Cart/shipping restrictions remain; payment collections/sessions and all native payment hooks return 404. |
| Persisted snapshot → explicit customer-safe projection → current-cart/attempt ownership → customer DTO | No provider data, internal binding/option IDs, storage keys or full address snapshot exposed. |

The read-only native payment-provider catalogue does not initiate payment; mutation and hook families are blocked.
No new outbound URL is accepted. SQL values are bound; the integration fault trigger uses only locally generated,
validated identifiers. No secrets, cookies or address snapshots are logged by the new handlers.

## Acceptance coverage

New real database/API suite: `apps/backend/src/scripts/verify-checkout-foundation.ts`.
It reuses the existing isolated M8 fixture and the M9 provisioning services. It does not mock Medusa/database behavior.

| Invariant | Coverage |
| --- | --- |
| Authenticated current cart | Anonymous, foreign cart and superseded-cart HTTP rejection |
| Complete owned M6 address | Real foreign address; real incomplete native address; changed M6 coordinates outside service |
| Reservation/config authority | Stale selection revision, expired hold, tariff invalidation, strict forged-field requests |
| Native shipping/totals | Native method/option references and native total comparison; repeated preparation has one method |
| Changed quote | Native cart quantity change forces 409 with updated quote and no frozen attempt |
| One active attempt | Concurrent HTTP confirmations converge; direct duplicate insert fails |
| Immutable snapshot | Database snapshot update rejected; later tariff change leaves history untouched |
| Ownership/data minimization | Foreign attempt read/abandon fails; strict customer response schemas |
| Cart freeze | Actual add/update/remove/switch requests rejected while confirmed |
| Mutation race | Concurrent HTTP confirm and quantity update; final native quantity and attempt count checked |
| Store-switch race | Concurrent HTTP confirm and switch; old context supersession and active attempt count checked |
| Expiry/abandonment | Original expiry retained, ended hold closes attempt, explicit abandonment is replay-safe |
| Recovery | Targeted database insert fault after native shipping; no false frozen state, explicit recovery converges |
| Native bypass | Anonymous/owner payment collection/session, completion, shipping and native provider-hook requests rejected |
| No external payment | Native payment collection absence asserted after preparation and recovery |

Unit tests in `apps/backend/tests/checkout-foundation.test.ts` cover revisions, strict input, M6 completeness and exact
native money representations. `cart-errors.test.ts` protects the new intentional freeze conflict classification.

M8 foundation runs inside the new fixture. Existing cart-mutation and M9 reservation suites remain regression checks.
No browser tests were added: no checkout UI belongs to this slice.

## Commands for user to run

All commands run from `D:\Programming_projects\GoSpazaCodex`. Every failure stops the sequence.
No installs or provider credentials are required for C.

1. `pnpm run lint` — expect no errors/warnings.
2. `pnpm run typecheck` — expect all workspace projects to pass.
3. `pnpm --filter @gospaza/backend run test` — expect backend unit/provider tests to pass.
4. `pnpm --filter @gospaza/backend run build` — expect successful backend production build.
5. `pnpm run db:migrate` — apply the checkout migration; expect all migrations and link synchronization to finish.
6. Start/restart the development backend in a separate terminal with `pnpm --filter @gospaza/backend run dev`.
   Use the existing local PostgreSQL/Redis and verified ZA/ZAR setup. Wait for the backend-ready message.
7. `pnpm --filter @gospaza/backend run test:checkout-foundation` — expect the M10-C pass message and successful fixture cleanup.
8. `pnpm --filter @gospaza/backend run test:cart-mutations` — expect existing M8 assertions to pass.
9. `pnpm --filter @gospaza/backend run test:delivery-reservations` — expect existing M9 capacity/security assertions to pass.

## Limitations and later slices

- Runtime verification remains pending.
- C confirmation is pre-payment and cannot extend HELD capacity. No PAYMENT_PENDING, deadline configuration or COMMITTED lifecycle.
- No native payment collection/session creation, Yoco registration/initiation, provider operation, webhook inbox,
  reconciliation, cart completion, order, technical refund or customer checkout UI.
- Payment-resource history and safe replacement/retry gate remain M10-D prerequisites.
- The existing cross-store configuration lock is retained. Native refresh now runs while that lock is held;
  throughput/connection-pool observability and authenticated request-volume limits remain M25 hardening concerns.
- No M10-D or later milestone implementation was started.
