> M10-D amendment: session binding now uses durable append-only associations and a session-independent immutable operation. See [M10-D](M10_D_PAYMENT_INITIATION.md) for the current contract and conditional registration. The report below records the original B slice.

# M10-B — Yoco provider compatibility

Implementation prepared; user verification pending. No commands were run by Codex.

## Baseline and integration status

The maintained derivative is prepared in apps/backend/src/modules/yoco, starting
from Nolunga/medusa-payment-yoco 1.2.0 at
0513eda8db1adcf00bcf1806c436954ab9134f69. The original MIT notice is retained.
The historical fork at 019c3663a2208490cacbd272d2e8f3f289251624 was inspected only
as a regression reference. Neither reference snapshot was modified.

This is local fork preparation, not a published remote fork or dependency pin.
UPSTREAM.json records the exact source baseline. Before production integration,
pin the resulting maintained fork commit (not merely the upstream baseline).
No package dependencies, lockfile, Medusa registration or environment defaults
were changed. Medusa remains pinned to 2.18.0. The provider is not reachable
through native Store/payment/webhook routes because it is not registered.

The standard ModuleProvider export and AbstractPaymentProvider implementation are
prepared. This slice does not activate payment processing or customer checkout.

## Native ownership and inspected contract

Inspected installed types/payment/provider.d.ts, types/payment/mutations.d.ts,
utils/payment/abstract-payment-provider and payment/services/payment-module.
Medusa owns sessions, collections, payments, captures and refunds. The provider
only translates the external API and requires an internal operation-store port.
There is no custom commerce schema in this slice.

Medusa injects data.session_id and may delete that session after initiation
failure. Native refund errors may delete the temporary refund row. Neither
native session IDs nor transient refund IDs alone can safely identify uncertain
external operations. The operation-store contract survives both cleanup paths.

Amounts reuse Marketplace's existing minorPrice/nativePrice boundary; native
BigNumber/raw_amount inputs are normalized through Medusa's public BigNumber.
No second arithmetic implementation or floating-point multiplication is added.

## Provider behavior

- Initiation requires an already-prepared internal operation matching the exact
  native session. Operation/attempt/cart/collection/session/checkout/payment IDs
  remain distinct. Browser-like status, redirect and authority fields are ignored.
- A committed atomic claim stores the exact outgoing JSON before HTTP. The
  provider uses the prepared operation key, not a random key or amount-derived key.
- Completed initiation returns the stored checkout. In-flight/uncertain operations
  fail explicitly; they do not issue another POST. A changed amount or request
  requires reconfirmation. There is no automatic retry policy.
- updatePayment never contacts Yoco. It only accepts the unchanged amount/currency.
- Status/capture use trusted persisted verified evidence. No undocumented checkout
  GET is used. A confirmed created checkout awaiting evidence is pending; missing
  or uncertain external state throws. A completed checkout response alone is not
  sufficient for capture.
- Verified payment.succeeded maps to captured; payment.failed maps to the native
  error status and failed webhook action. The webhook amount is converted back
  to native major units, not passed through as cents.
- Refunds require a separately approved full technical-compensation record bound
  to the captured payment. One stable key survives changing native refund IDs.
  Partial/unapproved refunds are rejected. Only succeeded returns success;
  pending/uncertain throws a typed recovery result so Medusa cannot record success.
- deletePayment permits native cleanup but never deletes external correlation.
  cancelPayment fails explicitly: no remote cancellation capability was proven.
- The API origin is fixed; redirects are not followed by transport. Return URLs
  come only from validated server configuration. HTTPS is required except test-key
  loopback development. Hosted checkout redirects must use https://c.yoco.com.
- Provider errors are fixed safe codes. No secrets, raw webhook content, provider
  error bodies or identifiers are logged.

## Webhook boundary

verifyYocoEvent validates exact raw bytes, required headers, a 180-second signing
window, versioned HMAC-SHA256 signatures and constant-time digest equality before
parsing. It parses the authenticated raw body, not a separately supplied parsed
wrapper. Only supported payment events are normalized; unrelated verified event
kinds return not_supported. Malformed/tampered events fail closed.

SOURCE: untrusted HTTP bytes/headers
-> TRANSFORMATION: signature/timestamp check, schema normalization
-> TRUST BOUNDARY: compare stored session/operation/checkout/amount/currency/mode
-> SINK: typed provider action, with no dispatch or business effect in this slice.

Provider input follows the separate boundary:
SOURCE: native input.data (potentially containing browser fields)
-> TRANSFORMATION: extract operation/session lookup only
-> TRUST BOUNDARY: compare trusted prepared operation and native amount/currency
-> SINK: fixed Yoco endpoint with immutable payload and durable operation key.

