# GoSpaza — Milestone M7
## Customer Discovery & Storefront

Implement **Milestone M7 only**.

This milestone should be executed in bounded work units rather than as one large monolithic task.

Use:
- `gospaza-milestone-implementer`
- `medusa-first-architecture`
- `gospaza-security-review`

Do not run command-heavy verification. The user will run commands.

---

# 1. Objective

Expose the M5 catalogue and M6 serviceability foundations to customers through a location-aware storefront.

M7 adds:

- customer location gating;
- eligible-store discovery;
- dynamic zero-store / one-store / multi-store experiences;
- customer store pages;
- customer product pages;
- PostgreSQL-backed product/store search;
- inventory-aware product visibility;
- public storefront APIs;
- responsive customer discovery UI.

M7 does **not** implement carts, checkout, scheduling, payments, orders, substitutions, delivery, or finance.

---

# 2. Execution slices

Work in this order and keep each slice internally reviewable:

```text
M7-A  Discovery backend
      location -> eligible stores -> public store summaries

M7-B  Storefront backend
      store catalogue -> public product detail -> search

M7-C  Customer UI
      0 / 1 / 2+ store experiences + store/product/search pages

M7-D  Focused browser/integration tests + regression review
```

Do not broaden scope between slices.

If a material Medusa 2.18.0 API discrepancy appears, stop and report it before improvising.

---

# 3. Pinned Medusa review — do this first

Inspect the installed **Medusa 2.18.0** APIs and existing M5/M6 implementation before editing.

Confirm how the current code retrieves:

- Products;
- Product Variants;
- calculated/native ZAR prices;
- inventory availability;
- Sales Channel product scoping;
- Stock Location inventory;
- Product images;
- customer session/address data;
- custom Product -> Merchant ownership links;
- MerchantStore -> ServiceZone mappings.

Do not bypass M5/M6 abstractions by rebuilding their logic in M7.

---

# 4. Discovery source of truth

M7 must derive store eligibility from M6 server-side serviceability logic.

Conceptually:

```text
customer coordinates
    ↓
matching active GoSpaza ServiceZone(s)
    ↓
active MerchantStoreServiceZone mappings
    ↓
active Merchant
    ↓
active MerchantStore
    ↓
eligible stores
```

Do not accept a client-supplied zone ID or merchant ID as proof of eligibility.

Do not infer eligibility from:
- store address;
- city string;
- postcode;
- Sales Channel alone;
- Stock Location alone.

The M6 geographic service remains authoritative.

---

# 5. Store eligibility

A store is publicly discoverable only when all applicable conditions are true:

```text
merchant active
merchant store active
store assigned to at least one matching active service zone
native commerce infrastructure present
```

If product/catalogue state also requires a native merchant Sales Channel, respect that topology.

Do not expose an approved merchant with broken/missing commerce infrastructure as a usable store.

Return a safe operational result instead of leaking internal native IDs.

---

# 6. Dynamic marketplace mode

This is mandatory and must be derived dynamically from the eligible store count.

## 0 eligible stores

Show a no-service state.

Conceptually:

```text
"GoSpaza is not available at this location yet."
```

Allow the user to:
- change location/address;
- retry location check.

Do not show unavailable stores as if they can be ordered from.

## 1 eligible store

Use a focused single-store experience.

The customer should not be forced through a marketplace chooser when only one store is serviceable.

Conceptually:

```text
location
   ↓
single eligible store
   ↓
storefront-focused home/discovery
```

Do not hard-code a `SINGLE_STORE_MODE` environment flag.

## 2+ eligible stores

Show marketplace discovery.

Conceptually:
- eligible store cards;
- browse/search across eligible stores;
- ability to open a specific store.

The number of eligible stores may change by customer location.

---

# 7. Public store model / DTO

Do not expose raw Merchant, MerchantStore, Sales Channel, Stock Location, Service Zone or internal link records.

Return a deliberate public store DTO.

Conceptually:

```text
id
name
slug or public handle
short description
logo/image if available
availability state
minimum useful storefront metadata
```

If a public slug does not already exist, add the smallest marketplace-owned public identifier required.

Do not use mutable merchant names as the sole stable route identifier if a safer identifier is needed.

Do not expose:
- owner/member identities;
- settlement data;
- application data;
- private addresses unless intentionally public;
- native Medusa IDs not required by the client;
- internal service-zone IDs unless required by the M7 API contract.

