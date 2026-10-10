# M10-E — verified reconciliation and native completion

Implementation is ready for user verification. No commands, migrations, tests, or builds were run by Codex. M10-A through M10-D were reported verified by the user. M10-F/M11 are not implemented.

## Native ownership and approved recovery boundary

Medusa 2.18.0 owns Cart, Payment Collection, Payment Session, Payment, Capture, Refund, Order, inventory reservations and their native links. Marketplace owns the verified inbox, dispatch coordination/terminal receipt and one full technical compensation instruction per ProviderOperation. These records are not a payment ledger.

Pinned sources inspected:

- core-flows/dist/cart/workflows/complete-cart.js: complete-cart is stored, non-idempotent, with three-day terminal retention. Order creation precedes link/payment/inventory completion.
- workflows-sdk/dist/helper/workflow-export.js: run accepts context.transactionId.
- workflow-engine-redis/dist/utils/workflow-orchestrator-storage.js: persisted workflow/transaction/run identity, execution/context and lifecycle; rerunning a non-idempotent terminal execution can start another run.
- payment/dist/services/payment-module.js: authorize captured evidence creates native Payment/Capture; provisional Refund creation precedes the provider call and is removed on a thrown provider failure.
- medusa/dist/subscribers/payment-webhook.js: native webhook processing can invoke automatic completion; the registered GoSpaza provider returns not_supported for this path.

The guarantee is **at-most-one GoSpaza native completion dispatch per attempt**, followed by one accepted terminal commercial outcome. It is not automatic exactly-once recovery of every native write. The dispatcher commits a workflow ID, transaction ID, input fingerprint and one-way dispatch timestamp before calling completeCartWorkflow. Duplicate workers only inspect that designated execution. They never call run/resume/retry/cancel as recovery.

Exact execution ID/run ID and sanitized unresolved step/action state are retained when available. A done execution must also pass native Order/cart/payment-collection/canonical Payment/full Capture/capture-transaction/customer/channel/items/address/shipping/totals readback. Only then are the permanent terminal receipt, COMPLETED attempt and COMMITTED reservation published atomically.

Missing history, multiple runs, invoking/waiting/compensating, contradictory readback, and unproven failed/reverted outcomes become RECOVERY_REQUIRED. Failed/reverted is not evidence of a successful refund or of complete native compensation. No automatic refund follows a dispatched completion in this slice. Operational investigation must establish its terminal commerce/financial outcome; broad admin recovery tooling is deferred.

RECOVERY_REQUIRED retains the cart freeze, accepted-payment association and capacity after the deadline and after native history expires. It cannot replace/retry checkout, redispatch completion, release capacity or initiate a technical refund. Read-only inspection may recognize a subsequently proven done execution and publish its terminal receipt. Once SUCCEEDED, the receipt remains sufficient for GoSpaza's accepted outcome even when native workflow history has expired.

## Webhook and reconciliation flow

POST /hooks/gospaza/yoco preserves at most 64 KiB of raw request bytes. The existing HMAC verifier checks webhook ID/timestamp/signature with the existing 180-second clock window before parsing or persistence. The inbox stores normalized signed evidence and its fingerprint, not credentials, raw addresses or unsigned wrapper data. Event ID uniqueness deduplicates deliveries; the same event ID with different normalized evidence is rejected.

A scheduled forward-only workflow processes inbox events, then pending provider operations. It uses the existing customer PostgreSQL advisory boundary and slot row locks. Fresh database time after locking decides whether payment.succeeded may be accepted. The event is correlated with immutable operation identity, account fingerprint, amount, ZAR, environment, checkout and optional historical session association. Accepted success cannot be overwritten by a later failure.

Before the payment deadline, acceptance marks the attempt and reservation durably. After expiry/supersession, capture remains historically correlated but can never regain Order eligibility. payment.failed closes only an unaccepted pending attempt and releases its commitment. It does not undo an accepted capture.

Native financial reconciliation uses the selected canonical session and public Payment APIs. No native commerce tables are written directly. The existing provider reconstructs a session from captured evidence without another checkout POST. An ambiguous partial native financial write fails closed.

## Technical compensation

