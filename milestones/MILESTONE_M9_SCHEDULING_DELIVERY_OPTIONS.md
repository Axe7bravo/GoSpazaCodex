# MILESTONE M9 — Scheduling & Delivery Options

**Status:** M9-A through M9-D complete and user-verified. M9-E acceptance/security review implemented; latest acceptance verification pending.

## Goal

Add delivery-option discovery, operational scheduling, concrete delivery-slot capacity, reservation holds, restoration, and customer scheduling UX while preserving Medusa as the commercial shipping authority.

M9 must stop before checkout/payment/order completion.

## Locked ownership boundaries

### Medusa v2.18.0 owns

- Fulfillment Sets
- native Service Zones
- Shipping Profiles
- Shipping Options
- fulfillment providers
- Shipping Option pricing
- Shipping Methods attached to carts
- commercial shipping amounts/totals
- native cart/product/inventory/customer concerns

### GoSpaza owns

- polygon-based geographic serviceability
- MerchantStore ↔ ServiceZone assignment
- deterministic overlapping-zone resolution
- store delivery policy
- operational delivery modes (`ASAP`, `SCHEDULED`)
- concrete delivery windows
- slot capacity
- reservation/hold lifecycle
- reservation expiry
- scheduling restoration/staleness
- scheduling authority/security

`CartMarketplaceContext` remains authoritative for the authenticated customer's current cart and its Merchant + MerchantStore binding.

Do not create competing ownership for customer, merchant, store, cart, price, shipping, or fulfillment state.

## Existing architecture that M9 must preserve

- One customer cart = one Merchant + MerchantStore.
- No mixed-merchant cart.
- Current cart/store authority comes from the authenticated customer and `CartMarketplaceContext`.
- GoSpaza `ServiceZone` polygons remain authoritative for geographic eligibility.
- M8 customer-scoped PostgreSQL advisory locking remains the outer boundary for customer/cart-sensitive scheduling mutations.
- Browser-supplied IDs are selections/hints only and never authorization.
- Quantity decrease and removal remain allowed even when location/scheduling eligibility is unavailable.
- Superseded carts never regain authority.
- Native Medusa cart mutation routes remain blocked as bypass paths.

# M9-A — Architecture decisions

## Native shipping compatibility

M6 native Medusa Service Zones were created with empty geo zones. M9 uses supported Medusa APIs/workflows to configure a broad South Africa (`za`) native compatibility envelope.

This native country compatibility is **not** geographic authorization. GoSpaza polygon serviceability remains authoritative.

## Shipping Profiles

Existing catalogue products must have a valid native Shipping Profile association where required.

Provisioning/backfill must:

- reuse the unique native default profile when valid;
- create it only when required;
- backfill missing associations only for the relevant marketplace products;
- reject ambiguous/incompatible profile state;
- remain idempotent.

## Delivery option authority

Use a deliberate combination:

- native Shipping Options = commercial shipping choices;
- GoSpaza `DeliveryOptionConfiguration` = operational mapping (`ASAP` / `SCHEDULED`);
- GoSpaza reservation = selected operational delivery window.

Create native options per eligible store-zone assignment and mode, **not per slot**.

## Shipping Method timing

M9 does **not** attach a native Shipping Method to the cart.

M9:

- validates options;
- validates native price;
- quotes delivery;
- reserves operational capacity.

M10 will revalidate current address, option, quote, reservation, and commercial state before attaching the native Shipping Method and entering payment.

## Delivery fee

`ServiceZone.delivery_fee_minor` in `zar` remains the configured tariff.

The tariff is projected into native flat Shipping Option pricing through supported Medusa workflows.

The browser never supplies an authoritative amount.

GoSpaza does not implement a separate shipping tax or price engine.

## Overlapping ServiceZones

Priority belongs to the **MerchantStore ↔ ServiceZone assignment**, not globally to the zone.

Resolution:

1. resolve eligible store-zone assignments;
2. highest priority wins;
3. equal highest-priority assignments with equivalent configuration may resolve deterministically;
4. equal highest-priority assignments with conflicting delivery configuration or fee fail closed as ambiguous.

Never choose by array order, first match, or cheapest fee.

