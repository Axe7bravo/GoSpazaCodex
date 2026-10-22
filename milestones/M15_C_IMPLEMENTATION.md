# M15-C implementation handoff

Implementation prepared; user verification is pending. No verification commands or commits performed by Codex. The authorized PowerShell fallback was used for repository file inspection when the file-reading runtime timed out.

## Implemented

- Durable bounded dispatch orchestration over verified B transactions, sequential candidates, expiry observation, one-way HYBRID fallback and terminal exhaustion.
- Picking post-commit event hint plus durable completed-picking repair. Duplicate workers lock due rows; domain uniqueness remains authoritative.
- Generation-zero attention for disabled configuration/lost readiness. No fake search and no assignment release.
- Driver availability/location/current-offer/assignment UI, explicit decisions, safe uncertain-result readback, bounded observation and refresh.
- Merchant/customer read-only dispatch projection APIs and Order panels. No driver coordinates, commercial state duplication or native fulfillment writes.
- Own sequence readback after coordinate TTL expiry; server sample expiry supports conservative UI freshness display.

## Schema

Migration20261020000000 adds dispatch_work, its due index, and dispatch_repair_cursor. It updates only the generation/status check to permit generation-zero ATTENTION_REQUIRED. Existing single-driver/single-delivery commitment indexes and all audit/identity guards remain unchanged.

The down migration fails rather than deleting/reinterpreting a generation-zero attention record that cannot fit B's older constraint. Operational history is not silently reset.

## APIs

Existing driver routes retained. Added:

- GET /merchant/orders/:id/delivery — M11 order-read capability and tenant authority.
- GET /store/gospaza/orders/:id/delivery — authenticated customer-owned authoritative Order.

No public search/offer creation/assignment/fallback endpoint. No merchant mutation endpoint. Existing platform dispatch configuration authority is unchanged.

## Security review

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

- Driver session/offer ID → existing DriverProfile binding and strict decision schema → B eligibility, freshness, locks and owned commitment → original assignment transaction.
- Merchant session/Order ID → M11 detail authorization and native linkage → tenant-safe delivery lookup → bounded status/assigned-driver projection.
- Customer session/Order ID → native customer ownership plus M10/M11 handoff → owned delivery → status only.
- Device GPS → range/generation/sequence validation → authenticated DriverProfile/Redis fence → expiring latest sample, never PostgreSQL/workflow history.
- Picking event → ID validation → B readiness/ensure → durable due observation; a forged/transient event cannot manufacture authority.
- Due worker → persisted generation/readiness/candidate revalidation → B locks/unique commitments → at most one current offer/assignment.

No new confirmed vulnerability identified by static review. Runtime proof remains pending. GPS authenticity, privileged native cancellation races, fairness/throughput under high contention and worker observability remain M25 risks. M16 owns custody/assignment release; M17 owns compliance; M18 owns financial resolution; M23 owns controlled attention recovery.

## Coverage

- Existing M15-B real Order, M13 omission, native-commerce immutability, M14 revocation/suspension, offline/accept, missing location, capacity uniqueness, ownership, expiry and exclusive-pool assertions remain.
- test:dispatch-orchestration runs B then real DB/HTTP checks for duplicate ensure/workers, merchant-first offer, decline→platform fallback, assignment restart readback, exhausted-generation non-restart, scheduled waiting, expired persisted offer vs accept/decline, generation deadline, disabled readiness, retained assigned capacity, foreign merchant/customer/driver IDs, PICKER denial, no merchant assignment API, coordinate-free projections.
- Policy tests exercise exact scheduled not-before and freshness/expiry boundaries without sleeps.
- API-client tests cover strict outbound fields, actor-specific reads, credential handling and no automatic decision replay.
- dispatch.spec.ts covers online/location/offline, denied location, explicit accept/duplicate-click guard, reload, offline assignment retention, accept/decline conflict readback, expired/foreign offer presentation, platform offer restoration, merchant/customer status, one-way phase presentation and unavailable foreign projections.
- Browser mocks test presentation/request behavior, not backend authorization. Hostile authority checks are separately exercised by real HTTP integration.

