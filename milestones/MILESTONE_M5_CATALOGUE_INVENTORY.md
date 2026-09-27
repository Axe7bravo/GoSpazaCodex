# GoSpaza — Milestone M5
## Catalogue & Inventory

Implement **Milestone M5 only**.

Follow all applicable repository instructions.

Use:
- `gospaza-milestone-implementer` for milestone scope and verification discipline.
- `medusa-first-architecture` for Product, Pricing, Inventory, Stock Location, Sales Channel, File Module, workflows, and module links.
- `gospaza-security-review` for tenant scoping, media uploads, known-ID attacks, and merchant capability enforcement.

Do not run command-heavy verification. The user will run commands.

# Objective

Give an approved GoSpaza merchant a real Medusa-native catalogue and manually managed inventory while preserving GoSpaza's custom tenant model.

M5 introduces:
- merchant catalogue management;
- product variants and ZAR pricing;
- merchant product ownership links;
- one Medusa Stock Location per MVP `MerchantStore`;
- the Sales Channel / Stock Location topology required for merchant-specific inventory and future single-merchant carts;
- Medusa-native inventory items and inventory levels;
- public catalogue image upload;
- merchant inventory management;
- minimal M5 catalogue/inventory capabilities.

M5 does **not** implement service zones, customer discovery, customer carts, checkout, orders, picking, substitutions, delivery, payments, finance, or POS integration.

# Foundational ownership rule

Medusa remains authoritative for commerce data.

Use Medusa-native ownership for:

```text
Product
ProductVariant
Product options
Price
InventoryItem
InventoryLevel
StockLocation
SalesChannel where selected by the pinned architecture
Product images/media relationships
```

GoSpaza must **not** create parallel custom product, variant, price, or inventory tables.

The GoSpaza marketplace module owns only marketplace-specific relationships/policy such as:

```text
Merchant -> Medusa Product ownership
MerchantStore -> Medusa StockLocation relationship
Merchant -> Medusa SalesChannel relationship if used
product compliance/profile extension where genuinely required
```

Use supported Medusa Module Links or an equally supported pinned-version mechanism. Never add direct foreign keys into Medusa-owned database tables.

# Pinned-version review before implementation

Inspect Medusa **2.18.0** and the installed core-flow APIs before editing.

Do not copy examples written for newer Medusa versions without confirming that the APIs exist in 2.18.0.

Specifically inspect the pinned equivalents of:
- Product workflows;
- Stock Location workflows;
- Sales Channel workflows;
- Inventory Item / Inventory Level workflows;
- product-to-sales-channel links;
- sales-channel-to-stock-location links;
- product variant inventory creation/link behavior;
- File Module upload/delete behavior.

Prefer Medusa core workflows and module links instead of manually coordinating Medusa-owned records.

# Commerce topology decision

M3 correctly deferred Stock Location and Sales Channel because no inventory existed yet.

M5 must now establish the native topology required for a merchant's catalogue and inventory.

The expected architecture, **if confirmed by the pinned Medusa version**, is:

```text
Merchant
  ├── owns -> Medusa Products
  └── maps -> one merchant Sales Channel (MVP)

MerchantStore
  └── maps -> one Medusa Stock Location (MVP)

Merchant Sales Channel
  ├── linked -> Merchant Products
  └── linked -> MerchantStore Stock Location

Product Variant
  └── linked -> Inventory Item
                    └── Inventory Level at MerchantStore Stock Location
```

This topology is expected because Medusa scopes product availability, carts, and inventory availability through Sales Channels and their linked Stock Locations.

However:
- confirm this behavior in the pinned version;
- do not use Sales Channel as the GoSpaza authorization boundary;
- `MerchantMember -> Merchant` remains authoritative for tenancy;
- Sales Channel is commerce scoping, not identity or authorization;
- do not map each GoSpaza merchant to a native Medusa `Store`.

If the pinned version materially requires a different supported topology, stop and report the discrepancy rather than improvising.

# Existing merchant backfill and future provisioning

M3 merchants already exist without native catalogue infrastructure.

M5 must support both:

```text
existing approved merchants
future approved merchants
```

Implement one reusable, idempotent merchant-commerce provisioning workflow/service.

It should create-or-resolve the merchant's required:

```text
Sales Channel (if confirmed)
Stock Location
native links between them
custom marketplace links to Merchant / MerchantStore
```

## Future merchants

Extend the M3 approval/provisioning flow only as necessary so merchants approved after M5 receive the required catalogue/inventory infrastructure.

Do not otherwise redesign M3.

## Existing merchants

Provide a safe idempotent backfill path for already-approved merchants.

Do not hide resource creation inside a read-only `GET` request.

A dedicated script/workflow used during deployment/verification is acceptable if it uses the same reusable provisioning logic as future approvals.

Repeated backfill must not duplicate resources.

# Marketplace relationships

## Merchant -> Product

Every merchant-owned Medusa Product must be linked to exactly one GoSpaza Merchant for MVP.

Use a supported module link.

Required invariant:

```text
one Medusa Product -> one GoSpaza Merchant
```

Do not infer product ownership from:
- product title;
- SKU;
- Sales Channel alone;
- Stock Location alone;
- request-supplied merchant ID.

All merchant catalogue authorization must begin with the authenticated member's resolved Merchant.

## MerchantStore -> Stock Location

For MVP:

```text
one MerchantStore -> one Medusa Stock Location
```

Persist this relationship using a supported link or the already-established compatible M3 field/link strategy.

The Stock Location address should originate from the provisioned merchant store snapshot where supported.

Do not hard-code Bloemfontein.

## Merchant -> Sales Channel

If the pinned review confirms the expected architecture:

```text
one Merchant -> one merchant Sales Channel
```

The relationship must be deterministic and idempotent.

Do not expose Sales Channel choice as a merchant UI setting in M5.

# Product compliance extension

GoSpaza needs a reliable marketplace-specific way to identify products that require age verification later.

Do **not** use editable category names, title text, tags, or arbitrary Product metadata as the sole compliance authority.

Add the smallest marketplace-owned extension linked 1:1 to the Medusa Product, for example:

```text
ProductMarketplaceProfile
  product link
  requires_age_verification boolean
```

The exact model name may follow existing marketplace naming conventions.

For M5:

```text
requires_age_verification = true
```

means the product is treated as alcohol/restricted for future GoSpaza compliance logic.

Do not implement age verification itself in M5.

Do not duplicate title, description, price, inventory, variant, or image data in this custom extension.

# Product lifecycle

Support merchant catalogue operations through custom merchant APIs that internally use Medusa-native workflows.

Minimum product fields:

```text
title
description
status
thumbnail/images
variants
```

Use native Medusa product status semantics appropriate to 2.18.0.

M5 should support at least a merchant-controlled draft/unpublished state and a published/active storefront-ready state.

Do not invent a parallel GoSpaza product status if Medusa already owns it.

## Product creation

Product creation must be one coherent business workflow:

```text
resolve authenticated Merchant tenant
-> verify catalogue capability
-> ensure merchant commerce infrastructure exists
-> validate input
-> create Medusa Product / options / variants / prices
-> enable native inventory management
-> create/link native inventory resources using supported flows
-> link Product to Merchant
-> link Product to merchant Sales Channel if required
-> create marketplace compliance profile
-> establish inventory levels at merchant Stock Location
```

If a later step fails, compensate/roll back where the pinned workflow infrastructure supports it.

Do not leave an unowned product silently accessible after a failed ownership-link step.

## Product update

Allow merchant-authorized updates to supported M5 fields.

Before mutation:

```text
product ID
-> resolve Product -> Merchant ownership link
-> compare to authenticated Merchant
```

Reject cross-tenant known-ID attacks.

## Product removal

Prefer safe native unpublish/draft behavior for routine removal.

If hard deletion is implemented:
- use native Medusa workflow;
- enforce tenant ownership first;
- clean marketplace links/profile;
- consider image cleanup safely;
- do not build order-history deletion logic in M5.

Do not expose a bulk destructive endpoint unless required.