---

# 8. Public catalogue rules

M5 remains authoritative for product ownership and inventory.

A product is customer-visible only when all are true:

```text
Product belongs to eligible Merchant
Product is published/active
Product is available to merchant's commerce scope
Product has at least one usable variant
```

Do not show draft products.

## Inventory behavior

M7 should expose an availability state derived from native Medusa inventory.

Examples:

```text
in_stock
out_of_stock
```

If M5 already has a richer safe availability abstraction, reuse it.

Do not expose raw reservation internals.

Do not allow negative availability.

Products may remain visible while out of stock if the existing storefront design benefits from that, but the state must be clear.

Do not implement cart enforcement yet.

---

# 9. Pricing

Use native Medusa pricing from M5.

Display ZAR consistently.

Do not create a storefront price cache or duplicate price table.

For products with multiple variants, expose a useful public price summary such as:

```text
from_price_minor
to_price_minor
currency_code
```

Product detail must expose each variant's actual price.

Do not implement:
- discounts/promotions;
- commission;
- merchant payout math;
- delivery fee selection;
- taxes beyond what is already safely represented by the current Medusa configuration.

---

# 10. Restricted/alcohol products

Reuse M5's marketplace compliance flag.

Public product DTO may expose a simple safe field such as:

```text
requires_age_verification: true
```

This is informational only in M7.

Do not implement purchaser age verification or doorstep alcohol compliance.

Do not hide restricted products purely because age verification is not yet implemented unless the product roadmap explicitly requires that temporary behavior.

---

# 11. Search

Use PostgreSQL / Medusa-native querying only.

Do not add Elasticsearch, Meilisearch, Algolia or another search service.

M7 search should support practical customer queries across eligible stores.

At minimum:

```text
product title
product description where appropriate
store name
SKU only if customer-facing behavior benefits from it
```

Search results must still respect:

```text
customer location
eligible stores
published product state
merchant ownership
```

A search must never return a product from an ineligible store merely because the text matched.

Support basic pagination.

Do not build typo tolerance, autocomplete infrastructure, ranking ML, sponsored results or recommendations.

---

# 12. Public APIs

Add only M7 APIs needed by the customer storefront.

Conceptually:

```text
POST /store/gospaza/discovery

GET  /store/gospaza/stores
GET  /store/gospaza/stores/:storeId
GET  /store/gospaza/stores/:storeId/products
GET  /store/gospaza/products/:productId
GET  /store/gospaza/search
```

Exact route shape should follow the existing repository conventions.

## Location input

Discovery/search requests may use:

```text
saved customer address ID
```

or:

```text
validated latitude + longitude
```

If address ID is supplied:
- authenticated customer must own it;
- coordinates come from the server-side M6 location extension.

If anonymous coordinates are supported:
- validate ranges;
- return only public storefront information.

Do not accept arbitrary service-zone IDs to shortcut serviceability.

---

# 13. Customer routes / UI

Implement the approved M7 customer routes:

```text
/
 /stores
 /stores/[storeId]
 /products/[productId]
 /search
```

Use the approved GoSpaza customer visual direction:
- mobile-first;
- purposeful desktop layout;
- warm cream/off-white;
- dark ink/charcoal;
- orange primary/movement;
- green availability/success;
- product imagery;
- moderate rounding;
- neighbourhood utility feel.

Do not redesign the brand.

## Home `/`

Home must respond to customer location state.

States:

```text
location unknown
location checking
0 eligible stores
1 eligible store
2+ eligible stores
location/API error
```

For one eligible store:
- focus the homepage on that store's shopping experience;
- avoid unnecessary marketplace-selection chrome.

For multiple stores:
- show store discovery first.

## `/stores`

Only show currently eligible stores for the selected location.

## `/stores/[storeId]`

Show:
- public store summary;
- product listing;
- availability;
- search/filter basics if useful.

Reject or safely handle an otherwise valid store that is not eligible for the customer's current location.

## `/products/[productId]`

Show:
- image(s);
- title;
- description;
- variants;
- ZAR price;
- stock state;
- restricted/alcohol indicator where applicable;
- owning store context.

Do not add Add to Cart behavior yet.

## `/search`

Show location-scoped search results.

Keep no-results and no-service states distinct.

