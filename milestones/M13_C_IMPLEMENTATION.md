# M13-C — Merchant and customer shortage resolution UX

Implementation complete; user verification pending. M13-A and revised M13-B were reported verified by the user. No verification commands were executed for C.

## Scope and ownership

This slice consumes the verified omission-only M13-B APIs. No backend, schema, migration, dependency, authentication or native Medusa mutation changed. Medusa remains the commercial Order/payment/inventory authority; M13-B remains the sole owner of preference, generation, omission quantity and completion validation. Browser readiness is presentation only.

Customer Order details now display the effective preference, distinguish the default from explicit consent, support both choices before freeze and remove preference editing after authoritative freeze. CONTACT_ME uses a separate confirmation for the server-projected current case. The client submits only expected_revision and confirmed, never quantities. Success, conflict and unknown outcome refetch; no mutation is automatically replayed. NO_SUBSTITUTION displays the server-established omission without another decision. Omission copy explicitly says payment adjustment has not yet been processed, with no calculated refund amount.

Merchant picking reads the existing M12 detail and M13 projection together. Physical picking and omissions remain separate. Pending/inconsistent projections keep completion blocked; exact physical-plus-terminal-omitted quantities enable the existing completion action. Terminal omitted lines have no original-goods editor. Existing capability, assignment, membership, reassignment and completed-session behavior is preserved. Refresh/focus reads use effect-local cancellation/generation checks and do not repeat writes.

The customer panel has its own Refresh shortages control. Existing Refresh order still refreshes the native customer Order projection. Both refresh on focus. No browser storage contains authoritative shortage state.

## Static security review

SOURCE (route identifiers, preference choice and click) → encoded actor-specific path and explicit body whitelist → unchanged authenticated M13-B ownership/capability/merchant-lock boundary → existing preference/omission workflow. Client identifiers never authorize another customer or merchant. No native commerce endpoint, generic status write, staff-consent action or financial mutation is introduced.

SOURCE (backend projection) → React text/quantity rendering → customer/merchant session boundaries → presentation only. Provider/internal diagnostics are not displayed. No raw HTML, sensitive logging, browser quantity authority or local-storage authority was added.

No new credible security defect identified in this static review. Browser mocks and client assertions establish presentation/request behavior only. The user-verified M13-B HTTP/database suite remains the authorization/concurrency proof.

## Coverage mapping

| Requirement | Coverage |
|---|---|
| Effective default vs explicit choice; both preferences; explicit replay | shortages.spec.ts preference cases; api-client shortages.test.ts |
| Freeze removes controls; freeze racing with edit yields conflict/refetch | shortages.spec.ts preference and freeze-conflict cases |
| CONTACT_ME explicit confirmation; exact projected quantities; duplicate click guard | shortages.spec.ts current-quantity confirmation case |
| NO_SUBSTITUTION uses prior consent; truthful payment-pending copy | shortages.spec.ts prior-preference case |
| No quantity/money/actor authority submitted | api-client shortages.test.ts hostile-extra-field projection; browser mutation body assertions |
| Stale generation/quantity requires new explicit consent, never automatic replay | shortages.spec.ts stale omission case |
| Original found before omission; focus refresh; outage and explicit retry | shortages.spec.ts original-found case |
| Cross-customer unavailability | shortages.spec.ts foreign Order case; backend proof remains verify-shortages.ts |
| OWNER/MANAGER/PICKER see physical vs omitted; unresolved blocks; resolved allows existing complete workflow | shortages.spec.ts three role cases |
| Customer omission reaches picker on focus; terminal line cannot be edited; completed reload immutable | shortages.spec.ts three role cases |
| Reassignment retains evidence; no supervisor bypass; membership loss hides data | shortages.spec.ts reassignment case; preserved M12 role/reassignment tests |
| PICKER receives no M11 decisions | shortages.spec.ts PICKER case; preserved orders.spec.ts direct-navigation denial |
| Safe failures and no network mutation retries | api-client shortages.test.ts |
| Older GET cannot restore pending consent after a newer terminal projection | shortages.spec.ts gated out-of-order read case |

Existing orders.spec.ts and picking.spec.ts mocks now include the additional read-only shortage endpoint; their assertions remain unchanged. New fixtures are isolated per test. Request gates and visible authoritative outcomes synchronize tests; no sleeps, retries, response-body completion workarounds or timeout increases were added. The M13 Playwright configuration starts only customer and merchant and can also run the existing M11/M12 suites.

## Commands for user to run

All commands run from D:/Programming_projects/GoSpazaCodex. Stop on every failure.

### A. No dev servers

Stop Next dev processes before typecheck/build so .next generation is not written concurrently.

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — workspace TypeScript passes.
3. `pnpm --filter @gospaza/api-client run test` — new shortage client and existing client tests pass.
4. `pnpm --filter @gospaza/customer run build` — customer production build passes.
5. `pnpm --filter @gospaza/merchant run build` — merchant production build passes.

### B. Backend regression

No new backend regression command or migration is required by this frontend-only change. M13-B was user-verified and its real-database/API assertions are unchanged.

### C. Playwright-managed customer + merchant

No backend, driver or admin server is needed for these mocked browser suites.

1. `pnpm exec playwright test --config=playwright.m13.config.ts tests/browser/shortages.spec.ts` — all new M13 journeys pass.
2. `pnpm exec playwright test --config=playwright.m13.config.ts tests/browser/picking.spec.ts tests/browser/orders.spec.ts` — existing M12/M11 browser regressions pass.

## Material file manifest

- apps/customer/app/orders/shortage-panel.tsx (new)
- apps/customer/app/orders/order-view.tsx
- apps/customer/app/globals.css
- apps/merchant/app/merchant/picking/picking-detail.tsx
- packages/api-client/src/orders.ts
- packages/api-client/src/picking.ts
- packages/api-client/tests/shortages.test.ts (new)
- tests/browser/shortage-fixture.ts (new)
- tests/browser/shortages.spec.ts (new)
- tests/browser/orders.spec.ts
- tests/browser/picking.spec.ts
- playwright.m13.config.ts (new)
- milestones/M13_C_IMPLEMENTATION.md (new)

## Explicit exclusions / limitations

No replacements, classification runtime, Inventory patch, native Order/inventory/payment mutation, refund/credit calculation, undo, notifications, dispatch, M13-D or later milestone work. No commits. Real browser behavior/builds remain unverified until the user runs the commands. Separate picking/shortage GETs can observe different revisions; inconsistent omission evidence keeps completion disabled until refresh, and the unchanged backend validates every mutation.