# Product variants

Support both simple products and predefined variants.

Examples:

```text
Default
500g
1kg
2kg
Single
6 Pack
12 Pack
```

For variable-weight goods, GoSpaza MVP uses predefined purchasable variants.

Example:

```text
Tomatoes
  500g
  1kg
  2kg
```

Each variant has its own:
- SKU where used;
- price;
- inventory quantity.

Do **not** implement:
- actual weighed quantity;
- post-pick weight repricing;
- per-gram price adjustment.

Variant option design should use Medusa-native Product Options / Product Variants.

# Pricing

MVP currency:

```text
ZAR
```

Use Medusa-native pricing attached to variants.

Use the repository's established money representation and Medusa 2.18.0 price input semantics.

Do not introduce a custom price table.

Merchant APIs accept/display ZAR clearly.

Do not implement:
- multi-currency;
- merchant-specific customer price lists;
- commission calculation;
- promotional pricing;
- cost-of-goods accounting.

# Inventory

Inventory is manually maintained by merchants in MVP.

Use Medusa-native:

```text
InventoryItem
InventoryLevel
Reservation behavior
```

Do not create custom stock counters.

## Inventory level

All M5 merchant stock is held at the authenticated merchant's provisioned Stock Location.

Quantity is discrete variant units.

For a `500g` tomato variant:

```text
stocked_quantity = 12
```

means twelve 500g purchasable units, not 6kg of bulk produce.

## Inventory UI values

Where supported, distinguish:

```text
stocked/on-hand
reserved
available
```

Merchant may change stocked quantity.

Merchant must not directly edit reserved quantity.

Availability remains derived by Medusa.

## Inventory mutation

Before changing inventory:

```text
inventory item / variant
-> resolve owning Product
-> resolve Product -> Merchant
-> verify authenticated Merchant
-> resolve merchant Stock Location
-> mutate native Inventory Level
```

Do not trust:
- location ID supplied by browser;
- inventory item ID alone;
- Sales Channel ID alone.

Use native workflows/services and concurrency-safe behavior.

Reject negative or invalid stocked quantity according to supported native constraints.

# Backorders

Default M5 behavior:

```text
allow_backorder = false
```

Do not expose backorder management to merchants unless already required by an existing product rule.

# Product media

Merchants need product images.

Use the Medusa File Module/provider infrastructure rather than storing image bytes in PostgreSQL.

Product images are public commerce media, distinct from M2 private application documents.

## Accepted media

Support:

```text
JPEG
PNG
WebP
maximum 5 MB per image
```

Validate server-side.

Do not trust filename extension alone.

Generate safe storage/object keys through the provider.

Do not reuse private application-document access semantics for public product images.

## Upload authorization

Only an authenticated operational merchant with catalogue-management capability may upload catalogue media.

The upload endpoint must not accept a client-supplied merchant ID as authorization.

If the provider returns a public URL, only that safe URL/provider identifier may be attached to the Medusa Product.

Do not expose provider credentials or private storage keys.

## Cleanup

If an image upload succeeds but product mutation fails, clean up orphaned uploads where practical.

If an image is removed from a product, only delete the underlying object when it is safe and not referenced elsewhere.

# Merchant capabilities

Extend the M4 code-owned capability model minimally with:

```text
MERCHANT_CATALOG_VIEW
MERCHANT_CATALOG_MANAGE
MERCHANT_INVENTORY_VIEW
MERCHANT_INVENTORY_MANAGE
```

Expected MVP mapping:

```text
OWNER
  catalog view/manage
  inventory view/manage

MANAGER
  catalog view/manage
  inventory view/manage

PICKER
  catalog view
  inventory view
```

PICKER remains read-only in M5.

Do not create a database permission editor.

Backend capability enforcement is mandatory.

# Merchant APIs

Add only M5 APIs required by the merchant portal.

Conceptually:

```text
GET    /merchant/products
POST   /merchant/products
GET    /merchant/products/:id
PATCH  /merchant/products/:id
POST   /merchant/products/:id/publish-or-status
POST   /merchant/products/:id/images
DELETE /merchant/products/:id/images/:imageId

GET    /merchant/inventory
PATCH  /merchant/inventory/:inventoryItemId
```

