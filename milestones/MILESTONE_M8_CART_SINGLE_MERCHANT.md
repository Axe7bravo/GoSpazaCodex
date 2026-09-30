# GoSpaza — Milestone M8
## Cart & Single-Merchant Enforcement

Implement **Milestone M8 only**.

This milestone must be executed in bounded work units. Do not implement the whole milestone as one undifferentiated task.

Use:
- `gospaza-milestone-implementer`
- `medusa-first-architecture`
- `gospaza-security-review`

Do not run command-heavy verification. The user will run commands.

---

# 1. Objective

Connect the M7 storefront to Medusa-native carts while enforcing GoSpaza's core commerce invariant:

```text
one cart = one merchant/store
```

M8 adds:

- customer cart creation/restoration;
- `CartMarketplaceContext`;
- product/variant ownership validation before cart mutation;
- strict single-merchant enforcement;
- add/update/remove line items;
- safe store-switch behavior;
- customer cart UI;
- concurrency-safe cart mutation;
- focused cart security/integration/browser coverage.

M8 does **not** implement shipping, scheduling, checkout, Yoco, orders, picking, substitutions, delivery, refunds, or finance.

---

# 2. Execution slices

Work in this order:

```text
M8-A  Architecture only
      pinned Medusa cart review
      + single-merchant/concurrency design
      + no implementation beyond notes required for the decision

M8-B  Cart context
      CartMarketplaceContext
      + cart creation/restoration
      + merchant binding

M8-C  Cart mutations
      add/update/remove
      + ownership validation
      + concurrency enforcement

M8-D  Customer UI
      cart page
      + add-to-cart entry points
      + store-switch flow

M8-E  Focused security/concurrency/integration/browser tests
```

Do not broaden scope between slices.

If M8-A finds a material conflict with Medusa 2.18.0 cart workflows, stop and report it before implementing M8-B.

---

# 3. M8-A — pinned Medusa cart review

Inspect the installed **Medusa 2.18.0** cart APIs, workflows and module behavior before implementation.

Confirm the pinned equivalents of:

- cart creation workflow;
- cart retrieval;
- add line-item workflow;
- update line-item workflow;
- remove line-item workflow;
- cart Sales Channel behavior;
- region/currency requirements;
- customer association;
- inventory/variant availability validation;
- cart locking/concurrency primitives;
- remote/module-link participation inside workflows;
- workflow compensation behavior.

Also inspect the existing GoSpaza lock/event/workflow infrastructure.

Do not assume behavior from newer Medusa versions.

## M8-A must explicitly answer

Before implementation, determine:

```text
1. where CartMarketplaceContext is persisted;
2. how Cart -> Merchant is linked;
3. how Cart -> Store is linked if needed;
4. whether Medusa cart Sales Channel is set at creation;
5. which lock boundary protects concurrent add-to-cart;
6. how first-item merchant binding is made atomic;
7. how cross-merchant adds are rejected;
8. how a store switch clears/replaces the old cart safely;
9. how anonymous vs authenticated cart restoration works;
10. which Medusa native workflows remain authoritative.
```

Do not continue if these are unresolved.

---

# 4. Core invariant

For MVP:

```text
one customer cart
=
one Merchant
=
one MerchantStore
```

A platform customer may shop from many merchants over time, but one active cart may never contain line items belonging to multiple merchants.

This must be enforced server-side.

Never rely only on:
- current storefront route;
- browser-selected store;
- client metadata;
- line-item display data;
- Sales Channel alone.

The authoritative chain is:

```text
requested variant
-> Product
-> M5 ProductMarketplaceProfile
-> Merchant
-> MerchantStore
```

The cart's merchant binding comes from `CartMarketplaceContext`, not from client input.

---

# 5. CartMarketplaceContext

Add the smallest custom cart extension required.

Conceptually:

```text
CartMarketplaceContext
  medusa_cart_id
  merchant_id
  merchant_store_id
  created_at
  updated_at
```

Required invariants:

```text
one Medusa cart -> at most one CartMarketplaceContext
```

and for a bound cart:

```text
merchant_id and merchant_store_id must agree
```

Do not duplicate:
- cart totals;
- line items;
- currency;
- customer;
- discounts;
- tax;
- shipping;
- payment state.

Those remain Medusa-owned.

Use a supported module link or custom model pattern consistent with the existing marketplace module.

---

# 6. Cart creation

Use Medusa-native cart creation.

The customer storefront must not create arbitrary Medusa carts through Admin APIs.

Creation should establish the minimum native context required by the pinned version.

If Medusa requires:
- Sales Channel;
- Region;
- Currency;
- customer association;

set them using server-derived values.

## Sales Channel

When a cart becomes merchant-bound, the cart must use the merchant's M5 Sales Channel if the pinned cart model/workflows require Sales Channel scoping for product/inventory correctness.

Do not trust a client-supplied Sales Channel ID.

---