## Required later integration gates

M10-D/E must implement YocoOperationStore durably. There is intentionally no
production in-memory implementation. Construction without the port fails.

The adapter must enforce in PostgreSQL:

- immutable operation identity, key, session and confirmed commercial terms;
- atomic prepared-to-sending claims committed before external calls;
- exact request preservation and uniqueness of external correlation;
- one full compensation identity per captured payment;
- monotonic receipt persistence, retaining verified success over older evidence;
- survival of native cleanup, restart and ambiguous provider outcomes;
- payment evidence written only from verified, correlated durable inbox receipts.

A process crash after claim is uncertain, not permission to reset to prepared.
Reconciliation must establish the external outcome before any permitted recovery.
Contract-test mocks do not prove these database properties.

Before replacement attempts, resolve the milestone's native payment-resource
lifecycle gate; this slice does not adopt a replacement session or destroy an old
correlation. The current provider deliberately rejects a different native session.

Before activation, protect native payment/session/completion routes and native
Yoco hooks. Use dedicated GoSpaza ingress and durable inbox in M10-E. Do not send
provider actions to native automatic cart completion: deadline/late-payment and
capacity decisions must precede commercial effects. Never expose provider data
verbatim as customer DTOs. Handle cancellation/uncertainty explicitly in recovery.

The operation store must be explicitly wired into the payment provider container
through supported Medusa integration; do not assume the payment module can resolve
a sibling module automatically. No container wiring is claimed or enabled here.

## Contract coverage

All coverage is in apps/backend/tests/yoco-provider.test.ts and is included by the
existing backend test glob. All HTTP is mocked; no real payment or refund occurs.

| Invariant | Coverage |
| --- | --- |
| Precise money / ZAR | String, number, BigNumber, raw amount; sub-cent, unsafe, negative, zero, non-ZAR, double-conversion mismatch |
| Identifier separation | Native data.session_id; foreign session/operation/checkout; forged input fields |
| Stable initiation | Stored request/key; completed replay across provider instances; changed request rejection |
| Uncertainty | Lost response, HTTP/JSON errors, failed claim, failed receipt persistence, no blind second POST |
| Update safety | Same amount preserves data; changed amount/currency rejects; no additional checkout |
| Native provider contract | IPaymentProvider type assignment and real public BigNumber inputs |
| Capture authority | No evidence cannot capture; completed creation alone insufficient; verified success captured |
| Webhooks | Raw-byte signatures, timestamps, wrong secret, tampering, envelope, mode/currency/amount/known-ID correlation |
| Failure events | Failed action and native error, never captured |
| Technical refunds | Full approved amount; stable key despite new native refund IDs; pending then verified completion; uncertainty, wrong receipt and partial rejection |
| Claim concurrency | Simultaneous adapter initiation/refund calls send one POST using an atomic contract fixture |
| Cleanup | Session deletion retains external correlation; cancellation does not manufacture external success |
| Redirect boundary | Fixed allowlisted HTTPS, test-only loopback HTTP, hostile origin/credentials/placeholders rejected |

## Commands for user to run

All commands run from repository root, one line each. Stop on any failure.

1. pnpm exec eslint apps/backend/src/modules/yoco apps/backend/tests/yoco-provider.test.ts --max-warnings 0
   Expected: no errors or warnings.
2. pnpm --filter @gospaza/backend run typecheck
   Expected: no TypeScript errors, including the pinned provider interface checks.
3. pnpm --filter @gospaza/backend exec tsx --test tests/yoco-provider.test.ts
   Expected: all provider contract tests pass; no server, database or credentials needed.
4. pnpm --filter @gospaza/backend run test
   Expected: all existing and new backend unit tests pass.
5. pnpm --filter @gospaza/backend run build
   Expected: backend production build succeeds.

No installation, migration, live Yoco operation or browser test is needed for this
inactive provider-only change. Database concurrency, recovery and live sandbox
acceptance remain required in the owning later slices; they are not claimed here.

## Official external contract references

- https://developer.yoco.com/api-reference/checkout-api/checkout/create-checkout
- https://developer.yoco.com/api-reference/checkout-api/checkout/refund-checkout
- https://developer.yoco.com/guides/online-payments/webhooks/verifying-the-events
- https://developer.yoco.com/api-reference/checkout-api/webhook-events/payment-notification

The provider uses documented checkout/refund POST contracts and signed payment
events. Real sandbox behavior remains unverified. M10-C and all later slices were
not implemented.