Exact route structure should follow existing repository conventions and native workflow capabilities.

If a single product create/update route can coherently manage variant pricing/inventory, prefer that over an unnecessarily fragmented API.

Do not expose Medusa Admin API routes directly to merchant browsers.

Do not proxy merchant requests through native Admin HTTP routes.

Call backend modules/workflows directly.

# Pagination / search

Product listing should support practical server-side:

```text
pagination
basic text search
status filtering
```

Inventory listing should support:

```text
pagination
basic search by product/SKU
stock status filtering if straightforward
```

Do not build Elasticsearch or external search.

PostgreSQL/Medusa-native querying is sufficient for M5.

# Merchant UI

Implement the approved merchant routes:

```text
/merchant/products
/merchant/products/new
/merchant/products/[id]
/merchant/inventory
```

Use the established GoSpaza merchant portal shell.

Do not redesign the application.

## Product list

Show useful information such as:
- image/thumbnail;
- product title;
- status;
- variant count;
- stock summary;
- price range where useful.

OWNER/MANAGER:
- create/edit products.

PICKER:
- read-only.

## Product editor

Support:
- title;
- description;
- restricted/alcohol toggle backed by the compliance profile;
- images;
- variants/options;
- per-variant SKU;
- per-variant ZAR price;
- initial/current stocked quantity;
- draft/publish behavior.

The UI must make predefined weight variants easy to create without implying variable-weight pricing.

Do not add legal claims around alcohol compliance.

## Inventory page

Show variant-level rows with:
- product;
- variant;
- SKU;
- stocked quantity;
- reserved quantity where available;
- available quantity.

OWNER/MANAGER may adjust stocked quantity.

PICKER is read-only.

Use safe loading/error/empty states.

# Stock-location provisioning UI

Do not expose infrastructure provisioning controls to merchants.

Stock Location / Sales Channel provisioning is platform infrastructure.

If provisioning is missing/broken, show a safe operational error and log enough server-side context for diagnosis without exposing internal IDs unnecessarily.

# Security

Use `gospaza-security-review`.

Required protections include:
- applicant/non-member cannot use catalogue APIs;
- inactive member cannot use catalogue APIs;
- PICKER cannot mutate catalogue/inventory;
- client cannot choose merchant ID;
- client cannot choose Stock Location ID;
- client cannot choose Sales Channel ID;
- known Product ID from another merchant is rejected;
- known Variant ID from another merchant is rejected;
- known InventoryItem ID from another merchant is rejected;
- known image/media mutation against another merchant is rejected;
- product ownership is checked before every mutation;
- native Medusa Admin authentication is not exposed to merchant clients;
- upload validation is server-side;
- private application documents cannot be attached as public product images accidentally;
- DTOs do not leak marketplace internals, provider secrets, or unrelated tenant IDs.

# Concurrency and integrity

Add real-database coverage where appropriate for:
- idempotent Stock Location provisioning;
- idempotent Sales Channel provisioning if used;
- repeated existing-merchant backfill;
- product creation failure cannot leave an unowned accessible product;
- cross-merchant product update by known ID;
- cross-merchant inventory update by known ID;
- concurrent inventory quantity updates behave according to the selected native workflow semantics;
- invalid/negative stock rejected;
- product ownership uniqueness;
- one Stock Location per MerchantStore;
- one merchant Sales Channel per Merchant if used.

Do not replace these with mocks where the invariant depends on the database.

# Tests

## Commerce infrastructure

Cover:
- existing merchant backfill;
- future merchant provisioning path;
- repeat provisioning;
- native link creation;
- no duplicate locations/channels.

## Catalogue

Cover:
- OWNER create/update;
- MANAGER create/update;
- PICKER read-only;
- applicant denied;
- cross-merchant known-ID denied;
- Product -> Merchant ownership link;
- draft/published behavior;
- ZAR variant prices;
- predefined weight variants;
- compliance profile persistence.

