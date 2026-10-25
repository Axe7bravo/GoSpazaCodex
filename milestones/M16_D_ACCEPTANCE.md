# M16-D — UX and final acceptance review

Date: 2026-10-24. Implementation and static review complete; **user verification pending**. The user reports M16-A/B/C verified. No lint, typecheck, tests, builds, migrations, servers, commit or merge were executed by Codex. This record does not convert static reasoning or test definitions into runtime proof.

## Final architecture and ownership

Medusa 2.18.0 remains the owner of Order, Fulfillment, shipment/delivered quantities, inventory, reservations and payment. GoSpaza retains operational identity, immutable dispatch/pickup/completion evidence, bounded OTP generations and audit. M16-D adds no schema, commerce entity, native workflow, capacity mechanism or direct commerce-table write.

Existing adapters remain the only native mutation boundary: `NativePickup` invokes `createOrderFulfillmentWorkflow` and `createOrderShipmentWorkflow`; `NativeHandoff` invokes `markOrderFulfillmentAsDeliveredWorkflow`. The installed `@medusajs/core-flows/dist/order/workflows/mark-order-fulfillment-as-delivered.js` was inspected: native fulfillment delivery precedes Order delivery registration. Therefore a timestamp alone is not completion proof. Existing exact native readback and terminal execution evidence remain mandatory.

`PickupService` owns preparation/readiness. `HandoffService` owns physical handoff, OTP and completion. `DeliveryTracking` reuses the Redis latest-location owner, scoped to the immutable commitment. Driver identity comes from M14 native-auth-identity binding. Merchant/customer Order ownership is checked before operational projections. Frontend code displays DTOs and submits bounded choices; it cannot choose a native fulfillment, actor, generation or commercial outcome.

### D changes

- Driver home renders preparation, pickup-ready, pending, transit, arrival, restricted gate, attention and delivered states. It keeps the M15 assignment/store/destination view, including while OFFLINE. Explicit pickup/arrival/OTP writes use existing APIs. Busy guards suppress duplicate clicks; uncertain writes trigger readback, never automatic replay.
- A bounded `GET /driver/deliveries/latest` restores the owning driver's active handoff or most recent completed receipt after refresh/login. It derives DriverProfile from authentication, rejects query authority, prioritizes ASSIGNED and returns at most one safe DTO. Completed history cannot become a new assignment or mutation permission.
- Customer order view shows server-authorized latest location and active handoff code. Server-projected sample expiry removes stale coordinates locally. Code redisplay preserves server expiry; regeneration is explicit and enabled only by server-projected eligibility. Hidden-page unmount, failed reads and terminal state clear sensitive display state. No browser persistence, URL values, logging or analytics carry GPS/OTP.
- Merchant order view remains read-only. Pickup readiness uses the existing pickup owner, not a copied predicate. Physical handoff/attention uses the existing handoff owner. No OTP, coordinates, fulfillment/workflow identifiers or compliance evidence are projected.
- Shared handoff presentation now serves driver, customer tracking and post-pickup order status. This closes a presentation inconsistency where unresolved native completion or exhausted handoff could still appear as ARRIVED in another projection. It changes no transition or capacity rule.
- Polling is bounded and foreground-only; focus/manual refresh restores backend state. No push infrastructure or browser-local domain authority is added.

## Security findings

CRITICAL: None identified in the reviewed paths.

HIGH: None identified in the reviewed paths.

MEDIUM: None identified in the reviewed paths.

LOW / correctness: Resolved inconsistent attention presentation by sharing the handoff owner's locked projection. The prior tracking path already withheld samples after a completion operation; the correction prevents misleading physical-state presentation. Added real-DB regression assertion for unresolved native completion.

INFORMATIONAL: GPS is device-supplied, not physical-presence evidence. Native process loss between a write and durable checkpoint may require operational recovery indefinitely. Browser fixtures prove UI behavior, not real authorization or database concurrency. These are explicitly separated from the real backend verifier.

### SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK

| Source | Transformation and boundary | Sink / evidence |
| --- | --- | --- |
| Driver session + Delivery selector | `driverBoundary` authenticates native DRIVER identity; M14 binding and `PickupService.locked` match the assigned immutable commitment, then re-evaluate eligibility | Pickup/arrival/handoff commands. Foreign IDs return inaccessible; strict bodies reject actor, fulfillment and compliance fields. B/C real-DB/API tests remain; D adds latest-read actor/query tests. |
| Customer Order selector | Native customer ownership through `OrderOperationsService.customerDetail`, then locked active delivery state | Tracking/code only for own Order; private/no-store responses. Foreign customer HTTP assertions remain. Hidden/failed/terminal browser reads remove sensitive content. |
| Merchant Order selector | Existing membership/capability and tenant-safe Order detail before delivery lookup | Read-only pickup/physical phase. No coordinates/code or mutation controls; browser tests inspect projections/DOM and real API tests reject merchant DRIVER commands. |
| Browser geolocation | Strict ranges/purpose/generation/sequence; server receipt time; current assigned eligible driver and PostgreSQL lifecycle lock | Commitment-scoped Redis latest sample. OFFLINE does not erase assignment. Redis absence returns unavailable; no GPS-based arrival. Coordinates are absent from SQL/audit/workflow payloads. |
| Candidate OTP | Six digits/revision, current driver/affiliation, shipment proof, ARRIVED, compliance gate, fresh DB time and serialized budgets | Keyed constant-time comparison, consumed generation and unique completion claim. No candidate code in native workflow input or audit. Wrong/expired responses remain bounded, not an OTP oracle. |
| Restricted server fact | `handoffCompliance(true)` returns REQUIRED before comparison/consumption | Native delivered dispatch is unreachable for restricted delivery in M16. Forged compliance input is rejected; no test-only client bypass. |
| Native result/history | Exact designated transaction, retained terminal observation and strict Order/Fulfillment/manifest/counter readback | Atomic successful completion receipt, DELIVERED audit, COMPLETED commitment. Uncertainty remains RECOVERY_REQUIRED; no replay/release/refund. |
| Native Admin API mutation | Existing authenticated platform-user native-delivery guard checks GoSpaza ownership/markers | Direct native fulfillment/cancel/shipment/delivery bypass remains blocked; trusted internal workflow calls remain supported. |

SQL queries use bound values and validated selectors; no user-controlled SQL/table/path is introduced. React text rendering does not interpret provider/customer HTML. This slice introduces no outbound URL, upload or deserialization surface. Request logging is allowlisted and excludes bodies/query secrets. DTO construction is explicit, not ORM serialization. Latest receipt lookup is bounded; existing OTP request/attempt limits remain PostgreSQL-owned. Broad ingress/operational load tuning remains M25, not a claim of unlimited resource safety.

## Concurrency and completion proof obligations

Shared deterministic prefix: sorted merchant locks → DriverProfile/current affiliation → availability → OrderOperation → picking session → Delivery → commitment. Pickup operations or handoff generations/completion follow. D's shared presentation executes inside this same scope and does not acquire the prefix in reverse.

| Race / uncertainty | Authoritative mechanism and executable coverage |
| --- | --- |
| Pickup vs assignment/eligibility invalidation | Immutable commitment, M14 locked revalidation and exact shipment readback. `test:pickup` covers suspension/revocation and invalidation during native shipment. |
| Duplicate pickup/preparation | One immutable operation per Delivery/action; designation committed before native call; later requests observe only. Existing real native tests check one fulfillment/shipment and inventory effect. |
| Arrival vs pickup recovery | Arrival requires successful immutable PREPARE/SHIP and native shipment validation; duplicate arrival does not issue another generation. |
| Two guesses / regenerate vs guess | Shared Delivery/generation locks, monotonic Delivery failure budget, revision check, committed failure counters and superseded generations. Existing concurrent tests preserve all assertions. |
| Correct OTP vs regeneration | One consumed generation/unique completion operation; losing transition cannot revive an old code. Existing real-DB race accepts only the corresponding serialized outcome. |
| Completion vs duplicate/repair | Claim commits before dispatch; only its creator calls native delivered. Replays and repair inspect the same operation. Real native lost-response test retains capacity until terminal evidence/readback; invalid receipt rolls back terminal local state. |
| Completion vs tracking | Both use the shared lock prefix. D adds a real-DB concurrent sample/completion case: either ordering may win, but terminal tracking is null and capacity closes once. |
| Native write / process death | At-most-one dispatch, not automatic exactly-once recovery. Missing/ambiguous history retains authorization and capacity; no second native run. Fault injection is not a claim of exhaustive OS-kill testing. |

