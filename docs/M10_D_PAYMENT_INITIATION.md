# M10-D — Payment initiation and capacity commitment

Implementation is complete; verification is pending user-run commands. No commands, migrations, tests, builds, or live Yoco requests were executed by Codex. M10-A/B/C were reported verified by the user before this slice.

## Retention decision and pinned native ownership

Option B is implemented. One immutable Marketplace ProviderOperation belongs to one CheckoutAttempt. Native session IDs are append-only correlations, not external operation identity. Medusa 2.18.0 owns Payment Collections, Payment Sessions, Payments, Captures and Refunds. These custom records coordinate initiation/recovery and retain verified evidence; they are not a second financial ledger.

Pinned source inspected: Payment Module createPaymentSession, updatePaymentSession, authorizePaymentSession, capture/refund methods, Payment Collection create/upsert implementation, cart–collection link APIs, create-payment-sessions and refund-and-recreate workflows. Native creation allocates its session ID before the provider call and may delete that session after failure. Standard session replacement/compensation is therefore not used to initiate or recover a GoSpaza operation.

The operation is committed before public createPaymentCollections, which writes its operation marker into native metadata. Medusa 2.18 upsert with an ID is update-only, and native filters do not support metadata. Before any creation when the locator is absent, a single public list of native IDs/metadata checks for an already-created resource after a lost response. Duplicate markers fail closed. The returned native ID is then committed to the operation and validated before linking through Link.create. A closed attempt's cart link is detached through Link.dismiss, without deleting the old collection or its native resources. New attempts get separate operations and collections.

## Flow

1. Authenticated customer + current CartMarketplaceContext resolves cart ownership under the existing M8 customer advisory lock.
2. Strict Pay input accepts only cart_id, attempt_id, checkout_revision and confirmed: true. IDs are locators, not authority.
3. A CONFIRMED attempt revalidates the owned complete M6 address, serviceability, current reservation/slot/option identity, and the native cart against its immutable commercial snapshot.
4. M9 configuration/store/slot locks and fresh database time protect the atomic HELD → PAYMENT_PENDING transition. CheckoutAttempt and reservation receive the same deadline; the original HELD expiry remains unchanged.
5. The immutable request, amount, currency, credential fingerprint and stable Yoco key are committed with ProviderOperation before any external side effect.
6. Public Medusa collection/session APIs establish native resources. A one-use server permit binds the internally generated session ID durably before sending to Yoco.
7. The provider sends only the persisted request and key. The returned native session data carries the current session ID. Only an allowlisted hosted redirect is returned to the customer.
8. Repeated Pay reuses known state. Explicit retry may recover sending/uncertain initiation with the identical request/key. Neither path renews capacity.
9. Expiry closes the attempt and releases effective capacity; later evidence cannot reopen it. Historical resources remain available for M10-E compensation.

Frozen tariffs do not get recalculated at Pay. Scheduling's existing assignment selection is shared with a frozen-option validation path, which still rejects disabled or no-longer-serviceable destinations/options. Changed native totals or address require reconfirmation.

## Provider amendments from M10-B

- Independent operation identity and validated durable session associations.
- Immutable external request/key, including any already-sent legacy session metadata.
- Current native session_id preserved in returned data.
- Explicit recovery permits; copied native compensation data cannot create another session or checkout.
- Captured evidence can reconstruct a native session without another checkout POST, even if the initiation receipt was lost.
- Canonical session selection plus a permanently claimed financial session prevents historical associations from independently authorizing.
- The existing full technical-refund contract can address the verified checkout ID without requiring the lost initiation receipt. D's production operation store does not approve or execute refunds.
- updatePayment never creates a checkout; terminal-refunded operations cannot become payable.
- 422 mismatch remains a hard conflict. It never generates a replacement key.
- Existing exact money, ZAR, raw-body signature, redirect and fail-closed contracts remain.

The maintained local source keeps upstream SHA 0513eda8db1adcf00bcf1806c436954ab9134f69 and historical reference 019c3663a2208490cacbd272d2e8f3f289251624 in UPSTREAM.json. No dependency version changed.

## APIs and DTOs

- POST /store/gospaza/checkout/pay — explicit initial Pay or read/reuse of its existing operation.
- POST /store/gospaza/checkout/retry — explicit recovery of that same logical attempt.
- Existing checkout read/attempt read includes payment_deadline once committed.

The Pay result exposes attempt_id, ready/uncertain/expired/reconciliation_required, payment_deadline, and a safe redirect_url or null. Unknown initiation is HTTP 503, expired is HTTP 409, and known idempotency mismatch is HTTP 409. Browser redirects cannot authorize, capture, complete, or refund.

Existing native /store/carts, /store/payment-collections, /store/shipping-options and /hooks/payment restrictions remain in force, including the pp_yoco_yoco provider. No native completion or webhook bypass is enabled.

