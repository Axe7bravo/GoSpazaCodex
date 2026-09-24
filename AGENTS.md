# GoSpaza — Master Codex Project Instructions

## 1. Project Purpose

GoSpaza is a South African on-demand grocery and alcohol delivery marketplace launching first in Bloemfontein, Free State.

The platform supports four primary product surfaces:
- Customer web app
- Merchant + Picker portal
- Driver app
- Platform Admin portal

The system is a multi-merchant marketplace, but each cart and each order belongs to exactly one merchant/store.

For MVP:
- One merchant = one physical store.
- Merchant companies with multiple branches are out of scope.
- Customers cannot mix products from multiple stores in one checkout.
- Merchants manage their own products, prices, stock, and pickers.
- Drivers may be merchant-affiliated or platform drivers.
- Dispatch is automatic and offer-based.
- Merchant payouts are calculated by the platform but physically paid manually by back-office staff.
- Customer storefront must support 0, 1, or multiple eligible merchants without awkward empty marketplace UI.

## 2. Architecture

Use a modular monolith.

Primary stack:
- MedusaJS v2 backend
- Next.js applications
- PostgreSQL
- Redis
- Docker
- TypeScript

Repository target:

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

Do not create microservices unless a future approved milestone explicitly requires them.

## 3. Medusa Ownership Rule

Before creating a custom commerce entity, first determine whether Medusa already owns that concern.

Prefer Medusa-native concepts for:
- Customers
- Products
- Product variants
- Pricing
- Inventory
- Stock locations
- Carts
- Orders
- Payments
- Promotions
- Fulfillment foundations
- Shipping options
- Store credit
- Authentication primitives

Do not build parallel sources of truth for Medusa-owned commerce concepts.

Custom GoSpaza entities should link to Medusa entities where required rather than duplicate them.

## 4. GoSpaza Custom Domains

The intended logical custom domains are:

```text
Marketplace
Order Operations
Delivery
Compliance
Finance
Configuration / Audit
```

These are logical domain boundaries inside one backend. Do not turn them into separate deployed services.

## 5. Actor Model

Four actor classes must remain distinct:

```text
customer
merchant
driver
platform user
```

Expected auth direction:
- Customers: Medusa customer/auth primitives.
- Merchant staff: custom merchant actor.
- Drivers: custom driver actor.
- Platform admins: platform user + explicit capabilities.

Never authorize merchant access from a merchant ID supplied by the browser alone.

Merchant context must be derived from the authenticated actor.

## 6. Merchant Tenant Isolation

Merchant isolation is a non-negotiable security invariant.

A merchant actor must never read or mutate another merchant's:
- products
- inventory
- orders
- team
- settings
- settlement data
- operational data

Every merchant-facing backend route must derive merchant identity from authentication and validate resource ownership server-side.

Hidden buttons are not authorization.

Tenant-isolation integration tests are required whenever new merchant-scoped APIs are added.

## 7. Customer Marketplace States

Customer storefront must gracefully support:

```text
0 eligible merchants
1 eligible merchant
2+ eligible merchants
```

Behavior:
- 0 merchants → dedicated no-service / unavailable state.
- 1 merchant → focused single-store shopping experience.
- 2+ merchants → marketplace discovery experience.

Do not show misleading sections such as “Popular stores near you” when only one store is eligible.

Do not implement a hard-coded deployment switch such as `SINGLE_STORE_MODE`.

The UI must derive the state from actual eligible merchants for the selected delivery address/service zone.

## 8. Responsive Design Rules

Customer app:
- Mobile-first.
- Fully responsive across mobile, tablet, laptop, and desktop.
- Desktop must take advantage of wider layouts rather than simply stretching mobile.
- Persistent cart is appropriate on desktop store pages.
- Checkout should use a two-column layout on desktop.
- Live order tracking should use wider map/timeline layouts where appropriate.

Merchant portal:
- Desktop/tablet-first.
- Picker workflows must be excellent on tablet/mobile.