Existing deferred `gospaza_handoff_consistency` constraints require consumed matching generation, successful SHIP, exact completion receipt, terminal Delivery/commitment, no active conflicting commitment and DELIVERED audit. The already-applied forward migration `Migration20261024100000` preserves those checks while explicitly resolving each trigger row shape. D does not alter it or bypass COMMIT-time validation.

## OTP / privacy guarantees retained

- Dedicated 32-byte secret, HMAC versioned Delivery/nonce/generation tuple, unbiased six digits; nonce/key fingerprint persisted, plaintext never persisted.
- Ten-minute expiry, five failures/generation, fifteen/Delivery, three generations, sixty-second regeneration cooldown. Redis loss cannot reset budgets. Redisplay never extends expiry or regenerates.
- Restricted completion stops before OTP consumption. Expiry/exhaustion/recovery retains occupied commitment. Correct OTP alone is not DELIVERED.
- Driver receives no valid OTP. Merchant receives neither OTP nor GPS. Customer receives current eligible active tracking and code only through owned Order reads. Terminal lifecycle denies location even if Redis cleanup fails.
- Browser does not store code/coordinates in localStorage/sessionStorage/URL or ordinary logs. Fixture codes in test artifacts are synthetic; production trace/session-recording integrations must not capture these panels.
- No financial-resolution claim; M13 omission review evidence and omitted native reservations remain unchanged. No earnings or refund event is fabricated.

## Coverage and acceptance status

New/extended tests: `tests/browser/delivery.spec.ts`, `packages/api-client/tests/dispatch.test.ts`, `apps/backend/src/scripts/verify-handoff.ts`. Browser fixtures are isolated per context. The M16 config starts customer/merchant/driver only and reuses explicit document/bundle readiness; no sleeps, global timeout changes or automatic test retries.

Browser scenarios: real application state restoration; duplicate pickup guard; explicit arrival; uncertain OTP response/readback; wrong/expired codes; restricted gate; assigned OFFLINE location; pending/attention capacity; stable customer redisplay/expiry/regeneration; foreign/failed reads clearing secrets; terminal privacy; merchant read-only phase/no secrets.

Backend scenarios added: own/current/completed latest receipt, foreign driver and wrong actor reads, hostile query authority, merchant/customer handoff mutation denial, exact server tracking expiry, regeneration permission projection, unresolved completion attention, completion/location race. Existing B/C native, quantity, omission, expiry, attempt, capacity, audit, bypass and concurrency assertions are retained.

**No D verification has been executed.** Acceptance and commit/merge remain conditional on the commands below passing. Any CRITICAL/HIGH/MEDIUM finding or failed assertion blocks completion. A/B/C verification is user-reported; D changes require their affected regression coverage again.

## M17 trust boundary and deferred work

M17 may consume authoritative Delivery identity, server-derived restricted flag, assigned DriverProfile/commitment, validated IN_TRANSIT/ARRIVED state, immutable native fulfillment/SHIP relation, current bounded handoff generation and the existing verification/completion boundary. These must be loaded through the owner under the existing lock discipline, never accepted as browser authority.

The `handoffCompliance` hook is the mandatory prerequisite before OTP consumption/native completion. M17 must supply durable server-validated recipient evidence there and retain current ownership, budgets, at-most-one completion and readback rules. It must not accept `compliance_satisfied` from a client or redesign M16 OTP/lifecycle.

Deferred: M17 purchaser/recipient age/ID, alternate adult and failed restricted handoff; M18 financial adjustment/cancellation/refund; M21 earnings; M22 push; M23 operational recovery UX; M25 key rotation/retention/performance and privileged operational hardening. No routing/ETA, GPS history, manual reassignment or native compensation was introduced.

## Commands for user to run

Run from `D:\Programming_projects\GoSpazaCodex`. **Stop on every failure.** Each command is a separate one-line invocation. No commands were run by Codex.