## Schema and concurrency

Migration20261004100000 adds provider_operation and provider_session, extends CheckoutAttempt and DeliveryReservation with PAYMENT_PENDING/payment_deadline, and extends active-reservation uniqueness/capacity accounting.

Constraints enforce one operation per attempt, unique native collection and external checkout references, immutable request/key/amount/config identity, append-only session associations, and canonical/financial session ownership. Once a session claims financial materialization, another session cannot replace it. Checkout snapshots and assigned deadlines remain immutable.

The customer advisory lock remains outermost, including native operations. Capacity transition additionally uses M9 slot locks and fresh PostgreSQL time. Occupancy excludes elapsed PAYMENT_PENDING deadlines even before lazy cleanup. Restoration refresh never renews expiry. A live commitment blocks cart edits, store switch, reservation replacement/release and abandonment; after expiry the existing mutable-cart rules resume.

No process-local state is required in production. Native payments are never written through SQL. Marketplace-owned SQL is confined to coordination/capacity records. Forward recovery preserves potentially payable resources instead of destructive workflow compensation.

## Security review

| SOURCE | TRANSFORMATION | TRUST BOUNDARY | SINK / protection |
| --- | --- | --- | --- |
| Customer cart/attempt/revision input | Strict schema; authenticated current-cart lookup | Browser → backend | Only owned current context can commit capacity or initiate |
| Forged amount, currency, merchant/store, collection/session, operation or redirect | Rejected extra fields | Browser → commercial authority | Native totals + frozen server snapshot build request |
| Native generated session ID | One-use permit → durable append-only association | Native resource lifecycle → external operation | Immutable request/key stays independent of session ID |
| Unknown transport / lost response | Persisted sending/uncertain state | External provider → backend | Explicit same-key recovery; never invented pending/success |
| Historical session / native compensation | Canonical + financial-session claim | Correlation → financial effect | Noncanonical authorization and unpermitted recreation fail |
| Deadline or later attempt | DB time + closed state + separate resources | Local expiry → payment/order eligibility | Old operation never becomes current or payable again |
| Verified capture fixture/provider evidence | Exact correlation, amount/currency/mode checks | Evidence → native reconstruction | No additional checkout; E must supply durable verified inbox and compensation |

D has no evidence-ingestion API. Trusted capture records in the integration verifier are fixture setup, not a webhook implementation. No payment truth comes from redirects or browser fields.

## Acceptance coverage

| Requirement | Coverage |
| --- | --- |
| Exact money/ZAR, signatures, redirects, captured/failed mapping, refund contract | Existing and extended tests/yoco-provider.test.ts |
| Default-disabled provider, bounded deadline, malformed configuration | tests/payment-initiation-policy.test.ts |
| Auth, foreign cart/attempt, forged authority fields, known native payment bypass | verify-payment-initiation.ts real HTTP |
| Double Pay and cart mutation vs Pay | Real concurrent service calls + simultaneous HTTP cart mutation; PostgreSQL locks/native resources |
| One operation, one external request for successful initiation | Durable rows/native session assertions with substituted external transport |
| HELD → PAYMENT_PENDING, immutable deadline, capacity beyond HELD expiry | Real DB transition, trigger rejection, occupied difference, restoration/release assertions |
| Frozen amount after tariff change | Real configuration mutation followed by Pay; snapshot amount retained |
| Native collection creation succeeds before locator persistence | Real native collection with immutable operation marker is adopted without creating another |
| Lost initiation response / native failed-session cleanup | Native service failure and cleanup; history remains; retry uses exact same request/key |
| Concurrent retries converge; no second payable checkout | Promise.all recovery, real database/session creation, transport key deduplication |
| Native compensation cannot create another checkout | Native createPaymentSession with copied consumed permit rejected before transport |
| Only one session materializes financially | Old-session authorization rejected; concurrent native canonical authorization; one Payment/Capture |
| Captured evidence without original session/receipt | Provider contract reconstruction; native reconstructed session with trusted fixture evidence |
| Pay waiting on the customer lock vs HELD expiry | Real advisory-lock gate; expire owned fixture before releasing lock; no operation may be created |
| Expired attempt never starts/reopens payment | Past-deadline database fixture; expired result, no POST, release, permit rejection |
| Later attempt preserves old native collection/session/correlation | Old captured fixture reconstruction retained while later attempt uses distinct resources |
| Terminal-refunded operation cannot become payable | Provider and native service rejection checks |

The external fixture substitutes Yoco transport only; it does not replace PostgreSQL, Medusa services, native session cleanup, capture creation, locks or HTTP ownership checks. It proves internal handling against the documented key contract, not Yoco's live availability or retention duration. Full process-kill/network-partition tests remain M25 work.

