# M12-B — Picking backend implementation

Implementation present; verification not executed by Codex. M12-A and M11 approval/verification are user supplied. No M12-C UI or M13 behavior.

## Authority and concurrency

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

- Merchant session → applicantIdentity + active membership under merchant row lock → reusable picking capability + tenant-scoped ACCEPTED OrderOperation + durable M10 handoff → minimized picking projection/state.
- Order/line selectors → strict resource IDs → owned native Order readback and exact native line set → operational line only. Operation/session/foreign line IDs cannot stand in for native Order/line selectors.
- Quantity/shortage body → strict noncoercing schema → native ordered quantity ceiling + session revision/assigned actor → atomic line/session/audit writes. Native commerce is never written.
- Target member → explicit supervisor action + expected revision → same active merchant/store and picking capability under lock → assignee change with unchanged lines/shortages and old/new-assignee audit.
- Completion → active assignee + current revision + exact complete native line set → every quantity full, no shortage → immutable COMPLETED session and audit.

Locks: merchant → owned OrderOperation → PickSession → PickLine in native ID order. Team revocation shares the merchant lock. Claim/read/reassignment/update/completion all use the same outer boundary. Audit receipts recognize exact actor/action/target/payload replay; stale differing actions conflict. Reads never create sessions. No native mutation workflow is invoked.

No credible new cross-tenant or commerce-authority bypass identified in static review; executable claims remain pending user verification.

## Coverage matrix

| Invariant | Added evidence |
| --- | --- |
| Accepted authoritative admission; pending/rejected/ambiguous excluded | verify-picking.ts HTTP claim admission cases; preserved nested M10/M11-B native/receipt checks |
| Separate OWNER/MANAGER/PICKER picking capabilities; no picker acceptance | picking.test.ts capability matrix; HTTP read/decision denial in verify-picking.ts |
| Active actor, tenant isolation, unknown/foreign equivalence | HTTP foreign/unknown Order, real foreign line, hostile operation/session/internal-line IDs, wrong actors |
| No forged merchant/store/member/price/native quantity | Strict-schema unit cases and hostile claim/line/reassignment/query HTTP bodies |
| One session/assignee, duplicate claim | Actual concurrent HTTP claims by distinct actors and repeated same claimant; DB uniqueness |
| Absolute quantity, safe integers, no coercion/overflow | Pure policy cases, HTTP invalid quantities and direct database constraint attempts |
| Stale updates and two-device race | Concurrent different same-line writes, exact replay, concurrent identical writes with one event |
| Explicit supervisor handover preserves progress/shortage | OWNER then MANAGER reassignment; PICKER/foreign/inactive/nonmember target denial; old assignee denied |
| Membership revoked during lock wait | Actual blocked service request on PostgreSQL merchant lock; revocation committed first, request denied |
| Incomplete/shortage cannot complete; corrections allowed | Explicit completion failures, clearing shortage with full original goods, successful terminal completion |
| Completion vs line update/reassignment | Actual concurrent HTTP requests; one winner, authoritative state readback |
| Completed immutable, original logical replay safe | Terminal HTTP attempts plus DB mutation denial; exact completion receipt replay |
| Actor audit, state/audit atomicity | Contiguous revisions and actors, append-only update denial, deferred unaudited transaction rollback |
| Native Order/inventory/reservation/payment/fulfillment unchanged | Supported native API/query snapshots before/after the picking journey |
| Safe bounded read projection | Queue/filter/pagination tenant checks; customer/payment/internal fields excluded |
| Existing native route boundary | Merchant native fulfillment denied; customer native Order route denied |

Concurrency cases use PostgreSQL/native commerce and real authenticated HTTP; the existing Yoco transport fixture remains the only external payment substitute. Cleanup targets only this invocation's Order IDs and runs inside the prerequisite fixture lifetime.

## Files and ownership

