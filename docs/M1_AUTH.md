# M1 — Authentication and actor foundations

## Medusa ownership decisions

Medusa 2.18.0 remains pinned. Inspected native authenticate middleware, EmailPass provider, auth/session routes, customer-account workflow, customer/user modules, publishable keys and Redis session loader. Native/configuration patterns suffice: no custom password store, JWT service, actor table, business entity, module link or migration was introduced.

| GoSpaza actor | Medusa actor | Provider | Browser registration |
| --- | --- | --- | --- |
| Customer | customer | emailpass | Allowed |
| Merchant staff | merchant | emailpass | Not allowed |
| Driver | driver | emailpass | Not allowed |
| Platform user | user | emailpass | Not allowed |

All four actors are explicitly included in projectConfig.http.authMethodsPerActor. The native EmailPass provider remains in use. No extra provider is added.

Customer registration calls POST /auth/customer/emailpass/register, then native POST /store/customers using the transient registration token. It logs in again after native customer creation so the token includes customer_id, exchanges that token at POST /auth/session, then retrieves native GET /store/customers/me. An existing EmailPass identity can resume through login before customer creation. Tokens remain in the current function call only, never localStorage, sessionStorage or frontend cookies.

Merchant/driver login requires a previously provisioned Auth identity with the appropriate native app_metadata actor ID. A valid identity without that ID cannot access its protected route; the UI explains that provisioning is required. No merchant/driver business record or provisioning workflow is introduced. Public provider registration is blocked for merchant, driver and user. Consequently native user-invitation registration is not an M1 browser flow; provision local platform users with Medusa’s user CLI.

## Route and UI boundaries

The reusable requireActor guard wraps Medusa authenticate(actor, ["session"]). Native middleware checks the actor type and a nonempty actor ID; it does not grant access to actorless registration tokens or API keys.

