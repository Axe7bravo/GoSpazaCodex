# M4 merchant portal and team access

Implementation is pending user-run verification. Codex has not run commands.

## Roles and tenancy

| Role | Portal/context | Team and invitations | Manage non-owner members/invites |
| --- | --- | --- | --- |
| OWNER | Yes | Yes | Yes |
| MANAGER | Yes | Yes | No |
| PICKER | Yes | No | No |

The code-owned capability policy is in apps/backend/src/modules/marketplace/team-policy.ts. HTTP tenancy derives from the native authenticated merchant identity, active MerchantMember, active Merchant and MerchantStore. Source-application approval remains a consistency check, including the original applicant identity check for OWNER. Every team operation rechecks membership and capability after taking its merchant-row lock. Browser permissions only control presentation.

M3's unique auth_identity_id constraint remains: an identity cannot acquire a second membership, even if its existing membership is inactive. There is no merchant switching or ownership transfer. OWNER cannot be changed through team APIs; non-owner MANAGER/PICKER roles and ACTIVE/INACTIVE status can be changed by the owner. Safe team DTOs identify members by member ID, role, status and creation date, without native identity/provider internals.

## Invitations

Owners create MANAGER/PICKER invites at /merchant/team. The backend returns a 256-bit random secret once and persists only its SHA-256 verifier. The owner can copy the link manually. No email is sent; reload cannot recover the link. Revoke and reissue if it is lost.

The entry URL uses /invite#SECRET. Fragments are not sent to Next.js or in HTTP referrers. The page captures the secret in a component ref, clears the fragment with replaceState, and uses the existing native merchant auth client for login or registration on the same page. No localStorage, sessionStorage, cookie or normal URL path holds the invitation secret. React Strict Mode effect replay does not discard it. A reload requires reopening the original link. Successful acceptance clears it and routes to /merchant. Already authenticated merchant identities can accept directly or switch accounts.

The acceptance route is the sole POST /merchant/team/invitations/accept tenancy exception. It still requires a merchant session, and obtains the email from the native EmailPass provider's entity_id using provider === emailpass. The submitted body contains only the token. Anonymous and other actor sessions are rejected. Matching the normalized invited email plus the token does not prove email ownership; verified-email delivery remains deferred.

MERCHANT_INVITATION_EXPIRY_DAYS is validated at backend startup. It defaults to 7 only when unset and accepts integer values 1–30. Empty, fractional and invalid values fail clearly. PENDING/ACCEPTED/REVOKED/EXPIRED are derived from stored timestamps. Creating a replacement retires expired pending records with closed_at without relabeling them as revoked. A partial unique index prevents multiple open invites for a merchant/email pair.

Acceptance inserts membership and consumes the invite in one database transaction. Creation, revocation, acceptance and member management use merchant-first lock ordering. When acceptance races revocation, the first committed terminal transition wins; successful revocation excludes later acceptance. Different-merchant accepts for the same identity are resolved by the global DB uniqueness constraint and return a safe conflict. Repeated acceptance conflicts without creating a second member; repeated revocation is idempotent.

## Native auth registration safeguard

Pinned Medusa 2.18.0 EmailPass registration permits reclaiming identities whose app_metadata is empty. GoSpaza merchant identities can legitimately be in that state because authoritative tenancy is membership-based. Without a guard, public re-registration could replace an existing member's password.

registration-guard.ts guards both merchant and customer public EmailPass registration because identities are shared by the native provider. A transaction-scoped PostgreSQL advisory lock serializes registration for the same native email key. Existing provider identities return 401 so existing clients use their native-login fallback; new identities use the original native registration handler and token issuance. No native auth tables are read or changed through SQL, no password hashing/token/session implementation is replaced, and Medusa versions remain unchanged.

Sources inspected: the installed 2.18.0 EmailPass service, native registration handler and Auth module DTOs. Medusa recommends custom middleware before replacing routes: https://docs.medusajs.com/learn/fundamentals/api-routes/override .

## API surface