Driver app:
- Strongly mobile-first.
- One dominant operational action per state.

Admin:
- Desktop-first.
- Dense operational tables, queues, filters, and split views are expected.

## 9. GoSpaza Visual Direction

Use the approved GoSpaza design direction:

- Warm off-white / cream backgrounds.
- Strong black / charcoal typography.
- Orange as the primary action and movement color.
- Green primarily for availability / success.
- Product photography carries retail personality.
- Rounded but not overly playful components.
- Clean, premium, distinctly local-commerce feel.
- Avoid generic SaaS-template visual language where possible.
- Do not redesign the GoSpaza logo unless explicitly instructed. Use the provided approved logo asset when available.

Shared primitives may live in `packages/ui`, but role-specific composites should remain role-specific.

## 10. Money Rules

All money values must use integer minor units.

Example:

```text
R109.99 -> 10999
R1.00   -> 100
```

Never use JavaScript floating-point arithmetic for settlement, commission, refunds, or financial ledgers.

Always retain currency code, initially:

```text
zar
```

## 11. Financial Modeling Rules

Financial state must be ledger-based and append-oriented.

Do not “fix” historical financial records by mutating old entries.

Create adjusting entries.

Customer store credit should use Medusa Store Credit where applicable.

GoSpaza finance may add business reasons / references around store-credit entries but must not build a separate wallet balance engine.

Merchant settlement economics must distinguish:
- merchandise sales
- merchant-funded discounts
- platform-funded discounts
- platform commission
- merchant-attributable refunds
- delivery fee
- merchant payable
- driver earnings

Important:

```text
customer delivery fee != driver earnings
customer total != merchant revenue
store credit used != discount
GMV != platform revenue
```

## 12. Marketplace Commission

Use effective-dated commission rules.

Do not store commission as an unversioned floating-point field.

Use basis points or another integer representation.

Example:

```text
1000 basis points = 10%
800 basis points = 8%
```

Historical orders/financial snapshots must retain the rate that applied at the relevant time.

## 13. Payment Rules

Yoco Hosted Checkout is the initial payment gateway.

GoSpaza must not store raw card credentials.

Do not assume payment success from browser redirect alone.

Authoritative payment/order state must come from backend/provider confirmation.

Payment webhooks must:
- be authenticated/verified as supported;
- be persisted;
- be idempotent;
- reject duplicate business effects.

Do not hard-code the original “115% pre-authorization” assumption.

Until a verified provider capability supports a higher-total substitution strategy, use a safe policy such as:

```text
NO_TOTAL_INCREASE
```

Payment-provider-specific logic must remain behind a stable integration/provider boundary.

## 14. Cart Rule

Hard invariant:

```text
1 cart = 1 merchant
1 order = 1 merchant
```

Cross-store add attempts must:
- never silently clear the cart;
- ask the customer whether to keep the existing cart or clear it;
- be enforced on the backend, not only in the UI.

## 15. Product / Weight Rule

MVP does not use variable final-weight repricing.

Products such as meat or produce use predefined variants:

```text
500 g
1 kg
2 kg
```

Each is a standard purchasable variant with its own price/inventory.

Do not build a custom `VariableWeightData` subsystem unless a future milestone explicitly reintroduces actual-weight commerce.

## 16. Substitution Rules

Supported preferences:

```text
BEST_MATCH
CONTACT_ME
DO_NOT_SUBSTITUTE
```

Rules:
- Original line item history must remain identifiable.
- Replacement must not erase the original item reference.
- `CONTACT_ME` expiry is owned by the backend.
- Picker may continue picking other lines while waiting.
- Default timeout fallback is `DO_NOT_SUBSTITUTE` unless configuration says otherwise.
- A late client response must not override an already-expired server state.
- Under `NO_TOTAL_INCREASE`, replacements may not create an unpaid higher total.

## 17. Order Operations

Medusa Order remains the commercial order.

GoSpaza may maintain a linked operational state model for marketplace fulfillment.

Do not replace Medusa order/payment primitives with custom duplicates.

