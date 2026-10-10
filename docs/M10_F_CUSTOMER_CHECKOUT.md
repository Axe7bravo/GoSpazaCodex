# M10-F — Customer checkout experience

Implementation is complete; M10-F verification remains user-run. M10-A through M10-E were reported verified by the user. No verification commands were executed for this slice.

## Customer flow

`/checkout` loads authenticated backend checkout state. With no active attempt, it loads the current cart, owned saved addresses and existing M9 selection. Review submits those identifiers as choices; the existing backend validates ownership, serviceability, reservation revision, native Shipping Method and totals. Confirmation is explicit. A changed quote requires another explicit confirmation. Pay is a separate action with an immediate in-flight latch; writes are never automatically replayed.

`/checkout/return` ignores all query parameters. It loads the same authenticated status API and polls read-only while payment/reconciliation is outstanding. Reload, focus and return from browser back/forward cache reload backend state. No checkout authority is stored in localStorage or sessionStorage.

The responsive page displays the server address snapshot, delivery window and integer-minor-unit native totals (formatted as ZAR only for presentation). Pending, failed, expired, refund pending/refunded and recovery states have distinct copy. RECOVERY_REQUIRED never offers Pay again or claims an Order. A successful Order is shown only from the backend terminal-success projection.

## Minimal backend presentation contract

Added `GET /store/gospaza/checkout/status`, with an optional authenticated-owned `attempt_id` lookup. The UI does not need a browser attempt identifier to restore state. Native Cart customer ownership scopes all lookup candidates, including completed carts; snapshot ownership is checked again. Active attempts take precedence over historical attempts. Existing `currentCheckout` owns database-time expiry under the existing customer advisory lock.

This projection is necessary because the earlier current-cart read cannot restore a completed checkout after its cart ceases to be current. It does not dispatch reconciliation, payment, completion or refunds. Only accepted COMPLETED + SUCCEEDED terminal receipt yields an Order reference. No schema, migration, provider changes or dependencies were added.

## Security review

| Source | Transformation | Trust boundary | Sink/protection |
| --- | --- | --- | --- |
| Browser address/cart/revision choices | Explicit client request projection | Authenticated GoSpaza APIs | Existing C/D ownership and revision validation remains authoritative |
| Optional attempt ID | Strict input validation and native customer-cart scope | Customer status read | Foreign known IDs return 404; forged authority fields rejected |
| Yoco return query | Ignored | External redirect to customer UI | No payment/completion calls; authenticated GET status only |
| Backend initiation redirect | Exact HTTPS c.yoco.com origin and no credentials | External navigation | No arbitrary redirect; no inference of success |
| Persisted payment/completion evidence | Customer-safe projection | Backend to browser | No operation, session, workflow, idempotency or raw provider diagnostics |

The status API and frontend expose no native payment/completion endpoint. Existing native bypass protection is unchanged. Recovery remains fail-closed and does not release capacity or initiate another payment.

## Coverage added

- API client: explicit GoSpaza endpoints, credentials, non-authoritative input projection, reconfirmation, uncertain/expired results, diagnostic redaction, constrained redirect and no automatic retry.
- Backend projection: terminal receipt requirement, recovery priority, uncertain operation presentation and late-capture/refund states.
- Existing real-database reconciliation verifier: authenticated successful restoration, foreign attempt rejection, forged authority rejection, recovery and compensation status projection. Existing prerequisite assertions remain enabled. The strict checkout-foundation quote schema now validates the returned address using the existing checkout address schema.
- Browser: preparation, updated-total confirmation, explicit Pay/duplicate-click guard, redirect, ignored return claims, pending polling/reload, verified success/reload, failed/expired/recovery/compensation states, outage and explicit refresh. Mocks are per-test and installed before navigation. A controlled response gate tests in-flight Pay; the Playwright clock exercises the production polling interval without sleeps.

## Configuration

Set YOCO_SUCCESS_URL, YOCO_CANCEL_URL and YOCO_FAILURE_URL to the customer application's `/checkout/return` URL (local: `http://localhost:3000/checkout/return`). Examples are updated; actual local environment files were not changed. Restart the backend after changing configuration. Apply these URLs to future attempts only: do not rewrite any already-sent immutable provider request. Keep the existing M10-E verified test-mode setup for integration verification; do not use live credentials.

## Commands for user to run

Working directory for every command: `D:\Programming_projects\GoSpazaCodex`. Stop on any failure. No new migration/install is required.

| Order | Command | Purpose and expected result |
| --- | --- | --- |
| 1 | `pnpm run lint` | No lint errors or warnings |
| 2 | `pnpm run typecheck` | All workspace types pass |
| 3 | `pnpm --filter @gospaza/api-client run test` | Client regressions and checkout contract tests pass |
| 4 | `pnpm --filter @gospaza/backend exec tsx --test tests/checkout-status.test.ts` | Customer outcome projection tests pass |
| 5 | `pnpm --filter @gospaza/backend run test:payment-reconciliation` | Existing M10-E test setup/backend required; prerequisite and new authenticated status assertions pass |
| 6 | `pnpm exec playwright test tests/browser/checkout.spec.ts --workers=1` | Customer checkout browser cases pass |
| 7 | `pnpm run test:browser` | Existing and new browser journeys pass |
| 8 | `pnpm --filter @gospaza/backend run build` | Backend production build succeeds |
| 9 | `pnpm --filter @gospaza/customer run build` | Customer production build succeeds |

Use the existing M10-E guide for the integration verifier's isolated test configuration. Production reconciliation worker behavior remains unchanged.

## Boundaries and remaining work

M10-G acceptance/security remains unstarted. M11 merchant acceptance, operational tracking, general refunds and support tooling are not included. Status polling does not itself reconcile a payment: the existing backend reconciliation worker must operate normally. An uncertain initiation is displayed conservatively; no automatic payment replay is offered. The status lookup currently enumerates native customer carts; historical-customer lookup/polling efficiency can be reviewed during M25 without changing authority.