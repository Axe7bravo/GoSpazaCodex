# M8-C — cart mutations

Implementation scope: backend mutations only. M8-B runtime verification was
reported passing by the user. M8-C commands have not been run by Codex.

## Native ownership and locking

Medusa 2.18.0 owns carts, lines, quantities, prices and inventory. The inspected
`addToCartWorkflow`, `updateLineItemInCartWorkflow` and
`deleteLineItemsWorkflow` are non-idempotent. GoSpaza invokes each once, while
holding the existing customer-scoped PostgreSQL transaction advisory lock.
The lock covers authoritative reads, native workflows and failure cleanup.
It is a serialization boundary, not an ACID transaction spanning native modules.

Marketplace owns only the immutable merchant/store binding and supersession.
No Medusa tables are directly written. No schema, dependencies or native
`/store/carts` bypass rules changed.

## API

All routes require customer authentication and use the existing origin boundary.
Bodies are strict; commerce authority, prices, metadata and provider/location
IDs cannot be supplied. Mutation query parameters are rejected.

| Method | Route | Body |
| --- | --- | --- |
| POST | /store/gospaza/cart/items | variant_id, quantity, location, optional cart_id |
| PATCH | /store/gospaza/cart/items/:lineItemId | cart_id, quantity, optional location |
| DELETE | /store/gospaza/cart/items/:lineItemId | cart_id |
| POST | /store/gospaza/cart/switch-store | cart_id, variant_id, quantity, location, confirm: true |

A successful mutation returns `{ cart_id }`. GET restoration retains the M8-B
envelope. No native cart metadata, internal channels or raw media URLs are exposed.

Location uses the existing M6/M7 owned `address_id` or latitude/longitude
selection, not a trusted eligibility result. Address ownership and coordinates
are resolved through DiscoveryService. Arbitrary Stock Location or service-zone
IDs are not accepted.

Add, increase and switch revalidate target eligibility and published product
availability. Decrease and removal do not invoke location eligibility checks,
including when the store is inactive. Native pricing/inventory validation still
applies to quantity updates. Quantity zero is rejected; use DELETE for removal.

Existing-cart writes should include the last observed cart ID. A supplied cart ID
must match the authenticated customer's current bound cart. Item IDs must belong
to that cart. Stale, superseded, foreign, completed and unbound cart IDs cannot
authorize mutations.

## Add and conflict

First add creates a native cart with its first line, then publishes the binding
using the M8-B compensated workflow. Subsequent adds use the native add workflow.
Two same-store initial adds converge on one cart and both quantities count.
The separate M8-B `ensureFirstCart` primitive retains get-or-create semantics
and does not increment on reuse.

A different eligible merchant returns `409 CART_MERCHANT_CONFLICT`.
No clearing, rebinding or merging occurs. An empty cart remains bound.
Native insufficient inventory returns `409 CART_INVENTORY_UNAVAILABLE`.
Unknown mutation failures return `503 CART_MUTATION_UNCERTAIN`; callers must
restore state rather than automatically replay a non-idempotent operation.

## Explicit switch and compensation

The authenticated current cart and explicit confirmation are checked under the
customer lock. The server derives target merchant/store, channel and configured
ZA/ZAR region from the variant and existing commerce configuration.

1. Run native create-cart with the target first item.
2. In one Marketplace transaction, insert the new binding and supersede the old
   context. This is the final publication point.
3. On transaction failure, re-read bindings before deleting anything. If the
   transaction actually committed despite a lost acknowledgement, return the
   published replacement. Otherwise delete only the unpublished candidate using
   the native Cart Module API.
4. If authority cannot be read or cleanup fails, surface a recovery error. Never
   blindly recreate a cart or delete a possibly published replacement.

Native creation failures retain native workflow compensation. The old cart and
its lines are retained after a successful switch, but cannot be used as current.
A crash before publication can leave an unbound native orphan; M8-B restoration
does not adopt it. No crash-recovery worker is introduced.

Concurrent absolute quantity updates are serialized; the last lock holder wins.
An add carrying the old cart ID either finishes before a switch or is rejected
after it. Neither ordering mixes merchants or revives a superseded context.

## Verification

Added:
- `apps/backend/tests/cart-mutations.test.ts`: strict authority/quantity/location
  and switch-confirmation validation.
- `apps/backend/src/scripts/verify-cart-mutations.ts`: actual authenticated HTTP
  requests with real database state, including concurrent first adds, same-cart
  additions, absolute updates, different-merchant races, switch/add races,
  known-ID attacks, stale IDs, inactive-store decrease/removal, draft/ineligible
  products, native inventory rejection and failed-publication compensation.
- M8-B fixture exposes an optional verification callback so M8-C reuses its
  unique-prefix setup and scoped cleanup. The M8-B checks still run unchanged.

Run from the repository root, stopping at the first failure:

1. `pnpm run lint` — no errors or warnings.
2. `pnpm run typecheck` — all workspaces succeed.
3. `pnpm --filter @gospaza/backend run test` — backend unit tests pass.
4. `pnpm --filter @gospaza/backend run test:cart-mutations` — M8-B and M8-C pass.
   Requires the updated local backend already running, PostgreSQL/Redis, the
   applied M8-B migration, and configured native Store default ZA/ZAR region.
5. `pnpm --filter @gospaza/backend run build` — backend build succeeds.

No new migration or installation is required.

## Deferred to M8-D

No customer UI, cart page, API-client mutation wrappers, item/price presentation
DTO or browser journeys were added. M8-D must preserve location selection, send
the current cart ID, offer explicit keep/switch confirmation, and restore state
after uncertain outcomes without automatic mutation retries. No checkout,
shipping, payment, order or later-milestone functionality is included.
