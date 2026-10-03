# M9-D customer scheduling

Implementation complete; static review only. User verification is pending. M9-C verification and backend build were confirmed by the user before this slice.

## Authority and lifecycle

The cart delivery panel consumes the M9-C selection and availability APIs through the shared delivery client. Option/slot IDs are choices, cart IDs are hints, and revision tokens are returned by the server. No merchant, customer, zone, fee or capacity authority is submitted.

The panel displays the native-backed quote separately from the native cart subtotal. It does not attach a Shipping Method or calculate a combined shipping total. Slots use the server's IANA timezone. ASAP sends no slot ID; the backend chooses the earliest eligible window.

GET restores the current selection without browser location. Availability is loaded only with the existing M6/M7 location selection. DELETE needs the selection revision and optional reservation hint, never location. A failed availability read does not remove access to releasing an independently restored hold.

Every mutation is explicit. A changed fee/configuration or stale selection produces a reconfirmation notice, clears the draft choice, and reloads authoritative data. A lost write response is never replayed. Failed authoritative restoration blocks further changes until refreshed. Failed availability reads hide selection controls but retain release for a successfully restored hold.

The effect owns cancellation and request generation. Late reads cannot overwrite newer reads or writes. Focus/visibility reads are skipped during an active scheduling write; the write always ends with restoration. Unmount invalidates pending callbacks. A cart mutation temporarily unmounts the panel; its returned cart is then restored. The panel is keyed by native cart ID, so store switching cannot inherit a prior hold in UI state. Final-item removal removes the panel.

The expiry timer only triggers GET at the displayed expiry boundary. It never expires, releases or renews a hold locally. The backend decides the displayed expired/stale/unavailable state. No scheduling state is stored in local storage. A browser clock discrepancy cannot extend a server hold.

## Focused coverage

- API client delivery tests: exact request shape, credentials, server revisions, release without location, safe errors, uncertain writes and no automatic replay.
- Scheduling browser suite: option discovery, ASAP, scheduled replacement, reload/navigation/focus restoration without renewal, release after location loss, stale revision, unavailable slot, fee/config reconfirmation, authoritative expiry via controlled browser clock, outages/retry, empty availability and release despite discovery failure.
- Existing cart browser suite: the UI cross-store conflict/keep/confirmed-switch journey now starts with a reservation and asserts no reservation is inherited. Existing M8 assertions remain intact.

Browser fixtures exercise UI contracts, not database capacity enforcement. Existing verified M9-C real-database/API tests remain authoritative for capacity, locking, ownership and store-switch races. M9-E must audit the combined coverage; it has not been started.

## User verification (repository root; stop on any failure)

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — all workspace typechecks succeed.
3. `pnpm --filter @gospaza/api-client run test` — all client tests pass.
4. `pnpm --filter @gospaza/customer run build` — customer production build succeeds.
5. `pnpm exec playwright test tests/browser/scheduling.spec.ts tests/browser/cart.spec.ts --workers=1` — new scheduling and M8 regression journeys pass.
6. `pnpm run test:browser` — complete serial browser suite passes.

No migration, install, dependency change or backend production change is required. Shipping Method attachment, checkout, payment, orders and dispatch remain out of scope.