Only a closed, never-accepted, never-dispatched attempt with verified capture qualifies for automatic full technical compensation. Database approval constraints enforce this boundary. Native collection/Order relationships are checked; absence of a link is not used to authorize recovery after a completion dispatch.

The instruction retains an immutable full amount, provider payment reference, native Payment reference, request and refund idempotency key. Pending/unknown Yoco responses are not success. Reconciliation checks native provisional Refund state before retrying the identical external request/key. A verified refund.succeeded event can settle a pending/lost response without inventing a provider refund ID. Native Refund and authoritative provider evidence must both agree before terminal_refunded is recorded. A native refund whose progress is ambiguous is retained for recovery, not duplicated. A 422 mismatch retains the same operation and requires recovery; no new key is generated.

## Security traces

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Enforcement |
| --- | --- |
| Internet webhook → raw-byte HMAC/time verification → verified inbox → financial reconciliation | Invalid signatures never persist; signed but mismatched operation/amount/environment never become payment authority. |
| Verified operation → immutable checkout snapshot → customer advisory lock + slot lock → payment acceptance | Fresh DB deadline, current context and matching pending reservation; expired attempts never become eligible again. |
| Duplicate worker → persisted completion identity → atomic READY claim → native completeCartWorkflow | Only the claim winner dispatches. Every later call performs exact native readback. |
| Late capture → closed-attempt/native financial readback → database compensation approval → native full refund/provider adapter | No accepted/recovery/dispatched attempt can receive automatic approval; exact immutable request/key and verified terminal evidence. |
| Browser/native webhook route → blocked native routes/registered provider → native automatic completion | Native Order reads are also blocked: an Order row can appear before terminal validation. Existing native cart/payment paths remain blocked; native subscriber receives not_supported even for previously queued events. |

## Coverage matrix

| Invariant | Coverage |
| --- | --- |
| Raw signature, timestamp, exact ZAR/minor units | Existing yoco-provider.test.ts plus payment-reconciliation.test.ts; real HTTP invalid signature in verifier |
| Durable inbox deduplication and conflicting replay | verify-payment-reconciliation.ts concurrent receive/apply and signed conflicting event |
| Amount/environment/checkout correlation | Verifier hostile signed payloads; existing provider contract cases |
| Captured native Payment/Capture and canonical session | Existing M10-D verifier plus M10-E real native reconciliation |
| Duplicate worker cannot dispatch another run | Real database claim race, simultaneous reconciliation, exact native execution count and one Order |
| done → COMMITTED after missing GoSpaza terminal write | Verifier runs the designated native execution once, omits terminal publication, then reconciles concurrently |
| Native completed_at is not a replacement-cart permit | Verifier attempts a new add before terminal publication |
| Missing execution after dispatch | Real claimed marker without a native execution; repeated reconciliation remains RECOVERY_REQUIRED |
| Invoking/waiting/reverted/failed fail closed | Pure observation/disposition cases used by production; real missing-history freeze integration |
| Exact transaction/execution/run inspection | Pure mismatch tests plus real persisted native execution and terminal receipt |
| Recovery cannot retry/release/refund | Real service and database-constraint assertions; no additional provider requests |
| Recovery capacity outlives deadline/history retention | Real occupied query at a future database-derived time; durable recovery remains with no native history |
| Late success vs expiry | Concurrent real customer-locked expiry and inbox application for an already-expired commitment |
| Pending/uncertain refund and duplicate reconciliation | Fake external transport only; real native Payment/Refund, durable verified refund event, and lost-response replay with identical request/key |
| Native bypass | Real HTTP native hooks/cart-complete/payment-session rejection and registered provider subscriber rejection |
| Earlier initiation/refund compatibility | Existing M10-B provider contract and M10-D real-database verifier must be rerun |

No test kills a real process in every native-write/checkpoint window or deletes Medusa workflow history. Those infrastructure fault drills remain M25. Tests do not pretend that mocked native execution represents real database recovery.

## Verification setup and commands

Run from repository root. Stop on every failure. Keep Yoco in test mode with the existing nonfunctional local verification credentials; the integration verifier substitutes only external Yoco transport. No real charge/refund is sent by the verifier.

For isolated integration verification set PAYMENT_RECONCILIATION_WORKER_ENABLED=false in apps/backend/.env, and restart the backend after migration so the HTTP process and verifier both read that setting. This prevents the separate backend worker from racing the verifier's process-local fake external transport. Production rejects disabling the worker. Restore true after verification and restart the backend for normal operation.