## Configuration

After applying the migration, set `DISPATCH_WORKER_ENABLED=true` in the intended backend worker environment to activate automatic dispatch. Leave it false/absent during isolated integration fixtures. Existing Medusa worker mode must load scheduled jobs. No environment secrets or local .env files were changed.

The worker's PostgreSQL schedule survives process restart. Redis scheduling/event loss may delay observations until the native worker returns; expired offers cannot be accepted during that delay. Redis location loss never releases assigned capacity.

## Commands for user to run

All commands run from repository root. Stop on any failure; do not run later expensive stages until corrected.

### A. No dev servers

Stop Next dev processes before typecheck/build so generated .next state is not concurrently written.

1. `pnpm run lint` — no lint errors.
2. `pnpm run typecheck` — all workspace types pass.
3. `pnpm run test` — static/unit/policy/API-client suites pass.
4. `pnpm run build` — production builds succeed.

### B. PostgreSQL/Redis and backend integration

1. `pnpm --filter @gospaza/backend run db:migrate` — new M15-C migration succeeds. Run with PostgreSQL/Redis available, then restart backend on current source.
2. `pnpm --filter @gospaza/backend run test:dispatch-orchestration` — existing B assertions and C orchestration assertions pass. Backend HTTP must be running; automatic dispatch worker disabled in both backend and verifier environments. Existing safe local payment-verification configuration remains required by the real Order fixture.

No Next applications are required for this integration verifier.

### C. M15 browser suite

`pnpm exec playwright test --config=playwright.m15.config.ts --workers=1`

Expected: all M15 browser cases pass. Playwright starts only customer, merchant and driver apps. Backend HTTP is mocked by browser fixtures. The readiness hook prepares documents/bundles before journey budgets and retains existing M14 preparation when running the full configuration.

### D. Full regression

Backend/DB/Redis, with dispatch worker disabled for fixtures:

- `pnpm --filter @gospaza/backend run test:scheduling-foundation`
- `pnpm --filter @gospaza/backend run test:delivery-reservations`
- `pnpm --filter @gospaza/backend run test:checkout-foundation`
- `pnpm --filter @gospaza/backend run test:payment-reconciliation`
- `pnpm --filter @gospaza/backend run test:order-decisions`
- `pnpm --filter @gospaza/backend run test:picking`
- `pnpm --filter @gospaza/backend run test:shortages`
- `pnpm --filter @gospaza/backend run test:drivers`

Each must pass. Browser regression:

`pnpm exec playwright test --workers=1`

Expected: full browser regression passes. Playwright supplies its configured app stack. No sleeps, blanket retries or global timeout increases were added.

## Material files

- Backend: lib/dispatch-orchestrator.ts, dispatch-projection.ts, dispatch-service.ts, dispatch-location.ts, dispatch-http.ts; jobs/dispatch.ts; subscribers/dispatch-ready.ts; workflows/update-picking.ts.
- Marketplace: dispatch-policy.ts; migrations/Migration20261020000000.ts.
- Routes: merchant/orders/[id]/delivery and store/gospaza/orders/[id]/delivery.
- Verification: verify-dispatch.ts, verify-dispatch-orchestration.ts, dispatch-policy.test.ts, backend package.json.
- Shared: contracts/src/dispatch.ts; api-client/src/dispatch.ts, drivers.ts, index.ts and tests/dispatch.test.ts; ui/src/dispatch.tsx and package.json.
- UI: driver/app/dispatch-panel.tsx and page.tsx; merchant order-detail.tsx; customer order-view.tsx.
- Browser: dispatch.spec.ts; fixture-only extensions in drivers.spec.ts and orders.spec.ts; m15-readiness.ts; playwright.m15.config.ts; playwright.config.ts.
- Documentation: milestone contract and this handoff.

## Explicit exclusions

No M15-D acceptance slice, M16 pickup/tracking/OTP/delivery completion, M17 age verification, refunds, earnings, batching, maps, routing, push, manual assignment, automatic attention restart or native Medusa Fulfillment mutation.