## Slot model

Use persisted concrete slots within a bounded horizon.

Each `DeliverySlot` has:

- MerchantStore
- UTC `start_at`
- UTC `end_at`
- `booking_cutoff_at`
- positive integer `capacity`
- enabled state
- revision

Store timezone is an explicit valid IANA timezone.

Initial default: `Africa/Johannesburg`.

Browser-local timezone is never authoritative.

## Capacity model

One reservation consumes one store capacity unit.

Capacity is shared across zones and operational modes for the same concrete slot.

Separate zone configuration must not multiply real operational capacity.

## ASAP semantics

`ASAP` means the earliest currently eligible capacity window.

It is an estimated operational window only.

It is **not**:

- driver assignment;
- dispatch;
- live ETA;
- delivery execution.

## Policy defaults

Defaults are configurable, not hard-coded product rules:

- timezone: `Africa/Johannesburg`
- booking horizon: 7 days
- minimum lead time: 60 minutes
- hold duration: 15 minutes

Concrete slot cutoff remains authoritative for that slot.

## Reservation lifecycle

M9 lifecycle:

```text
HELD → RELEASED
HELD → EXPIRED
```

Only one effective `HELD` reservation may exist per current `CartMarketplaceContext`.

M9 does not introduce payment/order commitment states.

M10 owns conversion from a temporary hold into checkout/order capacity commitment.

## Location basis

Reuse M6 address/location infrastructure.

Scheduling may persist/reference only the minimum server-held basis required for restoration/revalidation, including:

- owned address/location reference where available;
- resolved MerchantStoreServiceZone assignment;
- scheduling/configuration revision;
- validated location snapshot only where required.

Coordinates used for scheduling are not automatically the checkout delivery address.

Browser state is never permanent authority.

## Administration

Scheduling configuration is platform-admin-only for M9.

Do not add merchant scheduling permissions or merchant scheduling UI in M9.

# M9-B — Scheduling Foundations — VERIFIED

## Implemented models

Added to the Marketplace module:

### `StoreDeliveryPolicy`

Owns store-level scheduling policy, including:

- MerchantStore
- timezone
- enabled modes
- lead time
- booking horizon
- hold duration
- enabled/revision state

### `DeliveryOptionConfiguration`

Maps:

```text
MerchantStoreServiceZone assignment
+ operational mode (`ASAP` | `SCHEDULED`)
→ native Medusa Shipping Option
```

Tracks synchronization/revision state.

### `DeliverySlot`

Concrete bounded capacity window with:

- MerchantStore
- UTC start/end
- booking cutoff
- positive capacity
- enabled state
- revision

### `DeliveryReservation`

Schema foundation only in M9-B.

Linked to `CartMarketplaceContext`.

Lifecycle values:

```text
HELD
RELEASED
EXPIRED
```

Runtime acquisition/replacement/release/expiry behavior belongs to M9-C.

### Scheduling audit events

Added for explicit scheduling/configuration administrative actions.

## M9-B migration / constraints

Migration:

`Migration20260930100000.ts`

Foundation constraints cover:

- MerchantStore consistency;
- positive capacity;
- timestamp ordering;
- unique native option mappings;
- integer quote values;
- one `HELD` reservation per cart context;
- scheduling lookup indexes;
- expiry lookup indexes;
- synchronization/revision state.

Native Medusa tables are not mutated directly by GoSpaza migrations.

## Native geo-zone synchronization

Implemented supported synchronization so existing empty native geo zones can be upgraded to South Africa (`za`) native compatibility.

Rules:

- GoSpaza polygon serviceability remains authoritative;
- incompatible native geo configuration fails visibly;
- synchronization is explicit and recoverable;
- rerunning against correct topology converges safely.

## Shipping Profile provisioning/backfill

Implemented:

- reuse of the unique native default profile;
- provisioning where required;
- missing-profile backfill for the store's marketplace products;
- new catalogue products receive the profile;
- ambiguous multiple-default state fails;
- incompatible existing product associations fail rather than being silently overwritten.

## Manual fulfillment provider

M9-B provisioning ensures the first-party manual fulfillment provider is correctly enabled for the relevant native service location through supported Medusa APIs/module relationships.

