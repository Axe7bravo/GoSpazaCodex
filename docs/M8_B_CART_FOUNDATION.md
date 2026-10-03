# M8-B — Cart foundation

M8-B only. No public cart creation/add/update/remove/switch endpoints or customer cart UI are introduced.

## Ownership and persistence

Marketplace owns cart_marketplace_context: unique native cart reference, merchant/store binding, timestamps and superseded_at. The composite Store/Merchant foreign key enforces agreement. Database triggers prevent rebinding or undoing supersession. Cart, customer association, items, pricing and totals remain native.

The read-only Cart module link follows the existing M5 field-based link pattern. No native table is modified through SQL.

## Authenticated restoration

GET /store/gospaza/cart optionally accepts cart_id. Native customer_id always establishes ownership. Without a hint, native customer carts are intersected with live, non-superseded contexts. Multiple current candidates fail closed. Missing-context native carts are not adopted; explicit owned orphan hints return stale. Foreign/missing hints return the same 404.

The foundation DTO exposes only cart ID, public store identity/name, native item quantity count, state and eligibility. It excludes metadata, customer IDs, merchant IDs, channel/location IDs, native image URLs and prices. Full line-item presentation is M8-C/D work.

No location is persisted. Valid restoration returns eligibility=pending until location is reselected and validated later. Inactive or inconsistent carts remain stale without being cleared or rebound. Pending eligibility is not a blanket mutation ban: M8-C must enforce current location for add/increase, while allowing safe decrease/remove without location.

## Lazy creation foundation

CartFoundationService.ensureFirstCart is internal, not an HTTP endpoint. It accepts a variant, positive quantity and current M7 location context, derives ownership from the M5 profile, checks M6/M7 eligibility and native topology, then calls a compensating workflow using createCartWorkflow with the first item.

The workflow publishes context last. A failed context insert compensates native cart creation. An interrupted orphan without context is not restorable. Existing same-store current carts are returned WITHOUT adding/incrementing anything; a different store conflicts. This is not the M8-C add operation.

Native Store.default_region_id is required and retrieved with the Store/Region module APIs. Its region must include ZA and use ZAR. Missing/invalid defaults fail explicitly; no arbitrary region selection or configuration mutation occurs.

## Lock and supersession boundary

cartOperation holds a customer-scoped PostgreSQL advisory transaction lock across lookup, native workflow execution and synchronous compensation. The lock transaction does not pretend to encompass native module commits.

bindCart and supersedeCart are internal Marketplace persistence primitives, not authorization entry points. Call them only within the authenticated customer lock after native ownership validation. M8-C must combine replacement binding and old-context supersession in one Marketplace transaction; no switch endpoint is implemented here.

Superseded carts are not restored or rebound. Their native items are retained. All native /store/carts HTTP verbs and descendants are blocked; only internal native workflow/service calls are used.

## Verification

No commands were executed by Codex. From repository root, stop on each failure:

1. `pnpm run lint` — no lint errors/warnings.
2. `pnpm run typecheck` — all workspace types pass.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/cart-foundation.test.ts` — region/reference policy tests pass.
4. `pnpm run db:migrate` — context migration and native link initialization succeed.
5. `pnpm --filter @gospaza/backend run test:cart-foundation` — run with the local backend/PostgreSQL/Redis already available. Valid native default ZA/ZAR region required. Tests use unique m8b fixtures and aggregate cleanup failures. No unrelated region/store configuration is changed.
6. `pnpm run test` — existing unit regression suite passes.

The integration script checks constraints, immutability, real concurrent first creation, cross-merchant first-creation race, ownership, pending/stale restoration, orphan exclusion, supersession, native HTTP bypass and failed-binding compensation.

M8-C still owns existing-cart add/increase/decrease/remove, full DTOs, confirmed replacement orchestration, retry/recovery rules under the same lock, and mutation-specific integration coverage. No M8-D/E or M9 functionality is implemented.

## Missing local default region

If the read-only inspect-cart-region script confirms no configured default, run `pnpm --filter @gospaza/backend exec medusa exec ./src/scripts/setup-cart-region.ts` explicitly. This development/test-only setup uses native workflows, reuses an existing valid ZA region, refuses conflicting configuration, and assigns only the native Store default region. It leaves Sales Channels, supported currencies, tax configuration of existing regions and payment configuration untouched. A newly created region uses native defaults. This setup is separate from verification; a rerun reuses the region if Store assignment previously failed.