## Inventory

Cover:
- Inventory Items/Levels are native Medusa records;
- correct merchant Stock Location;
- owner/manager stock update;
- picker read-only;
- negative invalid update rejected;
- cross-merchant inventory known-ID denied;
- available quantity remains derived from native inventory/reservations.

## Media

Cover:
- JPEG/PNG/WebP accepted;
- unsupported content rejected;
- >5 MB rejected;
- malformed/signature mismatch rejected where practical;
- cross-tenant media mutation rejected;
- safe cleanup on failure.

## Regression

Preserve M1-M4:
- authentication;
- applications;
- provisioning;
- team/RBAC.

## Browser

Add focused M5 coverage:
- owner creates a simple product;
- owner creates a product with 500g/1kg/2kg variants;
- manager edits product/stock;
- picker sees read-only catalogue/inventory;
- cross-role controls are absent but backend enforcement is still tested separately;
- image upload validation/error states;
- inventory update reflected in UI.

Keep browser coverage focused.

# Medusa ownership decision report

The completion report must explicitly state:
- Stock Location mapping used;
- Sales Channel mapping used and why;
- how Product -> Merchant ownership is represented;
- how MerchantStore -> Stock Location is represented;
- how Merchant -> Sales Channel is represented if used;
- native core workflows/services used for product creation/update;
- native inventory workflows/services used;
- native file handling used for public catalogue images;
- whether Product compliance requires a custom extension and why;
- why GoSpaza did not duplicate Product/Variant/Price/Inventory tables.

# Documentation

Update only M5-relevant docs:
- catalogue ownership topology;
- Stock Location / Sales Channel topology;
- merchant capability mapping;
- predefined weight-variant rule;
- manual stock management;
- image upload limits;
- backfill/provisioning behavior;
- new environment variables;
- verification commands.

Do not document M6+ features as implemented.

# Explicitly out of scope

Do NOT implement:
- service-zone configuration;
- customer location eligibility;
- customer marketplace discovery;
- customer search;
- cart creation;
- cross-store cart switching;
- checkout;
- scheduling;
- Yoco;
- customer orders;
- merchant order acceptance;
- picking;
- substitutions;
- live weight repricing;
- POS integrations;
- alcohol identity/age verification;
- driver onboarding;
- dispatch;
- delivery;
- OTP;
- commission calculations;
- merchant ledger;
- settlement;
- notifications;
- analytics/search infrastructure;
- merchant ownership transfer.

# Command / quota policy

Do not execute installs, migrations, Docker, lint, typecheck, tests, builds, dev servers, or other command-heavy verification.

If runtime output is genuinely required:
- give the user one minimal command;
- explain exactly what output is needed;
- stop until the user returns it.

At completion provide ordered `Commands for user to run`.

All PowerShell commands provided to the user must be single-line commands.

# Completion report

When implementation is complete, STOP and return:

```text
MILESTONE M5 COMPLETE

1. Implemented
- ...

2. Medusa ownership decisions
- Product ownership:
- Stock Location mapping:
- Sales Channel mapping:
- Inventory ownership:
- Public media:
- Compliance extension:

3. Merchant commerce provisioning
- Existing merchant backfill:
- Future approval integration:
- Idempotency:

4. Catalogue
- Products:
- Variants:
- Pricing:
- Status/publication:
- Media:

5. Inventory
- Inventory items:
- Inventory levels:
- Quantity mutation:
- Backorders:

6. RBAC / capabilities
- ...

7. Schema / module links / migrations
- ...

8. API routes / workflows
- ...

9. UI
- ...

10. Authorization / security
- ...

11. Tests added
- ...

12. Verification status
- Commands were not executed by Codex unless explicitly requested.
- User-supplied results already reviewed:
  - ...
- Still requiring user verification:
  - ...

13. Commands for user to run
1. `<single-line command>`
   - Purpose:
   - Expected result:
   - Stop on failure: yes/no

14. Explicitly NOT implemented
- ...

15. Known limitations
- ...

16. Files/modules materially changed
- ...
```

Stop after M5.