Manual Admin-dashboard configuration must not be required.

Provisioning is idempotent and must not create duplicate providers or topology.

## Delivery policy foundation

Implemented configurable defaults:

```text
timezone: Africa/Johannesburg
booking horizon: 7 days
minimum lead time: 60 minutes
hold duration: 15 minutes
```

Store and assignment delivery modes require explicit enablement.

## Overlapping-zone resolution

Implemented assignment-level priority.

Rules:

- highest priority eligible assignment wins;
- conflicting equal-priority assignments fail closed;
- equivalent ties resolve deterministically.

## Native Shipping Option provisioning

Implemented one native Shipping Option per:

```text
store-zone assignment + delivery mode
```

Uses stable identities to support interrupted-operation recovery.

Uses the first-party manual provider.

No extra dependency was introduced.

## Fee projection and synchronization

Zone tariff is projected into native flat Shipping Option pricing using GoSpaza's existing native-money conversion boundary.

Synchronization states:

```text
PENDING
SYNCING
READY
FAILED
```

Rules:

- configuration changes invalidate the existing projection;
- native pricing is updated before matching configuration revision is published;
- selection must fail closed when native pricing and Marketplace revision disagree;
- incomplete cross-module synchronization is observable/recoverable;
- no false ACID guarantee exists across Marketplace and native Medusa persistence.

## Slot foundation

Implemented bounded UTC slot configuration validation for:

- lead time;
- booking horizon;
- cutoff;
- overlapping windows;
- capacity.

Referenced slots cannot be reconfigured through the foundation configuration API.

M9-C owns capacity acquisition and reservation mutation.

## Admin authorization

Scheduling configuration endpoints require:

- authenticated platform-user session;
- explicit confirmation where required;
- audit reason.

No merchant scheduling permissions/UI were added.

## Native route protection

M8 native cart protection remains.

M9-B also blocks native:

```text
/store/shipping-options
/store/shipping-options/*
```

for every method, including native calculation paths, so they cannot bypass GoSpaza:

- authenticated cart ownership;
- polygon serviceability;
- store-zone resolution;
- configuration synchronization;
- scheduling authority.

UI hiding is not considered protection.

## M9-B verification

The user verified after implementation/debugging:

- lint/tests/typecheck gates passed;
- database migration succeeded;
- `test:scheduling-foundation` passed;
- M6 location regression passed;
- M5 catalogue regression passed;
- M8 cart foundation passed;
- M8 cart mutations passed;
- production backend build succeeded.

M9-B is therefore **VERIFIED**.

# M9-C — Reservation Backend — VERIFIED

Implement only reservation/availability backend behavior.

Do not begin M9-D.

## Required capabilities

### Delivery option resolution

For the authenticated customer's current cart and validated location:

- resolve current `CartMarketplaceContext`;
- resolve current MerchantStore;
- resolve eligible M6 service-zone assignment;
- apply assignment priority;
- validate scheduling policy;
- validate option configuration revision;
- validate native Shipping Option;
- validate native price;
- return enabled operational options.

Browser-supplied merchant/store/zone/fee authority is ignored/rejected.

### Slot availability

Availability must derive from:

- current database time;
- StoreDeliveryPolicy timezone;
- booking horizon;
- lead time;
- concrete slot start/end/cutoff;
- slot enabled state;
- effective active reservations;
- current serviceability;
- current option configuration revision.

Availability reads must not create slots.

### Reservation acquisition

Under the customer-scoped M8 advisory lock:

1. resolve authenticated current cart/context;
2. validate current location and store-zone assignment;
3. validate option/configuration/native price;
4. acquire relevant slot/configuration locks;
5. use fresh database time after lock acquisition;
6. count effective capacity;
7. create one `HELD` reservation transactionally.

Never oversell capacity.

### Reservation replacement

Replacement must be atomic from the customer's perspective:

- validate target capacity before releasing old reservation;
- failure preserves the existing valid hold;
- lock affected slots in stable ID order;
- stale expected selection revision fails;
- repeated identical selection must not silently extend expiry.

### Reservation release

Customer may release current scheduling selection without current location eligibility.

Release must be authoritative and idempotent.