| Protected family | Minimal new route | Required actor |
| --- | --- | --- |
| /store/gospaza/* | GET /store/gospaza/me | customer |
| /merchant/* | GET /merchant/me | merchant |
| /driver/* | GET /driver/me | driver |
| /admin/gospaza/* | GET /admin/gospaza/me | user |

Each new route returns only { actor: { type, id } }. Provider identity and metadata are excluded. Browser-supplied merchant IDs never establish tenancy. Merchant tenant data does not exist in M1. Platform-user authentication is the boundary, not a completed capability matrix or MFA implementation.

Customer has /register, /login and protected /account. Other apps have /login and a protected root shell. Shared components contain auth form/session mechanics; each app owns its actor, layout, destinations and content. Protected content renders only after the backend identity check succeeds. Anonymous/wrong-actor sessions redirect to login; backend outages show a retry state. Loading and submitting states are explicit. There are no operational dashboards.

## Cookies, CORS and session safety

Browser session requests send credentials: include. Registration/login token requests and customer creation omit old cookies, so an existing actor session cannot override the bearer exchange. Login regenerates the native session ID. Native DELETE /auth/session destroys the session and clears the cookie.

Cookies are HttpOnly, SameSite=Lax, and Secure for APP_ENV=staging/production. Production apps and API must use HTTPS on the same registrable domain, e.g. shop.example.com and api.example.com. Unrelated cross-site domains are not supported; do not weaken SameSite or credentialed CORS as a workaround.

Preserve explicit STORE_CORS for customer, ADMIN_CORS for platform admin and AUTH_CORS for all four apps. Local AUTH_CORS must include http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003. Merchant/driver routes use exact AUTH_CORS origins and credentialed preflights. Auth mutations and customer creation reject foreign browser Origins. BACKEND_URL is trusted for the embedded Medusa Admin’s own origin. Originless CLI requests remain usable. Use localhost consistently, not a mixture of localhost and 127.0.0.1.

All four apps share the backend’s cookie in one browser profile. Signing into another actor replaces that session; it never merges privileges. Use separate profiles for simultaneous actors. Shells recheck on focus, visibility and every minute. Frontend redirects are UX; backend guards are the security boundary.

EmailPass input is bounded and new passwords require at least 12 characters. Redis permits 30 attempts per socket address per minute across actor types; excess attempts return 429/Retry-After and Redis outages fail closed with 503. Forwarded IP headers are intentionally ignored: proxy users share the proxy bucket until a trusted ingress policy is configured. Deployment infrastructure is not included. No tokens or passwords are logged by the custom middleware.

## Commands for user to run

Run each command separately from the repository root. Stop on every failure. Existing M0 PostgreSQL/Redis services and native migrations are prerequisites; M1 has no schema changes and no additional migration command.

1. `pnpm install` — link the new UI workspace dependencies and install Playwright. Expected: successful install; review/commit pnpm-lock.yaml changes.
2. `pnpm run lint` — expected: no lint errors.
3. `pnpm --filter @gospaza/backend run auth:publishable-key` — creates or reuses a native local publishable key. Copy the printed NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY line into apps/customer/.env.local. This public key is required for native Store API routes; never substitute a secret API key. No catalogue or sales channel is created.
4. `pnpm run typecheck` — expected: all app/package types pass. The customer Next configuration requires the publishable key from step 3.
5. `pnpm test` — expected: all unit/client/configuration tests pass.
6. `pnpm run dev` — leave the five processes running. Expected: backend port 9000, apps 3000–3003.
7. In another terminal: `pnpm --filter @gospaza/backend run test:integration` — expected: real native auth/session verification succeeds and temporary records are cleaned up. See its scope below.
8. `pnpm exec playwright install chromium` — one-time browser installation; expected: Chromium installed.
9. `pnpm run test:browser` — expected: all browser UX tests pass. It can reuse running local frontends, or start them when absent.
10. `pnpm run test:smoke` — while all five apps are running, expected: backend health and all four login shells pass.
11. Stop development with Ctrl+C, then `pnpm run build` — expected: all app builds and shared package checks pass.

Do not rerun env:setup on an already configured checkout. Add only the new customer publishable key to the existing local file.

For manual customer verification, register with local test credentials, reload /account, sign out and confirm anonymous /account redirects to /login. Merchant/driver root pages must reject anonymous and wrong-actor sessions. Their registration/provisioning is intentionally absent.

For local platform-user verification, run `pnpm --filter @gospaza/backend exec medusa user -e YOUR_LOCAL_EMAIL -p YOUR_LOCAL_PASSWORD` after replacing placeholders with your own local-only values. Do not commit or paste those credentials into reports. Sign in at port 3003 with that native user. No merchant/driver provisioning command is added.

## Test scope and limitations

Backend test:integration is a Medusa exec script using the same local DB/configuration as the already-running loopback backend. It refuses staging/production. It creates random native auth/customer/user/publishable-key fixtures, exercises native registration, login failure, session exchange, the entire actor matrix, actorless rejection, customer retrieval, DTO allowlists, session rotation, logout/replay, CORS and foreign-Origin rejection, then attempts cleanup in finally. Merchant/driver actor IDs are fixture-only metadata; no domain models are added. Use local disposable data, not a shared environment. Cleanup errors identify the fixture prefix. Wait a minute before rapid reruns if the login limit is reached.

Browser tests intercept HTTP to exercise the four actual frontends, forms, validation, errors, redirects, registration, account retrieval and logout. They are UI coverage, not evidence of backend correctness; the separate real integration script supplies that coverage. Browser tests use localhost ports 3000–3003 and API port 9000. Generated traces can include synthetic fixture credentials and are gitignored.

No command-heavy verification was run by Codex. All M1 results are pending user verification. Full RBAC, MFA, email delivery, merchant/driver domains, provisioning and M2 functionality remain out of scope.

References: [Medusa auth providers](https://docs.medusajs.com/resources/commerce-modules/auth/auth-providers), [native customer registration](https://docs.medusajs.com/resources/storefront-development/customers/register), [protected routes](https://docs.medusajs.com/learn/fundamentals/api-routes/protected-routes).
