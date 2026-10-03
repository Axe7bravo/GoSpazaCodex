# M9-B scheduling foundations

Implementation only; user-run verification is pending. No reservation lifecycle or customer scheduling UI is implemented.

## Ownership and prerequisites

Medusa 2.18.0 owns Fulfillment Sets, native Service Zones, Shipping Profiles, Shipping Options, native Pricing and future cart Shipping Methods. Marketplace owns geographic polygons, assignment priority, scheduling policy, concrete store capacity windows and the reservation schema.

The existing store/Stock Location/Fulfillment Set/Service Zone topology is preserved. New M6 assignments use a country-level za native geo zone. Explicit scheduling synchronization upgrades legacy empty geo zones using updateServiceZonesWorkflow. Nonempty incompatible native zones fail rather than being replaced. Country matching is only native compatibility: M6 polygon and current store eligibility remain required.

The unique native default Shipping Profile is reused, or created through createShippingProfilesWorkflow if absent. Multiple defaults fail visibly. Synchronization inspects only products owned by that store's M5 profiles and backfills missing links through updateProductsWorkflow; incompatible links are never overwritten. New catalogue products attach the default profile in their existing workflow. Shared profiles are not compensated/deleted when an individual product fails.

The first-party manual provider is explicitly configured as manual_manual. Synchronization also ensures the native Stock Location → fulfillment provider association through batchLinksWorkflow under the existing store fulfillment lock, reusing an existing link. Registration alone does not enable a provider for a location. It supports native flat prices without implementing dispatch. No additional dependency is installed.

## Configuration defaults

New store policy is disabled, with both modes disabled until an administrator opts in. Configurable defaults are Africa/Johannesburg, 7-day horizon, 60-minute minimum lead and 15-minute hold. Assignment-level mode enablement and store-level policy must both allow a mode.

Slots use explicit UTC timestamps, store-wide capacity and a cutoff no later than start minus configured lead. Creation is bounded by the policy horizon. Enabled windows cannot overlap through these serialized configuration operations. There is no recurring generation, capacity claiming or availability/selection endpoint. The foundation API rejects reconfiguration of any slot already referenced by a reservation; M9-C must introduce the appropriate lifecycle-aware operation.

## Overlap resolution

Reuse M6 eligibility and its polygon implementation. Consider assignments for the current store, then take highest priority. Conflicting top-priority fees or enabled modes produce DELIVERY_ZONE_AMBIGUOUS. Semantically equivalent top-priority assignments use a stable ID tie-break; input ordering and lowest fee never determine authority. There is no fallback to a lower-priority assignment when the winner is unavailable or unsynchronized.

## Price projection and recovery

ServiceZone.delivery_fee_minor in zar remains the configured tariff. Conversion uses the existing nativePrice/minorPrice boundary. Medusa's flat-option workflow accepts a number, so the exact decimal boundary value is passed as Number(nativePrice(...)); no custom tax arithmetic is introduced.

Options are mapped per assignment/mode, never per slot. Each has revision, synced_revision and PENDING/SYNCING/READY/FAILED state. Native data records the configuration ID and projected revision. Native option names are deterministic to recover interrupted creation before the native ID was persisted.

Existing M6 tariff/geometry/assignment changes invalidate affected projections through Marketplace database triggers. Policy and explicit option changes also invalidate them. An administrator explicitly synchronizes after configuration changes; a partial update must not be represented as READY.

Synchronization audits the attempt, updates native prices through workflows, reads the native price back, and publishes READY only if the captured revision still matches. Failed publication preserves the native reference and observable failure state. Explicit synchronization rereads/reconciles the owned native option; it does not replay cart or payment workflows. The internal resolver checks READY, revisions, native price, native option identity/topology and native availability rules. No quote/selection is exposed to customers in M9-B.

M9 does not attach shipping methods to native carts. M10 will revalidate and attach using native workflows. There is no custom shipping total/tax engine.

## Admin APIs

All paths below begin /admin/gospaza/scheduling/:storeId. They require an authenticated Medusa user session; customer, merchant, driver, bearer-only and anonymous access do not grant this platform boundary. This follows the existing M6 platform-user authorization model; no new merchant capabilities or admin UI are added.

- GET /: policy, assignment priority and synchronization status.
- PUT /policy: { confirmed: true, reason, policy: { timezone, minimum_lead_minutes, booking_horizon_days, hold_minutes, enabled, asap_enabled, scheduled_enabled } }.
- PUT /assignments/:assignmentId: { confirmed: true, reason, priority, asap_enabled, scheduled_enabled }.
- POST /synchronize: { confirmed: true, reason }. Creates disabled defaults/mappings as needed and reconciles existing native resources for this store.
- GET /slots: up to 500 future slot records, ordered by start.
- POST /slots: { confirmed: true, reason, slot: { start_at, end_at, booking_cutoff_at, capacity, enabled } }.
- PUT /slots/:slotId: same shape; known slot must belong to the path store.

