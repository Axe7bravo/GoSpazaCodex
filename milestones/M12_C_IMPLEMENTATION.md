# M12-C — Picking portal/client implementation

Status: implementation complete, pending user verification. M12-A/B are user-verified. No verification commands were executed by Codex. M12-D/M13 not started.

## Implemented

- Capability-gated Picking navigation, /merchant/picking queue and /merchant/picking/[id] detail.
- Server pagination/filtering; native line/variant/SKU presentation and backend-returned picked/unresolved counts.
- Self-claim, assignee-only absolute quantity saves, shortage flags and correction using original goods.
- Explicit completion confirmation; completed sessions have no mutation controls, including after reload.
- OWNER/MANAGER handover uses existing active tenant team records and explicit confirmation. Peer views are read-only. PICKER never requests M11 Order data or team data.
- Initial/loading/empty/error/retry states; focus/visibility refresh; lifetime/generation guards ignore obsolete or unmounted reads. A synchronous in-flight guard prevents duplicate mutations. Every mutation result, conflict or uncertain response is followed by a read; no automatic write replay.
- No localStorage/sessionStorage picking authority. No backend/domain changes, new dependencies, contracts, models, migrations or native Medusa calls.

## Security review

SOURCE (route Order/line selectors, quantity, shortage, target member) → TRANSFORMATION (encoded selectors, explicit allowlisted client payload, server-returned revision) → TRUST BOUNDARY (existing M12-B strict HTTP schemas, merchant membership/capability/assignment revalidation and tenant locks) → SINK (existing operational picking workflow only).

Frontend controls do not authorize. Existing B real-database/HTTP coverage remains authoritative for BOLA, roles, replay and races. Customer/provider/payment/inventory internals are neither requested nor rendered. API error messages are bounded and exclude backend diagnostics. React renders titles and identifiers as text. No new credible security defect identified in this static C review; runtime verification remains outstanding.

## Coverage

| UI/client requirement | New coverage |
| --- | --- |
| All roles queue/self-claim, PICKER without M11/team access | picking.spec.ts role journeys |
| Bounded pagination/filter and real navigation | queue uses server pages and filters |
| Absolute quantities, shortage/unresolved, original-goods correction, explicit completion | absolute quantity, shortage correction and explicit completion survive reload |
| Invalid over-order input | over-ordered quantity is rejected |
| Claim conflict and authoritative winner | claim conflict refetches the winning assignee |
| OWNER/MANAGER handover retains progress and shortage | role reassignment journeys |
| Peer read-only, reassigned employee loses controls on focus | peer read is immutable |
| Stale line and completion responses never replay | stale line/completion journeys |
| Membership loss | membership loss removes protected data and controls |
| Duplicate clicks and lost response | duplicate claim clicks produce one request |
| Same-member replay | same-member claim replay restores existing session |
| Empty/error/retry | filtered empty queue and queue failure refresh |
| Request encoding, allowlisted bodies, credentials, safe errors, no retries | packages/api-client/tests/picking.test.ts |

Browser mocks prove presentation and HTTP-client behavior only, not database isolation or concurrent correctness. Existing test:picking is retained unchanged for those guarantees. Tests do not use arbitrary sleeps, retries, raised timeouts or response.finished on intentionally conflicted mock responses. The merchant-only Playwright config reuses the existing server configuration. HTTP readiness prepares the dynamic detail and membership-loss destination; each test retains a fresh context and fixtures.

## Verification commands (repository root, one line each)

Stop on any failure and return the output. Do not run multiple groups concurrently.

### A. No dev servers

Stop Next dev servers first so generated .next files are not being written during typecheck/build.

1. pnpm run lint — zero warnings/errors.
2. pnpm run typecheck — all workspace typechecks succeed.
3. pnpm --filter @gospaza/api-client run test — client tests pass, including picking request/error cases.
4. pnpm --filter @gospaza/merchant run build — merchant production build succeeds.

### B. Backend only

No new backend regression run is required by these frontend-only changes; M12-B is user-verified and unchanged. If independently rechecking the integrated backend, keep only the configured backend/DB/Redis running and use: pnpm --filter @gospaza/backend run test:picking — existing real DB/API/concurrency suite passes. No migrations were added by C.

### C. Playwright-managed merchant browser stack

5. pnpm exec playwright test --config=playwright.m12-merchant.config.ts — all picking journeys pass. Backend calls are mocked; no backend or customer/driver/admin dev server is required. Let Playwright start the merchant server.
6. pnpm exec playwright test --workers=1 — full existing browser regression plus picking passes; Playwright uses the normal configured app stack. Run after the targeted suite, with no competing manual Next processes.

## Limitations / scope exclusions

The verified team/picking DTOs expose member IDs and roles, not employee display names. The UI displays those identities and marks the current member as You; it does not invent identity data or broaden the backend contract. Only timing already supplied by B is displayed. No new fulfillment/customer delivery projection is fabricated.

Shortages intentionally remain unresolved until original goods are found; no substitutes/refunds/fulfillment/inventory/dispatch/customer picking UI. No M12-D acceptance audit performed. No commits.

## Files materially changed

- apps/merchant/app/merchant/shell.tsx
- apps/merchant/app/globals.css
- apps/merchant/app/picking-client.ts
- apps/merchant/app/merchant/picking/page.tsx
- apps/merchant/app/merchant/picking/[id]/page.tsx
- apps/merchant/app/merchant/picking/picking-detail.tsx
- packages/api-client/src/picking.ts
- packages/api-client/src/index.ts
- packages/api-client/tests/picking.test.ts
- tests/browser/picking.spec.ts
- playwright.m12-merchant.config.ts
- milestones/MILESTONE_M12_PICKING.md
- milestones/M12_C_IMPLEMENTATION.md