### Expiry

`expires_at` is authoritative.

Expired `HELD` rows must not consume capacity even if background cleanup is delayed.

Worker/cleanup later transitions expired records with conditional idempotent writes.

No browser timer or Redis timer is authoritative.

Refreshing/reloading must not extend a hold.

### ASAP selection

ASAP selects the earliest eligible concrete capacity window.

It does not create dispatch/driver semantics.

### Scheduled selection

Scheduled mode reserves a specific eligible advertised slot.

### Store-switch integration

M8 store switch and reservation publication must share the customer lock.

Authoritative publication must:

- create candidate native cart as M8 requires;
- lock/release old reservation capacity safely;
- publish replacement cart context;
- supersede old context;
- release old scheduling reservation;
- return new cart without inherited scheduling selection.

Failure before publication preserves old cart + reservation.

Superseded contexts never consume effective capacity.

### Empty-cart interaction

Removing the final item should release the active scheduling hold.

Failure handling must not falsely report that a successfully completed native removal was undone.

M8 decrease/remove behavior must remain usable without scheduling/location eligibility.

### Restoration/staleness

Expected behavior:

| Condition | Result |
|---|---|
| Current cart + valid hold + unchanged eligibility | restore selection and original expiry |
| Browser reopen before expiry | restore same hold |
| Expired hold | expired/unselected state; require new selection |
| Store unavailable | invalidate/release selection; retain cart |
| Zone no longer eligible | invalidate/release selection; retain cart |
| Slot disabled | unavailable; require reselection |
| Safe capacity reduction | existing valid holds remain protected |
| Fee/config revision changed | require reconfirmation/reselection |
| Superseded cart hint | reject stale |
| M8 store switch | new cart has no inherited reservation |

## M9-C concurrency rules

Retain M8 customer-scoped PostgreSQL advisory lock as outer boundary.

Inside the Marketplace transaction use deterministic lock ordering:

```text
customer advisory lock
→ relevant configuration locks
→ affected DeliverySlot rows in stable ID order
→ reservation read/write
→ commit
```

All capacity writers must follow the same slot-lock protocol.

Required race behavior:

| Race | Required protection |
|---|---|
| Two customers claim final capacity | same slot row lock; only one can consume final unit |
| Two selections from same cart | customer lock + revision + active-hold constraint |
| Replacement vs expiry | customer lock + affected slot locks |
| Store switch vs reservation | same customer lock |
| Capacity reduction vs booking | same slot lock; reject reduction below occupied capacity |
| Multiple backend instances | PostgreSQL locks + constraints |

Use fresh database time after waiting for locks.

Do not rely on process-local locks.

Do not blindly replay non-idempotent Medusa workflows.

## M9-C API surface

Use authenticated GoSpaza customer routes.

Expected minimum:

```text
POST   /store/gospaza/cart/delivery-options
POST   /store/gospaza/cart/delivery-slots
PUT    /store/gospaza/cart/delivery-selection
DELETE /store/gospaza/cart/delivery-selection
GET    /store/gospaza/cart/delivery-selection
```

Exact route naming may follow established repository conventions, but authority boundaries must remain unchanged.

Inputs may include:

- location/address selection;
- operational option selection;
- slot selection;
- expected selection revision;
- current cart ID only as stale-state hint.

Do not accept authoritative:

- merchant ID;
- store ID;
- ServiceZone ID;
- fee;
- customer ID;
- Sales Channel ID;
- shipping configuration;
- marketplace-context authority.

## M9-C security / known-ID requirements

Explicitly test hostile use of:

- another customer's cart ID;
- foreign reservation ID;
- foreign slot ID;
- slot from another merchant/store;
- native Shipping Option from another assignment;
- forged ServiceZone;
- forged merchant/store/customer/channel IDs;
- forged delivery fee;
- expired reservation;
- stale selection revision;
- superseded M8 cart;
- disabled slot;
- stale availability result;
- native shipping route bypass.

A valid known ID is never authorization.

# M9-D — Customer Scheduling Experience

Do not begin until M9-C is verified.

Implement customer-facing scheduling only against M9-C authoritative APIs.

Required UX:

- delivery-option selection;
- ASAP availability;
- scheduled date/time selection;
- native-priced delivery quote;
- current reservation/expiry display;
- restoration after navigation/reload;
- expired reservation state;
- stale availability handling;
- changed-fee/config reconfirmation;
- unavailable slot handling;
- release/change selection;
- location/serviceability errors;
- explicit loading/error/retry states.

The browser must not:

- calculate authoritative capacity;
- calculate authoritative delivery fee;
- decide merchant/store/zone authority;
- silently extend reservation expiry;
- attach native Shipping Method;
- enter checkout/payment.

M10 owns checkout progression.

# M9-E — Acceptance / Security

Final M9 acceptance must prove the milestone invariants with real database/API/browser coverage where appropriate.

Minimum coverage:

- authenticated option resolution;
- polygon serviceability remains authoritative;
- deterministic overlapping-zone priority;
- ambiguous equal-priority failure;
- native price/config revision agreement;
- last-capacity race between customers;
- same-cart concurrent selection;
- atomic replacement;
- replacement vs expiry race;
- store switch vs reservation race;
- capacity reduction vs reservation;
- expired holds do not consume capacity before cleanup;
- repeated selection does not renew expiry;
- foreign cart/reservation/slot attacks;
- forged authority fields;
- superseded-cart rejection;
- native shipping-option bypass protection;
- final-item removal releases hold;
- decrease/remove remain usable without location;
- reservation restoration after reload;
- fee/config change requires reconfirmation;
- UI never displays a reservation as valid after authoritative expiry;
- no payment/order/dispatch functionality introduced.

Final Astra audit should focus on:

- customer isolation;
- store/zone/option authority;
- capacity oversell;
- lock ordering/deadlocks;
- stale revision handling;
- expiry races;
- M8 store-switch integration;
- native route bypass;
- compensation/recovery boundaries.

# M9 hard invariants

These must never be violated.

1. **One authority per concern.** Medusa owns commercial shipping state; GoSpaza owns operational scheduling/capacity.
2. **Current cart authority comes from authenticated customer + `CartMarketplaceContext`.**
3. **GoSpaza polygon ServiceZone is geographic authorization. Native country geo-zone is compatibility only.**
4. **Browser IDs and amounts are never authority.**
5. **A slot can never be oversold.**
6. **At most one effective held reservation exists per current cart context.**
7. **Expired reservations never consume effective capacity.**
8. **A superseded cart never retains effective scheduling authority/capacity.**
9. **Store switching never carries the old reservation into the new cart.**
10. **Reservation replacement never destroys a valid old hold before the new hold is secured.**
11. **Refreshing/reloading never extends reservation expiry.**
12. **Native Medusa shipping endpoints cannot bypass GoSpaza ownership/serviceability/configuration rules.**
13. **M9 does not attach the Shipping Method to the cart.**
14. **M9 does not implement payment, order completion, dispatch, or delivery execution.**

# Explicitly out of scope for M9

- Yoco/payment collection
- attaching final native Shipping Method to cart
- checkout completion
- order creation/completion
- merchant order acceptance
- picking
- substitutions
- driver account/eligibility
- dispatch
- driver assignment
- live tracking
- delivery OTP
- alcohol doorstep verification
- refunds/store credit
- finance/commission ledger
- settlements/payouts

# Implementation slices

```text
M9-A  Architecture                                  ✅ APPROVED
M9-B  Scheduling foundations                       ✅ VERIFIED
M9-C  Reservation backend + capacity concurrency   VERIFIED
M9-D  Customer scheduling UX                       VERIFIED
M9-E  Acceptance/security                          IMPLEMENTED; verification pending
```

Each slice must stop before the next slice and report:

- behavior implemented;
- important architecture decisions;
- tests added;
- defects found/fixed;
- files materially changed;
- exact one-line verification commands;
- remaining dependency for the next slice.

Codex must not run verification commands unless explicitly instructed otherwise.

## M9-E acceptance report

See [M9_E_ACCEPTANCE.md](../docs/architecture/M9_E_ACCEPTANCE.md) for the invariant matrix, static security audit, focused test additions, M25 hardening items and user-run verification sequence. No commands were run by Codex. M10 was not started.