Operational transitions must be explicit, validated, and auditable.

Never expose a generic “edit status” endpoint or admin dropdown that bypasses business rules.

## 18. Picking Rules

For MVP:

```text
1 order = 1 active picker
```

Picker claim/start must be atomic.

A second picker must not independently start the same order.

Picking cannot complete with unresolved lines.

Ordinary picker edits stop once picking is completed / order is ready for pickup, except through explicit recovery workflows.

## 19. Driver Dispatch Rules

Drivers:
- `PLATFORM`
- `MERCHANT`

Merchant delivery modes:
- `MERCHANT_ONLY`
- `PLATFORM_ONLY`
- `HYBRID`

Dispatch is server-controlled and offer-based.

Do not implement public first-come claiming.

Expected concept:

```text
filter eligible drivers
-> score candidates
-> offer best candidate
-> accept / decline / expire
-> next candidate if needed
```

For `HYBRID`, merchant drivers are prioritized before platform spillover according to configurable policy.

Scoring may consider:
- service-zone eligibility
- driver status
- merchant affiliation
- ETA to store
- idle duration
- workload
- restricted-order eligibility

Two drivers must never successfully accept the same delivery.

## 20. Driver Location

Do not persist high-frequency GPS updates directly to PostgreSQL.

Use Redis or another ephemeral mechanism for latest live location/presence.

Persist only meaningful/sampled events when necessary.

PostgreSQL remains authoritative for transactional delivery state.

## 21. Grocery Delivery Verification

Normal grocery delivery uses a server-generated delivery OTP.

Rules:
- Generated server-side.
- Bound to one delivery.
- Customer may view it only at the appropriate delivery stage.
- Driver API must never return the valid code.
- Store hash / safe verifier, not plaintext where avoidable.
- Rate-limit failed attempts.
- Single use.
- Controlled regeneration.
- Driver cannot skip OTP through a normal workflow.

## 22. Alcohol Compliance

Alcohol ordering and delivery are additional gates on the normal shopping flow.

Customer:
- must satisfy age-verification eligibility before purchasing alcohol.

Delivery:
- actual recipient must be verified at handoff;
- purchaser's prior verification does not verify a different recipient;
- alternate adult recipient may be nominated;
- verification must succeed before OTP;
- failed alcohol verification blocks delivery.

MVP rule for mixed grocery + alcohol order:
- failed alcohol verification means the entire order is not handed over;
- no partial grocery handoff.

Avoid storing raw identity documents or full ID numbers unless a later verified requirement explicitly requires it.

## 23. Refunds / Adjustments / Store Credit

Supported conceptual destinations:

```text
STORE_CREDIT
ORIGINAL_PAYMENT
MANUAL
```

One entitlement must not accidentally create duplicate compensation such as both store credit and card refund.

Financial adjustments must have idempotency protection.

Refund success must be based on authoritative backend/provider state.

## 24. Merchant Settlements

The platform collects customer money and manually pays merchants.

The application must:
- calculate merchant liabilities automatically;
- generate settlement statements;
- allow authorized admin approval;
- allow staff to record a manual bank transfer;
- record payment reference / date / optional proof;
- support negative carry-forward balances.

The application must not pretend it initiated a bank transfer when it merely recorded one.

Settlement states:

```text
DRAFT
READY_FOR_APPROVAL
APPROVED
PAID
RECONCILED
FAILED
```

Paid historical settlements are not rewritten by later refunds. Later refunds become new negative ledger entries in a later settlement period.

## 25. Driver Earnings

Driver earnings are a separate ledger.

Do not derive driver earnings merely by copying customer delivery fees.

Earnings creation must be idempotent.

A completed delivery must not create duplicate earning entries after retry/replay.

## 26. Service Zones

Initial launch is Bloemfontein, Free State, but do not hard-code Bloemfontein into business logic.

Launch area must be configuration/data.

Serviceability may depend on:
- customer address
- service zone
- merchant eligibility
- store status
- on-demand/scheduled availability
- alcohol restrictions