1. pnpm run lint — no lint errors/warnings.
2. pnpm run typecheck — all workspace typechecks pass.
3. pnpm --filter @gospaza/backend exec tsx --test tests/yoco-provider.test.ts tests/payment-initiation-policy.test.ts tests/payment-reconciliation.test.ts — provider compatibility and reconciliation policy tests pass.
4. pnpm run db:migrate — apply the new M10-E migration and native link synchronization.
5. pnpm dev — use the normal development terminal; wait for backend readiness, then run remaining commands in another terminal.
6. pnpm --filter @gospaza/backend run test:payment-reconciliation — real database/API/native completion/refund checks pass.
7. pnpm --filter @gospaza/backend run test:payment-initiation — M10-D compatibility passes.
8. pnpm --filter @gospaza/backend run test:checkout-foundation — M10-C freeze/shipping regression passes.
9. pnpm --filter @gospaza/backend run test:delivery-reservations — M9 capacity/expiry regression passes.
10. pnpm --filter @gospaza/backend run build — backend production compilation succeeds.

All commands are single-line PowerShell-compatible commands. No dependencies were added.

## Residual risks / M25

- Ambiguous synchronous native writes require operational investigation. There is deliberately no compatibility extension or automatic second completion run.
- Failed/reverted executions remain protected until independent native commerce and financial proof is established; no automatic post-dispatch refund is claimed.
- A provisional native Refund left by process loss may require recovery. It is never treated as provider refund success on existence alone.
- Worker/connection-pool load, cross-store scheduling lock contention, webhook inbox retention/archival, infrastructure kill drills, provider outage monitoring and operational recovery tooling remain hardening work.
- Configure Yoco to deliver payment and refund events to the dedicated ingress; redirects remain UX only.

No customer checkout UI, M10-F, M11 operations, general refund product, dispatch or settlement work is included.

## Materially changed files

- README.md
- apps/backend/.env.example
- apps/backend/.env.production.example
- apps/backend/medusa-config.ts
- apps/backend/package.json
- apps/backend/src/api/middlewares.ts
- apps/backend/src/api/hooks/gospaza/yoco/route.ts
- apps/backend/src/jobs/reconcile-yoco.ts
- apps/backend/src/lib/cart-service.ts
- apps/backend/src/lib/checkout-native.ts
- apps/backend/src/lib/checkout-service.ts
- apps/backend/src/lib/completion-native.ts
- apps/backend/src/lib/delivery-reservation-service.ts
- apps/backend/src/lib/payment-initiation-service.ts
- apps/backend/src/lib/payment-reconciliation-service.ts
- apps/backend/src/lib/yoco-config.ts
- apps/backend/src/modules/marketplace/checkout-repository.ts
- apps/backend/src/modules/marketplace/completion-repository.ts
- apps/backend/src/modules/marketplace/delivery-reservation-repository.ts
- apps/backend/src/modules/marketplace/migrations/Migration20261006000000.ts
- apps/backend/src/modules/marketplace/models/checkout-attempt.ts
- apps/backend/src/modules/marketplace/models/checkout-completion.ts
- apps/backend/src/modules/marketplace/models/delivery-reservation.ts
- apps/backend/src/modules/marketplace/models/provider-operation.ts
- apps/backend/src/modules/marketplace/models/technical-compensation.ts
- apps/backend/src/modules/marketplace/models/yoco-inbox.ts
- apps/backend/src/modules/marketplace/provider-operation-store.ts
- apps/backend/src/modules/marketplace/reconciliation-types.ts
- apps/backend/src/modules/marketplace/service.ts
- apps/backend/src/modules/yoco/registered-service.ts
- apps/backend/src/modules/yoco/service.ts
- apps/backend/src/modules/yoco/types.ts
- apps/backend/src/modules/yoco/webhook.ts
- apps/backend/src/scripts/verify-payment-reconciliation.ts
- apps/backend/src/workflows/reconcile-yoco-payment.ts
- apps/backend/tests/payment-reconciliation.test.ts
- packages/contracts/src/checkout.ts
- docs/M10_E_RECONCILIATION.md
