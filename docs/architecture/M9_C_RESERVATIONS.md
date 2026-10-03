# M9-C reservation backend

Implementation complete; runtime verification is pending. M9-B was verified by the user. No M9-D UI, native Shipping Method attachment, payment, order or dispatch work is included.

## Authority and API

Medusa remains authoritative for native carts, customers and commercial Shipping Option pricing. Existing Marketplace models own holds, slots and operational option mappings. No new schema, migration or dependency was introduced.

CartFoundationService.withCurrent exposes the existing authenticated current-cart check inside the M8 customer advisory lock. DiscoveryService.point exposes the existing owned-address/coordinate resolution; no geography or address ownership logic is duplicated. SchedulingService.resolveAssignment remains the single assignment/native-price validation boundary.

Authenticated routes:

- POST /store/gospaza/cart/delivery-options
- POST /store/gospaza/cart/delivery-slots
- PUT /store/gospaza/cart/delivery-selection
- DELETE /store/gospaza/cart/delivery-selection
- GET /store/gospaza/cart/delivery-selection

Both availability routes accept { cart_id?, location } and return the same coherent option/slot snapshot. Location uses the existing discovery input: owned address_id or coordinates. Availability does not create slots. The returned revision is the selection revision; each option also carries its own revision and native-validated fee in integer ZAR minor units.

PUT accepts { cart_id?, location, option_id, slot_id?, expected_revision, expected_option_revision }. option_id selects a GoSpaza operational option, never an arbitrary native option. SCHEDULED requires slot_id; ASAP rejects slot_id and chooses the earliest eligible capacity window. Slot IDs are checked against the authoritative current store. A repeat of an effective identical selection preserves both reservation ID and expiry, including ASAP when an earlier window has subsequently become free.

DELETE accepts { cart_id?, reservation_id?, expected_revision }; location is neither required nor accepted. An already-unselected cart returns its current revision without a new write. A supplied reservation reference must belong to the current context. GET accepts only optional cart_id and restores from the server-held owned-address reference or validated coordinate snapshot.

All schemas are strict. Merchant/store/customer/channel/zone/fee/context fields are rejected. Known foreign/superseded cart hints never authorize access. No private location snapshot or internal context identity is included in the customer selection DTO. Existing native cart/shipping route blocking remains unchanged.

## Locking and capacity

The ordering is customer cart advisory lock, existing scheduling configuration advisory lock, existing store fulfillment advisory lock, configuration rows, slot rows in stable ID order, reservation writes, commit. Release and switch use the slot/reservation subset after the customer lock; neither acquires configuration locks after slot locks.

Configuration coordination reuses M9-B locks. This intentionally serializes configured reservation operations across stores at present. It is conservative and may limit throughput; M25 can measure contention before narrowing that boundary. Availability currently locks the store's configured slots in stable order; the result is bounded by horizon/cutoff/lead filters. No process-local lock is authoritative.

Slot occupancy counts only HELD rows with expires_at greater than fresh database time and a nonsuperseded, undeleted context. Rows still marked HELD after expiry do not consume capacity. Every capacity mutation uses slot locks; the M9-B unique-held constraint and composite foreign keys remain active. Admin capacity reduction holds the same slot lock and rejects values below effective occupancy. Referenced slot times cannot change; enabled/capacity fields can change safely.

New acquisitions obey policy lead/horizon and concrete cutoff. Existing valid holds survive safe capacity reduction. Holds expire at the earlier of policy hold duration and booking cutoff. Refresh never extends expiry. Expiry status is reconciled conditionally on restoration/replacement/release; no background worker is necessary for correct capacity accounting, and no worker/scheduler was added in this slice.

Replacement secures target capacity before ending the old hold. Both writes commit in one Marketplace transaction. A failed insert rolls back the old release. Selection revisions remain monotonic through history, including release/expiry; callers submit the last server revision. Option revision also protects the advertised quote from silent fee changes.

## Cart integration and failure semantics

Store switching releases the old hold inside the existing Marketplace publication transaction, along with binding the candidate and superseding the old context. Failure rolls back both cart publication and hold release. Native candidate cleanup and uncertain-commit reread remain M8's responsibility. The new context has no inherited hold; superseded contexts are excluded from effective occupancy even if cleanup is delayed.

Final-item removal invokes the native delete workflow first, then releases the hold under the still-held customer lock. If cleanup fails, M8 reports an uncertain mutation rather than pretending native deletion was undone. Scheduling restoration can reconcile an empty cart's leftover hold. Decrease/remove never require delivery eligibility.

Restoration revalidates policy, geographic eligibility, native quote/config revision and slot availability without requiring browser location state. Changed configuration requires reselection; invalid/expired holds are ended without discarding the cart. Operational errors return DELIVERY_REFRESH_REQUIRED and never trigger automatic workflow replay.

## Tests

- apps/backend/tests/delivery-selection.test.ts: strict input, revisions, location-source and authority rejection.
- apps/backend/src/scripts/verify-delivery-reservations.ts: reuses the real M8 fixture lifecycle; concurrent HTTP final-capacity and same-cart selection; atomic replacement and injected publication rollback; expiry without cleanup; replacement/expiry race; ASAP; reduction/booking race; switch/selection race and failed switch rollback; foreign cart/reservation/slot/native-option IDs; forged authority; disabled/past-cutoff slots; stale revisions; restoration; option revision changes; final-item release; location-free decrease/remove; explicit native bypass checks.

All concurrent requests are awaited before fixture cleanup. Cleanup targets only tracked fixture stores/native options; failures propagate. No sleeps, test retries, or mock capacity implementation are used.

## Commands for user to run

From repository root, stop on any failure:

1. pnpm run lint — no errors/warnings.
2. pnpm run typecheck — all workspace typechecks succeed.
3. pnpm --filter @gospaza/backend run test — includes selection-policy tests.
4. pnpm --filter @gospaza/backend run test:scheduling-foundation — M9-B regression succeeds.
5. pnpm --filter @gospaza/backend run test:delivery-reservations — M8 foundation and M9-C real HTTP/database verification succeed.
6. pnpm --filter @gospaza/backend run test:cart-mutations — M8 mutation regression succeeds.
7. pnpm --filter @gospaza/backend run build — backend production build succeeds.

Runtime suites require the existing local backend/PostgreSQL/Redis. Reload the backend with the current source before runtime verification. If needed, its existing separate-terminal command is pnpm --filter @gospaza/backend run dev. No new migration/install is required. Codex did not run these commands.

## M9-D dependency

After M9-C verification, build the customer scheduling UI against these endpoints. Carry both revision tokens from availability, require explicit reselection on conflict, display the server expiry and timezone, and restore from GET after navigation or an uncertain response. Do not calculate capacity/fees in the browser or attach Shipping Methods.