### A. No dev servers — lint/typecheck/unit/build

Stop Next processes before typecheck/build so `.next` is not concurrently written.

1. `pnpm run lint` — expected zero errors/warnings.
2. `pnpm run typecheck` — expected all workspace typechecks succeed.
3. `pnpm --filter @gospaza/backend run test` — expected all backend policy/unit tests pass.
4. `pnpm --filter @gospaza/api-client run test` — expected all transport/no-replay tests pass.
5. `pnpm --filter @gospaza/backend run build` — expected successful Medusa build.
6. `pnpm --filter @gospaza/customer run build` — expected successful customer build.
7. `pnpm --filter @gospaza/merchant run build` — expected successful merchant build.
8. `pnpm --filter @gospaza/driver run build` — expected successful driver build.

### B. PostgreSQL/Redis and backend only

Use existing verified local test Yoco settings, `APP_ENV=development`, and the same dedicated `HANDOFF_OTP_SECRET` in backend/verifier. Keep PAYMENT_RECONCILIATION_WORKER_ENABLED, DISPATCH_WORKER_ENABLED, PICKUP_WORKER_ENABLED and HANDOFF_WORKER_ENABLED false/absent in both processes. Do not print the secret. No Next servers are needed.

1. Backend stopped: `pnpm --filter @gospaza/backend run db:migrate` — expected schema current, including the existing C forward correction; D adds no migration.
2. `pnpm --filter @gospaza/backend run dev` — wait for port 9000 ready; keep this terminal open.
3. In a second terminal: `pnpm --filter @gospaza/backend run test:handoff` — expected B/C/D assertions and composed M10/M11/M15 prerequisites pass with bounded cleanup.
4. `pnpm --filter @gospaza/backend run test:dispatch-acceptance` — expected M15 orchestration/security/concurrency acceptance pass.
5. `pnpm --filter @gospaza/backend run test:drivers` — expected M14 eligibility/actor regression pass.
6. `pnpm --filter @gospaza/backend run test:shortages` — expected M13 omission and picking prerequisite regression pass.
7. `pnpm --filter @gospaza/backend run test:order-decisions` — expected M11 acceptance/rejection/capacity regression pass.
8. `pnpm --filter @gospaza/backend run test:delivery-reservations` — expected M9 scheduling/capacity assertions pass.

The handoff verifier deliberately composes pickup, dispatch-domain, Order and checkout/payment prerequisites; do not run the entire monorepo to provide that backend environment. Standalone duplicate prerequisite runs are unnecessary unless a failure requires isolation.

### C. Dedicated M16 browser stack

Stop manually running Next apps; let Playwright own its configured servers. Browser API fixtures require no backend/DB/Redis and do not replace B's real integration tests.

1. `pnpm exec playwright test --config=playwright.m16.config.ts --workers=1` — expected all M16 journeys pass with customer/merchant/driver apps only.

### D. Full browser regression

1. `pnpm exec playwright test --workers=1` — expected all browser suites pass using customer/merchant/driver/admin. No skipped prerequisite or automatic retry is an acceptance substitute.

## Exact D file inventory

```text
apps/backend/src/api/driver/deliveries/latest/route.ts
apps/backend/src/lib/pickup-service.ts
apps/backend/src/lib/handoff-service.ts
apps/backend/src/lib/handoff-http.ts
apps/backend/src/lib/delivery-tracking.ts
apps/backend/src/lib/dispatch-projection.ts
apps/backend/src/scripts/verify-handoff.ts
apps/driver/app/delivery-panel.tsx
apps/driver/app/dispatch-panel.tsx
apps/customer/app/orders/delivery-panel.tsx
apps/customer/app/orders/order-view.tsx
packages/contracts/src/handoff.ts
packages/contracts/src/dispatch.ts
packages/api-client/src/dispatch.ts
packages/api-client/tests/dispatch.test.ts
packages/ui/src/dispatch.tsx
playwright.m16.config.ts
tests/browser/m15-readiness.ts
tests/browser/fixtures/delivery.ts
tests/browser/delivery.spec.ts
milestones/MILESTONE_M16_PICKUP_TRACKING_DELIVERY_OTP.md
milestones/M16_D_ACCEPTANCE.md
```