## 27. Redis

Redis may be used for:
- event bus
- workflow engine
- distributed locks
- queues
- cache
- rate limiting
- temporary offer timers
- substitution timers
- driver presence
- latest driver location
- realtime support

Redis is not the financial or order source of truth.

## 28. Workflows vs Events

Use workflows for important multi-step business mutations.

Examples:
- merchant approval
- checkout finalization
- complete picking
- assign driver
- complete delivery
- issue refund
- generate settlement

Use events for downstream notifications / reactions.

Examples:
- order accepted
- substitution requested
- driver assigned
- delivery arrived
- settlement ready

Do not implement critical transactions as fragile chains of asynchronous listeners.

## 29. Idempotency

Every retryable or financially sensitive operation must be idempotent.

Examples:
- payment webhook
- store-credit issuance
- original-payment refund
- merchant ledger creation
- driver earning creation
- settlement generation
- settlement approval where applicable
- payout recording
- OTP completion
- pickup completion
- driver offer acceptance

Use database uniqueness / constraints where appropriate, not only `if` statements.

## 30. Concurrency

Explicitly protect:
- last delivery slot
- merchant accept/reject race
- picker claim
- driver offer acceptance
- OTP completion
- refund issuance
- settlement generation
- payout recording

Concurrency behavior must be tested using real-database integration tests where possible.

## 31. API Boundaries

Prefer explicit actor-specific route families such as:

```text
/store/gospaza/*
/merchant/*
/driver/*
/admin/gospaza/*
```

Do not expose ORM entities directly.

Use role-appropriate DTOs.

The same delivery may have separate:
- CustomerDeliveryDTO
- DriverDeliveryDTO
- AdminDeliveryDTO

This helps prevent sensitive-field leakage.

## 32. File Storage

Use private object storage for sensitive files such as:
- merchant documents
- driver documents
- payout proof
- support attachments where applicable

Database stores metadata / storage keys.

Use signed, short-lived access where appropriate.

Do not expose sensitive uploads through public static URLs.

## 33. Audit

Sensitive operations require append-oriented audit events.

At minimum audit:
- merchant approval/rejection
- merchant suspension
- driver approval/suspension
- commission changes
- bank-detail changes
- refunds
- store-credit adjustments
- settlement approval
- payout recording
- manual dispatch/reassignment
- admin order overrides
- platform-wide operational toggles

Audit should answer:
- who
- what
- when
- why
- target entity
- prior state where appropriate
- resulting state

Do not dump full sensitive bank/document data into audit records.

## 34. Admin Safety

Do not expose generic unrestricted status editing.

High-risk actions require:
- authorization
- confirmation
- reason
- audit
- backend validation

Examples:
- suspension
- refund
- settlement approval
- payout recording
- commission change
- bank detail approval
- operational override

## 35. Realtime

Realtime improves latency but must not be required for correctness.

If realtime fails, polling/revalidation must keep the application usable.

Possible realtime events:
- order accepted/rejected
- substitution request/response
- driver offer
- driver assigned
- driver arrival
- delivery completion
- refund
- settlement

## 36. Notification Provider Abstraction

Business code requests notification events.

It must not directly couple core workflows to a specific provider.

Channels may include:
- in-app
- email
- SMS
- push

Notification failure must not roll back the primary business transaction.

## 37. Search

Do not introduce Elasticsearch/OpenSearch for MVP without demonstrated need.

Start with PostgreSQL-backed search suitable for initial catalogue scale.

Keep the application structured so search can be abstracted later.

## 38. Testing Standard

Every milestone must add the relevant tests.

Use:
- unit tests for pure domain logic;
- real-database integration tests for data integrity, tenant isolation, transactions, and concurrency;
- API tests for actor/auth behavior;
- browser E2E for critical user journeys.

Critical business rules should not rely only on mocked unit tests.

## 39. Security Standard