- Marketplace models: pick-session.ts, pick-line.ts, pick-event.ts; registered in service.ts.
- Migration20261012000000.ts: FKs/unique identity, exact numeric companions, whole-unit checks, admission, monotonic revisions, terminal guards, append-oriented audit and deferred consistency.
- merchant-authorization.ts exposes the existing M11 outer boundary; order-operations-service.ts reuses it without changing behavior.
- order-operation-native.ts exposes the existing positive native quantity conversion for both M11 and M12.
- picking-policy.ts, lib/picking-service.ts, lib/picking-http.ts, workflows/update-picking.ts and merchant/picking routes.
- Shared picking DTOs and capability union; no API-client/portal work until C.
- Tests: tests/picking.test.ts and src/scripts/verify-picking.ts; test:picking script.
- MILESTONE_M12_PICKING.md incorporates approved supervisor reassignment.

## User verification (repository root; stop on every failure)

### No development servers running

Stop Next dev processes before typecheck/build so generated files are not being concurrently written.

1. pnpm run lint — no errors/warnings.
2. pnpm run typecheck — all workspace types pass.
3. pnpm --filter @gospaza/backend run test — existing and new policy/unit tests pass.
4. pnpm --filter @gospaza/backend run build — backend production build succeeds.

### PostgreSQL/Redis available, backend stopped

5. pnpm --filter @gospaza/backend run db:migrate — new picking schema installs successfully. No new native module links require separate setup.

### Backend only (no Next applications required)

6. pnpm --filter @gospaza/backend run dev — keep running until backend is ready on port 9000; use existing verified local M10 test configuration.
7. In another terminal: pnpm --filter @gospaza/backend run test:order-decisions — existing M11/M10 prerequisites and decisions pass after the shared authorization extraction.
8. pnpm --filter @gospaza/backend run test:picking — M12-B real database/API/concurrency checks and nested M10/M11-B prerequisites pass.

No browser verification is added for B; the picking UI/browser slice is C.

## Limits

Shortage remains unresolved until original goods are found or a later approved M13 mechanism exists. Native administrative Order edits do not take the Marketplace lock; changed native lines fail closed on read/mutation rather than being remapped. Merchant-wide serialization is retained intentionally. These are operational records, not fulfillment, inventory, financial or commercial authority. No dependencies added, native commerce writes, refunds, dispatch, commits or future-slice implementation.

## Exact changed-file manifest

- apps/backend/src/modules/marketplace/models/pick-session.ts
- apps/backend/src/modules/marketplace/models/pick-line.ts
- apps/backend/src/modules/marketplace/models/pick-event.ts
- apps/backend/src/modules/marketplace/migrations/Migration20261012000000.ts
- apps/backend/src/modules/marketplace/service.ts
- apps/backend/src/modules/marketplace/team-policy.ts
- apps/backend/src/modules/marketplace/merchant-authorization.ts
- apps/backend/src/modules/marketplace/picking-policy.ts
- apps/backend/src/lib/picking-service.ts
- apps/backend/src/lib/picking-http.ts
- apps/backend/src/lib/order-operation-native.ts
- apps/backend/src/lib/order-operations-service.ts
- apps/backend/src/workflows/update-picking.ts
- apps/backend/src/api/merchant/picking/route.ts
- apps/backend/src/api/merchant/picking/[id]/route.ts
- apps/backend/src/api/merchant/picking/[id]/claim/route.ts
- apps/backend/src/api/merchant/picking/[id]/reassign/route.ts
- apps/backend/src/api/merchant/picking/[id]/complete/route.ts
- apps/backend/src/api/merchant/picking/[id]/lines/[line_id]/route.ts
- packages/contracts/src/picking.ts
- packages/contracts/src/applications.ts
- packages/contracts/src/index.ts
- apps/backend/tests/picking.test.ts
- apps/backend/src/scripts/verify-picking.ts
- apps/backend/package.json
- milestones/MILESTONE_M12_PICKING.md
- milestones/M12_B_IMPLEMENTATION.md
- apps/backend/tests/team-policy.test.ts (retain exact role matrix assertions with approved M12 capabilities)