## Configuration and local verification

No installation is needed. Provider registration defaults off.

For this local verifier, copy the M10-D settings from apps/backend/.env.example into the existing apps/backend/.env and set YOCO_ENABLED=true. Keep the example's deliberately nonfunctional sk_test_verification key and signing secret, loopback return URLs and APP_ENV=development. Do not substitute a live key. The verifier rejects live mode and intercepts external Yoco requests inside its Medusa exec process; the HTTP backend is used for owned checkout setup and hostile-input tests. No valid Yoco account credential is required for these tests.

Keep PostgreSQL and Redis available. Apply migrations before restarting the backend with the new code/configuration. Use only isolated local verification data. The fixture removes its known native/custom records using the existing cleanup harness and reports cleanup errors.

All commands below run from repository root. Stop at any failure.

| Order | One-line command | Expected result |
| --- | --- | --- |
| 1 | pnpm run lint | No errors or warnings |
| 2 | pnpm run typecheck | All workspace checks pass |
| 3 | pnpm --filter @gospaza/backend exec tsx --test tests/yoco-provider.test.ts tests/payment-initiation-policy.test.ts | Existing M10-B and new D contract/policy tests pass |
| 4 | pnpm --filter @gospaza/backend run test | Backend unit regressions pass |
| 5 | pnpm --filter @gospaza/backend run build | Backend production build succeeds |
| 6 | pnpm run db:migrate | New Marketplace migration and native links complete |
| 7 | pnpm --filter @gospaza/backend run dev | Start/restart in another terminal; backend ready on 9000 |
| 8 | pnpm --filter @gospaza/backend run test:checkout-foundation | Existing M10-C verifier passes |
| 9 | pnpm --filter @gospaza/backend run test:payment-initiation | M10-D passed; no real Yoco checkout or refund sent |
| 10 | pnpm --filter @gospaza/backend run test:delivery-reservations | M9 reservation regressions pass |
| 11 | pnpm --filter @gospaza/backend run test:cart-mutations | M8 mutation regressions pass |

After verification, return YOCO_ENABLED=false and restart the backend. Do not enable live payments before remaining M10 reconciliation/completion and acceptance work is verified.

## Limits and next slice

M10-E remains responsible for the authenticated raw-body inbox, authoritative captured/failed reconciliation, deadline-vs-success serialization, native cart completion, late-success compensation and refund recovery. No D endpoint creates Orders, authorizes payment from a browser, applies a webhook, or executes a refund. M10-F owns checkout UI.

No expiry worker is added: effective occupancy stops at the database deadline immediately; lifecycle rows close on authoritative reads/operations. E must add its reconciliation scheduling as specified. Captured evidence is retained as a projection/correlation for native processing, not as a general financial ledger.

M25: native collection-marker readback scalability (the pinned public API lacks a metadata filter), global scheduling lock throughput, pool saturation, provider request/DB failure injection, lock timeout vs slow provider calls, historical archival, credentials rotation with pending operations, and provider idempotency retention/operational recovery. Recovery stays within the immutable local payment deadline; no unlimited provider retention is assumed. Changing the configured credential fails closed for old operations until an explicit recovery/rotation procedure is provided.

## Materially changed files

- Backend configuration: apps/backend/medusa-config.ts, apps/backend/package.json, apps/backend/.env.example, apps/backend/.env.production.example.
- Native/orchestration: apps/backend/src/lib/payment-initiation-service.ts, payment-initiation-http.ts, payment-native.ts, checkout-payment-links.ts, yoco-config.ts; existing checkout-native.ts, checkout-service.ts, cart-service.ts, delivery-reservation-service.ts, scheduling-service.ts.
- Workflow/API: apps/backend/src/workflows/initiate-checkout-payment.ts; apps/backend/src/api/store/gospaza/checkout/pay/route.ts and retry/route.ts.
- Marketplace: apps/backend/src/modules/marketplace/provider-operation-store.ts, service.ts, checkout-repository.ts, delivery-reservation-repository.ts; models/provider-operation.ts, provider-session.ts, checkout-attempt.ts, delivery-reservation.ts; migrations/Migration20261004100000.ts.
- Provider: apps/backend/src/modules/yoco/index.ts, registered-service.ts, request.ts, service.ts, types.ts, webhook.ts, UPSTREAM.json.
- Contracts: packages/contracts/src/checkout.ts.
- Verification: apps/backend/src/scripts/verify-payment-initiation.ts, verify-checkout-foundation.ts; apps/backend/tests/payment-initiation-policy.test.ts, yoco-provider.test.ts.
- Documentation: README.md, docs/M10_B_PROVIDER_COMPATIBILITY.md, docs/M10_D_PAYMENT_INITIATION.md.