Always consider:
- server-side authorization
- actor isolation
- merchant tenant isolation
- input validation
- rate limiting
- OTP brute-force protection
- webhook verification
- private file access
- secret management
- admin MFA
- session invalidation
- financial idempotency
- audit logs

Never rely on frontend hiding as authorization.

## 40. Schema / Migration Rules

Every schema change requires a migration.

Do not manually edit production database structure.

Use foreign keys and unique constraints where business invariants require them.

Do not physically delete historically referenced financial/order entities merely because the UI says “remove”; archive/supersede instead where appropriate.

## 41. No Future-Scope Leakage

This rule applies to every milestone:

> Implement only the requested milestone and the minimum infrastructure required to support it.

Do not pre-build later milestone features merely because they seem convenient.

Examples:
- Do not build dispatch during catalogue work.
- Do not build settlements during payment integration.
- Do not build full admin finance screens during merchant onboarding.
- Do not add speculative provider integrations.

Future-compatible schema design is allowed. Future feature implementation is not.

## 42. Command Execution / Quota Policy

To conserve Codex quota, Codex should focus on **inspection, reasoning, and code edits**.

Unless the user explicitly asks Codex to execute commands, Codex must **NOT** run command-heavy verification or environment operations, including:

- dependency installation (`npm install`, `pnpm install`, etc.);
- builds;
- linting;
- typechecking;
- automated tests;
- database migrations;
- database seed commands;
- Docker / Docker Compose commands;
- dev servers;
- long verification scripts;
- infrastructure startup/shutdown commands.

If implementation requires information that can only be learned by executing a command:

1. Do not guess.
2. Give the user the exact minimal command to run.
3. Explain what output is needed.
4. Stop and wait for the user to return the result before making a decision that depends on it.

Short, non-command file inspection performed through the coding environment is allowed and expected.

At the end of each milestone, Codex must provide an ordered **Commands for user to run** section containing only the commands needed to verify that milestone.

Order commands so that cheap/fast failures are found before expensive checks where practical.

For every command include:
- the working directory if not repository root;
- the exact command;
- what successful output/behavior should look like;
- whether a failure should stop the verification sequence.

Codex must not claim that lint, typecheck, tests, migrations, builds, Docker startup, or runtime verification passed unless the user has supplied successful output from those commands in the current workflow.

When the user returns command output:
- inspect the output;
- make only the fixes justified by the output;
- provide the next minimal command(s) to rerun;
- do not rerun the commands yourself unless explicitly asked.

## 43. Milestone Completion Standard

A milestone is not complete because the happy path works.

For relevant features include:
- database changes
- migrations
- service/domain logic
- workflows
- API routes
- authentication
- authorization
- validation
- error handling
- loading/empty/error UI states
- concurrency handling
- idempotency
- audit behavior where applicable
- unit tests
- integration tests
- E2E tests where appropriate
- typecheck
- build verification

## 44. Required Milestone Completion Report

Every milestone must end with:

```text
MILESTONE X COMPLETE

1. Implemented
- ...

2. Schema / migrations
- ...

3. API routes / workflows
- ...

4. UI
- ...

5. Authorization / security
- ...

6. Tests added
- ...

7. Verification status
- Commands were not executed by Codex unless explicitly requested.
- User-supplied verification results already reviewed:
  - ...
- Still requiring user verification:
  - ...

8. Commands for user to run
1. `<command>`
   - Purpose:
   - Expected result:
   - Stop on failure: yes/no
2. ...

9. Explicitly NOT implemented
- ...

10. Known limitations
- ...

11. Files/modules materially changed
- ...
```

If something failed, report it honestly instead of claiming completion.

## 45. Stop Rule

After completing a milestone, STOP.

Do not begin the next milestone.

Return the completion report and wait for review/instructions.

## 46. Product Scope Authority

When instructions conflict, use this order of authority:

1. Current milestone prompt
2. This `AGENTS.md`
3. Approved GoSpaza PRD / UX specification
4. Existing code behavior, if it does not contradict 1–3

If a material ambiguity remains, state it rather than inventing a business rule.