Existing /admin/gospaza/service-zones remains the tariff configuration API. After a tariff write, synchronize affected stores explicitly; pending state is intentional until then. Inspect synchronization status using GET rather than assuming a successful tariff write also published native prices.

Native /store/shipping-options and every subroute/verb, including calculate, return 404. Existing /store/carts blocking remains. Server workflows are unaffected by HTTP route blocking.

## Schema and audit

Migration20260930100000 adds four foundation models plus append-oriented scheduling_event audit records, assignment priority and composite uniqueness on existing context/assignment rows. Composite foreign keys enforce reservation context/store/slot/option/assignment consistency. Native references use a read-only module link for the shipping option, not cross-module SQL writes.

Reservations have HELD/RELEASED/EXPIRED only. One HELD row per context, integer nonnegative quotes, zar, future expiry relative to creation and bounded coordinate snapshots are constrained. Native customer-address references and optional validated coordinates provide a minimal future restoration basis; these are not a new address authority. The production code does not insert reservations in M9-B.

## Verification

From repository root, stop at the first failure:

1. pnpm run lint
2. pnpm run typecheck
3. pnpm --filter @gospaza/backend run test
4. pnpm run db:migrate
5. Start/restart the existing backend with pnpm --filter @gospaza/backend run dev in a separate terminal if it is not already running with these changes.
6. pnpm --filter @gospaza/backend run test:scheduling-foundation
7. pnpm --filter @gospaza/backend run test:location
8. pnpm --filter @gospaza/backend run test:catalogue
9. pnpm --filter @gospaza/backend run test:cart-foundation
10. pnpm --filter @gospaza/backend run test:cart-mutations
11. pnpm --filter @gospaza/backend run build

The foundation integration script requires APP_ENV development/test, loopback BACKEND_URL and existing PostgreSQL/Redis. It creates uniquely identified synthetic actors/stores/zones/products, tests real HTTP boundaries and real database constraints, and cleans up only tracked fixture data. A fixture-specific database trigger injects a publication failure after native synchronization; cleanup removes it. The shared default Shipping Profile, if newly provisioned, intentionally remains as common infrastructure.

Tests do not claim M9-C capacity locking or reservation behavior. No verification commands were executed by Codex.

## M9-C dependencies

Implement customer advisory-lock + slot-row-lock reservation transactions, capacity accounting, selection revision/CAS, expiry/release/replacement, store-switch release, current-cart/location revalidation and customer DTO/API behavior. The internal resolver is a configuration read, not a reservation transaction; M9-C must revalidate under its authoritative locks. Admin capacity changes to referenced slots need lifecycle-aware handling. Customer UI, checkout, shipping-method attachment, payment, orders and delivery execution remain outside M9-B.

## Files materially changed

- README.md
- apps/backend/package.json
- apps/backend/medusa-config.ts
- apps/backend/src/api/middlewares.ts
- apps/backend/src/lib/location-service.ts
- apps/backend/src/lib/scheduling-http.ts
- apps/backend/src/lib/scheduling-native.ts
- apps/backend/src/lib/scheduling-service.ts
- apps/backend/src/links/delivery-option.ts
- apps/backend/src/modules/marketplace/service.ts
- apps/backend/src/modules/marketplace/scheduling-policy.ts
- apps/backend/src/modules/marketplace/models/store-service-zone.ts
- apps/backend/src/modules/marketplace/models/cart-context.ts
- apps/backend/src/modules/marketplace/models/delivery-policy.ts
- apps/backend/src/modules/marketplace/models/delivery-option.ts
- apps/backend/src/modules/marketplace/models/delivery-slot.ts
- apps/backend/src/modules/marketplace/models/delivery-reservation.ts
- apps/backend/src/modules/marketplace/models/scheduling-event.ts
- apps/backend/src/modules/marketplace/migrations/Migration20260930100000.ts
- apps/backend/src/workflows/create-catalogue-product.ts
- apps/backend/src/scripts/verify-scheduling-foundation.ts
- apps/backend/tests/scheduling.test.ts
- docs/architecture/M9_B_SCHEDULING_FOUNDATIONS.md
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/route.ts
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/policy/route.ts
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/assignments/[assignmentId]/route.ts
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/synchronize/route.ts
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/slots/route.ts
- apps/backend/src/api/admin/gospaza/scheduling/[storeId]/slots/[slotId]/route.ts
