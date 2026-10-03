# M7 customer discovery and storefront

Implementation is divided into the milestone's bounded slices: discovery backend (A), catalogue/search backend (B), customer UI (C), and tests/static review (D). Runtime verification remains pending.

## Ownership and pinned API review

Inspected installed Medusa **2.18.0** Product module service/filter types, native product search, product-sales-channel and sales-channel-location link definitions, variant-price-set aliases, inventory level filters/DTOs, Sales Channel and Stock Location service contracts, and M5/M6 customer-address/commerce abstractions. No version upgrade or provider change.

- Products, variants, published status, base ZAR prices, inventory/reservations, Stock Locations, Sales Channels, images and customer address text remain native.
- M5's product marketplace profile remains authoritative for merchant ownership and restricted-product metadata.
- M5's native graph reads, integer minor-unit conversion and tracked public media allowlist are reused. A batch helper fetches inventory and media without a query per product. Unsupported/incomplete variants are omitted; a product requires at least one usable variant.
- M6's existing geographic service returns eligible store IDs internally. Its existing public serviceability response is unchanged.
- Existing stable marketplace store IDs are the public route identifiers. Names are display text. No slug table, duplicate commerce state, new schema, migration, dependency or environment setting is introduced.

## API and privacy boundary

All routes retain M6's **customer session plus native publishable API key** boundary. Anonymous location discovery is not added. “Public” describes the deliberate storefront DTO, not access to private marketplace records.

| Method | Route |
| --- | --- |
| POST | /store/gospaza/discovery |
| GET | /store/gospaza/stores |
| GET | /store/gospaza/stores/:storeId |
| GET | /store/gospaza/stores/:storeId/products |
| GET | /store/gospaza/products/:productId |
| GET | /store/gospaza/search |

POST accepts a JSON body; GET accepts query parameters. Choose exactly one location source: `address_id`, or `latitude` plus `longitude`. Coordinates must be finite and in range. Address ownership is checked against the authenticated native customer; coordinates come from the M6 extension. An address without coordinates fails clearly. Unknown keys, including zone/merchant/channel overrides, are rejected.

Lists accept `limit` (1–50, default 20), `offset` (0–100000, default 0), and catalogue/search accept `q` (up to 100 characters). Responses use `Cache-Control: private, no-store`. Existing request logs omit bodies and query strings. Coordinates stay out of customer page URLs and browser storage; API GET queries necessarily contain the selected location, so any external access logging must preserve the existing redaction policy.

Each request recomputes M6 eligibility, then checks native channel/location presence, enabled channel and the existing one-location link invariant. No reads provision missing infrastructure. Missing/broken infrastructure is excluded; query failures return a safe 503 instead of claiming no service. Known store/product IDs never skip location checks.

Store DTO: stable `id`, `name`, `availability`. Product DTO: owning public store, title, description, tracked public images, restricted flag, variants with integer ZAR prices and stock states, product min/max price and stock state. No application data, merchant identity, address, zone IDs, native topology IDs, SKU, raw quantities or reservation internals.

Products must be owned by an eligible merchant, linked to that merchant's Sales Channel, published, and have a usable native-priced/inventoried variant. Out-of-stock products remain visible. Prices use M5's base ZAR prices; this is not tax, promotion or checkout price calculation. Private/legacy file keys, untracked native image URLs, pending removals and deleted media are excluded. R2/private-document settings remain unchanged.

Search uses native PostgreSQL Product title/description search plus scoped PostgreSQL store-name matching. Results retain explicit store ownership. Exact usable-product counts require scanning matching IDs in batches of 100; this is appropriate for launch catalogue size and deliberately does not add a cache or external index.

## Customer experience

Routes: `/`, `/stores`, `/stores/[storeId]`, `/products/[productId]`, `/search`.

Sign in through the existing flow and choose **Browse local stores** on the account page. Choose an owned saved address with coordinates, or current browser location. The existing M6 address page remains the only address editor.

The storefront layout keeps selection in React memory across navigation and keys it to the authenticated customer. Reloading clears selection. Location changes and focus/visibility refresh invalidate rendered results; each request has an unmount cancellation guard. Browser geolocation and address-loading callbacks use a generation guard. No service eligibility is persisted or used as backend authorization.

Zero stores shows no service with change/retry controls; one store shows its catalogue directly on home; multiple stores show eligible store cards. Store, product and search pages handle loading, empty and error states. Search no-results is separate from no-service. Product variants show their actual ZAR prices, stock states and an informational restricted-product label. No cart action exists.

## Tests

- `apps/backend/tests/storefront.test.ts`: mode, safe DTO, variant/stock/price filtering, public-image boundary and strict location input.
- `packages/api-client/tests/storefront.test.ts`: session/key transport, no-store and sanitized error behavior.
- `apps/backend/src/scripts/verify-discovery.ts` / `test:discovery`: real native sessions, PostgreSQL and HTTP; 0/1/2+, overlaps, inactive merchant/store/mapping/zone, commerce infrastructure, draft/published, channel unlink, known-ID/location bypass, address ownership, scoped search, pagination, native price/stock updates and image/DTO privacy. Unique M7 fixtures are cleaned up in dependency order; failures are reported. Only local development/test databases are allowed.
- `tests/browser/storefront.spec.ts`: deterministic 0/1/2+ discovery, saved-address navigation, catalogue/detail/variants, scoped search, location change and outage retry.
- Existing M1–M6 browser tests are unchanged.

## Commands for user to run

Run from repository root, in order; stop on the first failure. Existing M0–M6 dependencies, environment, migrations, PostgreSQL and Redis are prerequisites. M7 adds no install, migration or backfill.

1. `pnpm run lint` — no findings; stop on failure.
2. `pnpm run typecheck` — all workspaces pass; stop on failure.
3. `pnpm run test` — unit/client tests pass; stop on failure.
4. `pnpm --filter @gospaza/backend run dev` — only if the backend is not already running; keep it running in a separate terminal. Expect Medusa readiness; stop on startup failure.
5. `pnpm --filter @gospaza/backend run test:discovery` — M7 integration and cleanup pass; stop on failure.
6. `pnpm --filter @gospaza/backend run test:location` — unchanged M6 serviceability/address contract passes; stop on failure.
7. `pnpm --filter @gospaza/backend run test:catalogue` — M5 shared native/media regression passes (existing suite requires local catalogue storage); stop on failure.
8. `pnpm run test:browser -- tests/browser/storefront.spec.ts` — focused M7 browser tests pass; stop on failure.
9. `pnpm run test:browser` — complete M1–M7 browser suite passes; stop on failure. Any previously unresolved regression remains a failure, not an assumed pass.
10. Stop development processes with Ctrl+C, then `pnpm run build` — workspace production builds pass; stop on failure.

Manually inspect customer discovery on narrow mobile and wide desktop layouts. Deny geolocation, select an address without coordinates via the API, change location, navigate to an ineligible known ID, and simulate a backend outage: these must not expose an unavailable catalogue.

No command was executed by Codex. No M7 verification result is claimed.

## Explicit exclusions

No cart, checkout, shipping options, scheduling, payment, orders, picking, dispatch, age verification, notifications, finance, geocoder, recommendations or M8 implementation.