# 7. First-item binding

An empty cart may begin unbound.

On the first successful add:

```text
cart has no CartMarketplaceContext
+
variant belongs to Merchant A / Store A
        ↓
atomically bind cart to Merchant A / Store A
        ↓
add Medusa line item
```

This must be concurrency-safe.

Two simultaneous requests for products from different merchants must not both succeed.

Example race:

```text
Request A -> Merchant A
Request B -> Merchant B
```

Allowed outcomes:

```text
A succeeds, B rejects
or
B succeeds, A rejects
```

Forbidden outcome:

```text
cart contains A + B
```

Use the repository's supported locking mechanism/workflow transaction strategy.

Do not solve this with a frontend flag.

---

# 8. Subsequent add-to-cart

For an already-bound cart:

```text
requested variant
-> resolve owning Merchant/Store server-side
-> compare with CartMarketplaceContext
```

If same merchant/store:
- proceed through native Medusa add-line-item workflow.

If different merchant/store:
- reject with a safe machine-readable conflict response.

Conceptually:

```text
CART_MERCHANT_CONFLICT
```

The response should provide enough information for the customer UI to offer a store switch, without leaking internal merchant IDs unnecessarily.

---

# 9. Store switch behavior

M8 must support the intentional customer flow:

```text
customer has cart from Store A
customer attempts product from Store B
        ↓
UI explains current cart belongs to Store A
        ↓
customer chooses:
  keep current cart
  OR
  start new cart for Store B
```

If customer confirms switch:

```text
old cart is abandoned/cleared according to supported Medusa behavior
new cart is created/bound to Store B
requested item is added
```

Do not silently destroy a cart.

Do not merge carts across merchants.

Do not implement multi-cart persistence in MVP unless required by the existing Medusa architecture.

---

# 10. Cart restoration

Support practical restoration across page navigation/reload.

Reuse the existing native Medusa cart ID pattern if already present in the customer app.

Requirements:

- restored cart must be revalidated server-side;
- CartMarketplaceContext must still exist and be consistent;
- merchant/store must still be active;
- line items must still resolve to the bound merchant;
- malformed/stale cart IDs fail safely;
- never trust browser metadata for merchant identity.

If the merchant/store becomes inactive, return a safe stale-cart state rather than allowing new mutations.

Do not implement checkout recovery in M8.

---

# 11. Customer association

Authenticated customer carts should use the native Medusa customer association supported by 2.18.0.

Do not create a second cart-owner identity system.

If anonymous carts are already supported cleanly by the existing storefront, preserve them.

If not, do not expand M8 merely to introduce anonymous customer commerce.

Do not accept a client-supplied customer ID.

---

# 12. Cart mutations

Add only the M8 mutations required for:

```text
add line item
update line-item quantity
remove line item
clear/replace cart during confirmed store switch
```

Use native Medusa workflows/services.

Do not duplicate line-item state.

## Quantity updates

Validate:
- positive integer quantity for retained lines;
- zero means remove only if the chosen API contract explicitly defines it;
- variant still belongs to cart merchant;
- native inventory/backorder behavior remains authoritative.

Do not directly edit reserved inventory.

## Remove

Removing the last line item may leave the cart merchant-bound or unbind it depending on the selected M8-A architecture.

Choose one deterministic policy and document it.

Preferred MVP behavior:

```text
empty cart may remain bound to its current merchant
until explicit store switch/new cart
```

if that avoids race/rebinding complexity.

Do not silently rebind an existing empty cart to another merchant unless the architecture explicitly guarantees correctness.

---

# 13. Public/storefront API

Add only cart APIs required by M8.

Conceptually:

```text
GET    /store/gospaza/cart
POST   /store/gospaza/cart
POST   /store/gospaza/cart/items
PATCH  /store/gospaza/cart/items/:lineItemId
DELETE /store/gospaza/cart/items/:lineItemId
POST   /store/gospaza/cart/switch-store
```

Exact route shape should follow repository conventions and native Medusa capabilities.

Do not expose Medusa Admin cart routes to the browser.

Do not accept client-supplied:
- merchant ID;
- merchant store ID;
- Sales Channel ID;
- Stock Location ID;
- customer ID.

Variant/product identifiers are allowed inputs but ownership must be resolved server-side.

---

# 14. Cart DTO

Return a deliberate storefront cart DTO.

Conceptually:

```text
id
store
items[]
currency_code
subtotal/total fields already safely native where available
item_count
stale/available state
```

Line item public shape should include only what the customer needs:
- line item ID;
- product title;
- variant title;
- quantity;
- unit price;
- image;
- owning store context if useful.

Do not expose:
- internal marketplace IDs;
- native stock-location IDs;
- Sales Channel IDs;
- reservation IDs;
- cost/payout data;
- private metadata.

---

# 15. M7 integration

M7 product/store pages may now gain Add to Cart controls.

Requirements:

- product detail variant selection;
- add-to-cart;
- visible cart state/count;
- merchant-conflict UX;
- store-switch confirmation.

Do not redesign M7 discovery.

Do not add cart functionality to products from ineligible stores.

When product/store eligibility changes, server-side mutation remains authoritative even if the UI is stale.

---

# 16. Customer routes/UI

Implement/extend:

```text
/cart
```

And add cart affordances to:

```text
/stores/[storeId]
/products/[productId]
```

Use the existing GoSpaza customer visual direction.

## Cart page

Show:
- current store;
- line items;
- variant;
- unit price;
- quantity controls;
- subtotal/available totals;
- remove;
- empty state;
- stale/unavailable state where applicable.

Do not show:
- shipping;
- delivery slot;
- payment;
- checkout completion.

Prefer no checkout button over a misleading one.

---

# 17. Security

Use `gospaza-security-review`.

Required protections:

- known variant ID cannot bypass merchant ownership;
- known product ID cannot bypass merchant ownership;
- known line-item ID cannot mutate another cart;
- known cart ID cannot mutate another authenticated customer's cart;
- client cannot choose merchant/store/channel/location;
- cross-merchant add is rejected server-side;
- store-switch requires explicit customer confirmation;
- malformed/stale cart IDs fail safely;
- draft/unpublished products cannot be newly added;
- inactive merchant/store cannot receive new line items;
- geographically ineligible store cannot receive new line items if M8 preserves current-location enforcement;
- private product/media data never enters cart DTO;
- no native Admin credentials leak.

---

# 18. Location and eligibility rule

M7 uses location-scoped discovery.

For M8, preserve current location eligibility on add-to-cart.

At mutation time, revalidate that the product's store is still eligible for the customer's selected/owned location context used by the storefront.

Do not trust a previously returned M7 result indefinitely.

If M8-A determines the cart must retain a location reference for stable cart semantics, add only the smallest context required and explain why.

Do not implement checkout delivery address selection yet.

---

# 19. Concurrency

This is a critical M8 acceptance area.

Real database/integration coverage must prove:

```text
two simultaneous first adds from same merchant
-> valid final cart

two simultaneous first adds from different merchants
-> exactly one merchant wins

cross-merchant add to bound cart
-> rejected

concurrent quantity updates
-> deterministic/native-safe result

store switch racing with add
-> cannot create mixed cart
```

Use the repository's lock/workflow infrastructure.

Do not rely on unit mocks for these invariants.

---

# 20. Tests

## Unit

Only for isolated policy/DTO logic.

Examples:
- merchant conflict decision;
- safe cart DTO mapping.

## Real database/API

Cover:

- cart creation;
- first-item merchant binding;
- second same-merchant add;
- cross-merchant rejection;
- known variant from another merchant;
- known line-item from another cart;
- authenticated ownership;
- inactive/draft/ineligible product rejection;
- store switch;
- restored cart validation;
- first-add concurrency;
- cross-merchant concurrency;
- quantity update/remove;
- last-item behavior.

## Regression

Preserve M1-M7 tests.

## Browser

Focused journeys:

```text
add first product
cart persists through navigation/reload
same-store second product succeeds
quantity update/remove
different-store add shows conflict
keep current cart preserves it
confirmed switch creates new store cart
cart never visually contains products from two stores
```

Keep deterministic mocks.

Do not add arbitrary sleeps, blanket retries, or timeout inflation.

---

# 21. Explicitly out of scope

Do NOT implement:

- shipping options;
- service-zone fee selection;
- delivery scheduling;
- checkout;
- Yoco;
- payment sessions;
- order creation;
- merchant order acceptance;
- picking;
- substitutions;
- driver flows;
- dispatch;
- delivery tracking;
- OTP;
- age verification;
- refunds;
- store credit;
- commissions;
- settlements;
- notifications;
- multi-merchant cart;
- split orders;
- persistent multiple active carts per customer unless Medusa already provides it without extra product scope.

---

# 22. Command policy

Do not execute:
- installs;
- migrations;
- Docker;
- lint;
- typecheck;
- tests;
- builds;
- dev servers.

If runtime evidence is genuinely required:
- give the user one exact single-line PowerShell command;
- explain what output is needed;
- stop until the user returns it.

---

# 23. Completion report

When implementation is complete, stop and return:

```text
MILESTONE M8 COMPLETE

1. Implemented
2. M8-A Medusa cart decisions
3. CartMarketplaceContext
4. Merchant/store binding
5. Cart creation/restoration
6. Add/update/remove behavior
7. Store-switch behavior
8. Concurrency enforcement
9. API routes/workflows
10. Cart DTO
11. UI
12. Authorization/security
13. Tests added
14. Verification status
15. Commands for user to run
16. Explicitly NOT implemented
17. Known limitations
18. Files/modules materially changed
```

For verification commands:
- strict order;
- every PowerShell command must be one line;
- stop on first failure.

Stop after M8.
