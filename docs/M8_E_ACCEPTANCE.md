# M8-E acceptance coverage

Implementation complete; new assertions still require user verification. No commands were executed by Codex. The user reported M8-A through M8-D tests and the production build passing before this slice.

## Coverage matrix

F = apps/backend/src/scripts/verify-cart-foundation.ts (real database/services and HTTP).
M = apps/backend/src/scripts/verify-cart-mutations.ts (real concurrent HTTP, native workflows and database assertions; invokes F).
B = tests/browser/cart.spec.ts (deterministic browser API fixtures).
C = packages/api-client/tests/cart.test.ts.
E = apps/backend/tests/cart-errors.test.ts.

| Invariant | Acceptance coverage |
| --- | --- |
| Authenticated restoration | F: anonymous GET 401, owner restoration with/without hint, foreign hint 404 |
| Lazy creation | F: empty restoration creates zero native carts |
| Same-store first initialization | F: simultaneous ensureFirstCart calls converge; one native cart, one current context, quantity one |
| Different-store first initialization | F: simultaneous calls produce one success and one rejection, one native cart |
| Same-store adds | M: concurrent first adds quantity two; subsequent concurrent adds quantity seven |
| Cross-store rejection | M: different-store race loser has 409 CART_MERCHANT_CONFLICT; bound-cart rejection preserves quantity |
| Explicit switching | M: confirm false rejected; valid switch returns separate cart; B: conflict/keep/confirm journey |
| Stale/superseded rejection | F: orphan hint stale and orphan mutations rejected; M: old add/update/remove/switch IDs rejected |
| Foreign cart ID | F: foreign restoration rejected; M: foreign add/update/remove/switch rejected |
| Foreign line-item ID | M: PATCH/DELETE known foreign line against own cart rejected; native foreign quantity unchanged |
| Forged authority | M: real foreign merchant/store/customer/channel IDs plus region/context/stock-location/metadata/price injection rejected across all four writes; query injection rejected |
| Native-route bypass | F: native create/read/update, line add/update/delete/batch, customer transfer and completion return exact GoSpaza blocker response and no-store; lines unchanged |
| Increase eligibility | M: increase without location rejected; inactive-store increase rejected; invalid/unowned location add rejected |
| Decrease without eligibility | M: inactive store, missing location still allows decrease; B: stale and pending-location decrease |
| Remove without eligibility | M: inactive store, missing location allows last-line removal and preserves binding; B: pending-location removal |
| Concurrent adds never mix | M: first same/different merchant races and subsequent adds; assertCurrentBinding checks context, native customer/channel, every variant and M5 profile |
| Concurrent quantities | M: both absolute updates succeed and final quantity is one of the serial outcomes |
| Add versus switch | M: both HTTP operations concurrent; one valid replacement context, correct native lines, immutable superseded binding |
| Compensation/recoverable state | F: failed binding removes candidate; orphan not adopted; M: inventory failure and FK publication failure preserve old current cart and candidate count |
| Uncertain mutation visible | E: unknown post-entry/aggregate errors remain uncertain; C: all mutation kinds preserve uncertainty without replay; B: warning, unchanged quantity, reload |
| Safe images | F: real native Product image relationships and tracking rows; private, untracked, pending-removal and foreign-profile images omitted; tracked public image retained |
| Integer minor-unit money | F: unit price, line subtotal and native item subtotal equal 1099 and are safe integers; existing catalogue-policy BigNumber tests cover conversion precision/rejection |
| Restoration after navigation/reload | B: first/same-store add journey navigates and reloads while retaining both variants |
| UI never mixes stores | B: conflict keeps first-store fixture, no switch call before confirmation; replacement renders second-store product and excludes first |
| Foreground refresh during mutation | B: held PATCH, explicit focus/visibility events, authoritative refresh completes, controls unlock; subsequent idle focus still refreshes |

## Additions and correction

Existing concurrency, ownership, compensation and UI journeys were retained instead of duplicated. Expanded F/M assertions cover hostile metadata, native blocker identity, current binding, cart money and media. Added two API-client tests for failed post-write restoration and uncertain write no-replay, and one browser journey for pending-location escape mutations plus in-flight focus.

One production defect was found by static review: foreground refresh incremented the same generation used by a pending mutation. The mutation then skipped applying its response and clearing busy state. CartProvider now reserves the mutation lifecycle with a ref; focus/manual restoration cannot supersede it. The mutation's existing authoritative GET remains unchanged. Normal idle focus refresh remains enabled. Backend cart ownership, native workflows, advisory locking, binding, routes and schema were not changed.

## Test isolation

Real database fixtures retain unique prefixes and existing customer/merchant cleanup. New media fixtures contain synthetic metadata only, are tracked by exact generated IDs, and are removed before profile cleanup. They neither upload nor fetch private objects. Concurrency requests remain genuinely parallel. The browser race uses a controllable response promise, not time delays. No retry, timeout, worker-count or assertion relaxation was introduced.

## Verification limits

These tests are not yet executed for M8-E. Real PostgreSQL/network loss precisely at commit acknowledgement is not injected: the existing harness covers actual FK rollback/native compensation and separately covers uncertain-error classification/client/browser presentation. This does not exhaust every infrastructure failure interleaving. Media tests prove DTO filtering, not R2 bucket policy (the existing M5 storage suite owns provider behavior). Browser tests use mocks; backend authority and races use real database/API verification.

## Commands for user to run

Run from repository root, stopping at the first failure. Existing local backend/PostgreSQL/Redis and native ZA/ZAR region configuration are prerequisites for step 4.

1. pnpm run lint — zero findings; stop on failure.
2. pnpm run typecheck — all workspaces pass; stop on failure.
3. pnpm run test — all unit/API-client tests pass; stop on failure.
4. pnpm --filter @gospaza/backend run test:cart-mutations — foundation and mutation assertions plus cleanup pass; stop on failure. This already runs test:cart-foundation, so do not duplicate it.
5. pnpm run test:browser — full browser suite including the new deterministic cart journey passes; stop on failure.
6. pnpm run build — production workspace build passes; stop on failure.

No new migration or dependency installation is required. No M9 functionality was started.

## Final invariant/security audit

Static review found a client recovery-classification defect: a lost/unreadable write response, unclassified upstream 5xx, or failed restoration after a successful write used ordinary unavailability rather than uncertainty. The API client now reports uncertainty and instructs reload without replaying the mutation. Explicit pre-write CART_UNAVAILABLE and ordinary GET failures remain unavailable. Regression tests cover transport loss, malformed/missing write results, gateway responses, and failed post-write restoration. No backend architecture changed.

The matrix describes coverage present in source, not successful M8-E execution. Known-ID checks use real HTTP sessions; mutation races issue concurrent HTTP requests; foundation initialization races use real services/database. Media fixtures use real Product image relationships and synthetic tracking rows, without object-storage access. Restoration and mutation share the same outer lock, but a specifically coordinated real-database restoration-versus-mutation race is not separately tested.

M25 hardening should fault-inject lock-connection loss and commit-acknowledgement loss, review orphan recovery and pool contention, and exercise routing normalization at the deployed proxy boundary. Per-customer current-cart uniqueness is enforced by the shared operation lock and fail-closed reads, not a database unique constraint on customer_id (ownership remains native). Direct administrative/module writes must not bypass that boundary. These limitations are not proof of a public bypass.