- GET /merchant/me: safe context with capabilities.
- GET /merchant/team: OWNER/MANAGER member DTOs.
- GET /merchant/team/invitations: OWNER/MANAGER invitation metadata, never secrets/verifiers.
- POST /merchant/team/invitations: OWNER-only email and MANAGER/PICKER role.
- POST /merchant/team/invitations/:id/revoke: OWNER-only, empty body.
- POST /merchant/team/invitations/accept: authenticated merchant identity, token only, no existing tenancy required.
- PATCH /merchant/team/members/:id: OWNER-only role/status changes to own non-owner members.

Team query/body/ID inputs are validated, requests retain the existing actor/CORS/origin boundaries, and responses are no-store. Known IDs from another merchant produce the same not-found response as unknown IDs.

## Portal behavior

The post-login root routes active members to /merchant and applicants/non-members to /application. Network failures remain errors rather than being interpreted as missing membership. The shell shows merchant/store identity, role, allowed navigation and sign out. Focus, visibility and periodic checks refresh backend tenancy; failed checks hide protected content. /merchant/team supplies owner invite/copy/revoke and non-owner role/status controls, manager read-only views, and a picker denial state. /team redirects to the canonical team route.

## Verification coverage

- apps/backend/tests/team-policy.test.ts: capability matrix and denials, strict inputs, token verifier, exact expiry boundary, configuration, native email binding and the narrow POST tenancy exception.
- packages/api-client/tests/team.test.ts: credentialed POST-only secret transport, safe error mapping and network failures.
- apps/backend/src/scripts/verify-team.ts (test:team): real native sessions and HTTP authorization; actual cross-merchant IDs; OWNER protection; role/status changes; hash-only DTOs; duplicate creation; simultaneous accepts; repeated accepts; expiry and reissue; revoke/accept races; conflicting memberships across merchants; registration password-reclaim and simultaneous-registration regressions. PostgreSQL/Redis and a running local backend are required. Fixtures have a unique m4- prefix; cleanup deletes tracked custom data before native identities and reports cleanup failures.
- tests/browser/merchant-rbac.spec.ts: deterministic HTTP fixtures for owner controls, one-time link/copy/reload, new/existing-account acceptance, signed-in acceptance errors, MANAGER/PICKER views, role/deactivation refresh, root routing, sign out and outage recovery. Browser mocks validate presentation only; the integration script proves authorization and races against real services.
- tests/browser/auth.spec.ts retains all M1 assertions; only the merchant applicant fixture and expected post-login destination are aligned with M4 routing. M2/M3 browser coverage remains intact.

## Commands for user to run

Run these one-line commands from the repository root. Stop on every failure and return the first failure output. No dependency install is needed for this change.

1. pnpm run lint — expect zero errors/warnings.
2. pnpm run typecheck — expect all workspaces to pass.
3. pnpm test — expect all unit/config/client tests to pass.
4. pnpm run db:migrate — with existing local PostgreSQL/Redis available, expect native and M4 migrations/link sync to succeed. Do not reset data.
5. node scripts/dev-supervisor.mjs — in terminal A, unless already running; expect all five applications ready. Keep it running for the following commands in terminal B.
6. pnpm --filter @gospaza/backend run test:team — expect the M4 integration success message and successful fixture cleanup.
7. pnpm --filter @gospaza/backend run test:integration — expect M1 native auth regression checks to pass.
8. pnpm --filter @gospaza/backend run test:applications — expect M2 application ownership and private-document regression checks to pass.
9. pnpm --filter @gospaza/backend run test:provisioning — expect M3 provisioning and tenancy regression checks to pass.
10. pnpm exec playwright test tests/browser/merchant-rbac.spec.ts — expect all focused M4 browser cases to pass.
11. pnpm run test:browser — expect the full M1–M4 browser suite to pass.
12. pnpm run build — first stop dev with Ctrl+C in terminal A; expect all workspace builds to succeed without sharing .next output with a running dev server.

If authentication checks return 429, stop and respect the response’s Retry-After before rerunning that check; do not disable the shared rate limiter.

M4 contains no catalogue, inventory, order, picking, delivery, finance, notification or other M5+ implementation.