---

# 14. Location state on the customer frontend

M6 created saved addresses and browser-coordinate support.

M7 should introduce the smallest reusable customer location state needed for discovery.

Requirements:

- location may come from a saved customer address;
- anonymous/current browser coordinates may be used where already supported;
- do not persist sensitive location more broadly than necessary;
- do not invent a second customer address system;
- do not trust browser-stored zone/store eligibility;
- server remains authoritative on every discovery request.

Do not build checkout-address selection yet.

---

# 15. Single-merchant boundaries

M7 is still discovery only, but the storefront must make store ownership explicit.

Every product DTO must be tied to one owning public store.

Do not create cross-merchant product bundles.

Do not pretend products from different stores are one catalogue without preserving store ownership.

M8 will enforce one merchant per cart.

---

# 16. Security / privacy

Use `gospaza-security-review`.

Required protections:

- draft products never appear publicly;
- products from inactive merchants/stores never appear publicly;
- products from geographically ineligible stores never appear in location-scoped discovery;
- known store ID cannot bypass geographic eligibility;
- known product ID cannot bypass geographic eligibility;
- product ownership is resolved server-side;
- search cannot leak ineligible merchant catalogue;
- customer address IDs are ownership-checked;
- no internal merchant-member data leaks;
- no application/compliance-document data leaks;
- no native admin credentials/tokens reach the storefront;
- no private M2 storage URLs appear in product/public DTOs;
- public catalogue images only come from the public M5 media path;
- errors do not expose database/native module internals.

---

# 17. Performance boundaries

Keep M7 pragmatic.

Avoid N+1 queries where obvious.

Do not prematurely add:
- Redis result caching;
- search indexes outside PostgreSQL;
- recommendation systems;
- background indexing;
- denormalized storefront tables.

Pagination is required for potentially large lists.

If inventory lookup requires batching, use the supported M5/native approach.

---

# 18. Tests

## Unit

Only add unit tests where logic is genuinely isolated.

Examples:
- marketplace-mode derivation from eligible-store count;
- safe public DTO mapping.

## Real database / API integration

Cover:

- 0 eligible stores;
- exactly 1 eligible store;
- 2+ eligible stores;
- inactive merchant excluded;
- inactive store excluded;
- inactive zone mapping excluded;
- published product visible;
- draft product excluded;
- known store ID cannot bypass serviceability;
- known product ID cannot bypass serviceability;
- search remains location-scoped;
- overlapping M6 zones do not duplicate a store;
- product public DTO has correct merchant/store ownership;
- native price/inventory data is reflected correctly.

## Regression

Preserve M1-M6 tests.

Do not rewrite earlier tests unless a real shared abstraction changed.

## Browser

Add focused browser coverage for:

```text
0 stores -> no-service state
1 store -> focused single-store experience
2+ stores -> marketplace store chooser
store page -> catalogue renders
product page -> variants/price/stock/restricted state
search -> only eligible-store results
change location -> discovery result changes
```

Keep browser mocks deterministic.

Avoid arbitrary sleeps and timeout inflation.

---

# 19. Explicitly out of scope

Do NOT implement:

- cart creation;
- add-to-cart;
- cart switching;
- cart persistence;
- shipping options;
- scheduling;
- checkout;
- Yoco;
- order placement;
- merchant order acceptance;
- picking;
- substitutions;
- driver flows;
- dispatch;
- delivery tracking;
- OTP;
- age verification;
- refunds;
- wallet/store credit;
- commission;
- settlements;
- notifications;
- recommendations;
- loyalty;
- coupons/promotions;
- production geocoder/map provider.

---

# 20. Command policy

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
- explain what result is needed;
- stop until the user returns it.

---

# 21. Completion report

When implementation is complete, stop and return:

```text
MILESTONE M7 COMPLETE

1. Implemented
2. Discovery architecture
3. Dynamic marketplace mode
4. Store eligibility
5. Public store DTO
6. Public product/catalogue DTO
7. Search behavior
8. Location handling
9. API routes / workflows
10. UI
11. Authorization / security
12. Tests added
13. Verification status
14. Commands for user to run
15. Explicitly NOT implemented
16. Known limitations
17. Files/modules materially changed
```

For verification commands:
- strict order;
- every PowerShell command one line;
- stop on first failure.

Stop after M7.
