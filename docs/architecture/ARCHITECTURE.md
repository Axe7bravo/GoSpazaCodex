# GoSpaza — Technical Architecture

## Shape

GoSpaza is a modular monolith.

```text
apps/
  backend/
  customer/
  merchant/
  driver/
  admin/

packages/
  ui/
  contracts/
  api-client/
  config/
  test-utils/
```

Backend stack:
- MedusaJS v2
- PostgreSQL
- Redis
- TypeScript
- Docker local infrastructure

## Production Medusa processes

The same backend codebase is deployed in separate Medusa modes:

```text
development: shared
production API: server
production background process: worker
```

The worker is essential for scheduled jobs, subscribers and background processing such as dispatch expiry, substitution expiry, notifications, scheduled-order activation and settlement generation.

## Medusa ownership

Prefer Medusa-native ownership for:

```text
Customer
User
Product
ProductVariant
Price
Inventory
StockLocation
Cart
Order
Payment
Promotion
Fulfillment foundations
Shipping options
Store Credit
Authentication primitives
```

Custom GoSpaza domains:

```text
Marketplace
Order Operations
Delivery
Compliance
Finance
Configuration / Audit
```

Do not create duplicate sources of truth for Medusa-owned commerce concepts.

## Authentication actors

```text
customer      -> Medusa customer actor
platform user -> Medusa user actor
merchant      -> custom Medusa auth actor
driver        -> custom Medusa auth actor
```

Authentication identity does not itself grant merchant tenancy or driver operational eligibility.

## Marketplace

Initial custom entities include application/onboarding state, then merchant membership/provisioning in later milestones.

Merchant scoping is derived from authenticated actor membership, never from a browser-supplied merchant ID.

## Order operations

Medusa Order remains the commercial order.

GoSpaza uses linked operational state for marketplace fulfilment where needed.

Single-merchant context is enforced server-side:

```text
CartMarketplaceContext
  medusa_cart_id UNIQUE
  merchant_id
```

## Scheduling

Use delivery-slot records and transactional reservation protection. Last-slot races must have exactly one winner.

## Substitutions

Use a custom `SubstitutionRequest` that preserves original/replacement references, price snapshot, preference, state, expiry and response.

Initial safe payment policy:

```text
NO_TOTAL_INCREASE
```

## Delivery

Core custom concepts:

```text
Driver
DriverVehicle
DriverDocument
Delivery
DeliveryOffer
```

Offers have their own lifecycle. Only one offer may become accepted for a delivery.

Latest high-frequency driver location belongs in Redis rather than PostgreSQL. Persist meaningful/sampled location events only where necessary.

Use geospatial support such as PostGIS where justified for service-zone and candidate filtering.

## Compliance

Separate:
- customer age eligibility;
- delivery recipient verification.

OTP records contain a hash/verifier rather than exposing plaintext to drivers.

## Finance

Use integer minor units and currency code.

Key custom concepts:

```text
MarketplaceOrderFinancial
MerchantLedgerEntry
Settlement
DriverEarningEntry
FinancialAdjustment
PaymentWebhookEvent
```

Merchant and driver financial records are append-oriented. Historical paid settlement records are not rewritten by later refunds.

## Redis

Redis may support:
- Medusa event bus;
- workflow engine;
- distributed locking;
- queues;
- cache;
- rate limiting;
- dispatch timers;
- substitution timers;
- driver presence/location;
- realtime support.

PostgreSQL remains authoritative for transactional state.

## API families

```text
/store/gospaza/*
/merchant/*
/driver/*
/admin/gospaza/*
```

Use actor-specific DTOs to avoid sensitive-field leakage.

## Realtime

Realtime improves latency but is not required for correctness. Critical screens must revalidate/poll as fallback.

## File storage

Sensitive documents use private storage. Database stores metadata/storage keys. Production design should support private S3-compatible storage and authorized short-lived access.

## Testing

Use:
- unit tests for pure logic;
- real-database integration tests for transactions, tenant isolation and concurrency;
- API tests for auth/actor boundaries;
- browser E2E for critical journeys.

Command-heavy verification is run by the user, not Codex, unless explicitly requested.
