# MILESTONE M14 — Driver Accounts & Eligibility

## 1. Status, authority and scope

M14-A approved. The M14-B policy amendment below is authoritative. M13 is user-reported complete and verified. Outcome A is approved: M14-B uses metadata-free native identity binding (sections 3 and 16). Implementation and user-run verification are separate gates.

Goal: establish persistent driver identity, onboarding, affiliation and eligibility for M15. One authenticated driver identity maps to one durable operational profile. Authentication is not approval and approval is not dynamic availability.

Slices remain M14-A/B/C/D. No dispatch, GPS, online/offline, delivery assignment, offers/timeouts, routing/ETA, M16 pickup/tracking/OTP, M17 compliance, M21 earnings/payouts, courier map or realtime/notification implementation.

## 2. Repository reconnaissance and evidence

Inspected local source, not command output. Medusa installed package version is 2.18.0. No commands were run.

| Concern | Existing evidence | M14 consequence |
|---|---|---|
| Driver auth | src/lib/auth-config.ts enables driver/emailpass; src/api/driver/me/route.ts returns actor context through auth-policy.ts | Reuse Medusa custom driver actor; no credentials table/provider |
| Registration | publicRegistrationActors in src/lib/auth-http.ts and registration-guard.ts permit customer/merchant only | Public driver registration is currently forbidden, intentionally deferred by M1; opening it is an explicit M14 policy change |
| Driver shell | apps/driver/app/login/page.tsx and app/page.tsx use shared AuthForm/SessionBoundary and say operational features are unavailable | No onboarding/profile/affiliation/eligibility exists yet |
| Sessions | API client auth.ts uses native login/session exchange, credentials include, transient JWT; middleware requires driver actor | Preserve cookie/session isolation and no token localStorage |
| Marketplace | models/service.ts registration has no driver model; existing custom domains live in Marketplace module | Add bounded driver domain in the existing module with an owning driver service, not a new deployment or parallel auth system |
| Merchant/store | merchant.ts ACTIVE/SUSPENDED; merchant-store.ts unique merchant_id and composite id/merchant index | MVP one physical store; enforce affiliation composite relationship in DB |
| Merchant auth | merchant-authorization.ts merchant-first lock and revalidation; team-policy.ts capability mapping | Reuse that boundary and add only driver-roster/affiliation capabilities |
| Platform | /admin/gospaza uses requireActor(user); application-http.ts review obtains platform actor_id | Existing platform-user trust model, not a completed fine-grained GoSpaza admin grant system |
| Review/audit | M2/M3 application review; order-decision/pick/shortage event patterns use atomic state + append-oriented audit | Reuse transaction/revision/event conventions; no general audit subsystem |
| Private storage | application-http.ts validates ownership before getAsBuffer; routed-file provider routes private/public; private-file-config.ts uses private R2 and separate public catalogue storage | Reuse File Module if an approved evidence requirement arises; never alter M2 keys/bucket boundary |
| Shared clients | contracts index contains driver ActorIdentity only; auth client has driver path but no business APIs | Add driver DTOs/client methods in B/C, not ad hoc frontend fetches |
| Geography | LocationService owns M6 serviceability and store/zone mapping | No duplicate zones or driver geolocation in M14 |
| Product requirements | docs/product/PRD.md, docs/ux/UX_SPEC.md, docs/architecture/ARCHITECTURE.md | Platform/merchant driver types required; no concrete mandatory legal document, vehicle, expiry or driver approval checklist specified |

Paths beginning src/ above are under apps/backend/. M1 explicitly deferred operational driver provisioning; its prohibition is not evidence that M14 can never add onboarding.

### Pinned native findings

- @medusajs/framework/dist/http/middlewares/authenticate-middleware.js checks actor_type; ordinary auth requires actor_id; allowUnregistered admits the matching authenticated auth_identity_id. Session middleware does NOT reread an operational profile on every request. M14 must do so.
- @medusajs/medusa/dist/api/auth/[actor_type]/[auth_provider]/register/route.js creates an auth identity/token without creating a driver profile. Login token generation reads app_metadata.driver_id; /auth/session stores that auth context.
- @medusajs/core-flows/dist/auth/steps/set-auth-app-metadata.js supports a custom actor association through Auth module service. It throws when the key is already defined; it is not itself an idempotent ensure operation. Its compensation removes/restores the association, so do not blindly replay/compensate an already-established binding.
- Existing registration-guard.ts serializes EmailPass registration and prevents reclaim/reset of an existing identity. Extend its actor allowlist alongside the public registration allowlist; never bypass the guard for drivers.
- Native User model is platform identity, not a driver account. Native Fulfillment providers/Stock Locations are not individual courier identities. No installed native driver operational model was found in the configured modules.

Medusa ownership decision: native Auth owns passwords, identities and sessions; supported actor association maps to GoSpaza DriverProfile. GoSpaza owns approval, affiliation and persistent eligibility. No native commerce table writes or speculative customer/User copies.

## 3. Approved entry and identity design

Use DRIVER-specific self-registration/application using M1 EmailPass, then a driver-originated affiliation request. This avoids staff-created passwords and a new invitation-secret lifecycle.

Compared alternatives:
- Platform-created credentials: reject for MVP; unnecessary credential custody and account-claim recovery.
- Merchant invite: workable using M4-style secrets, but additional token/expiry/email-binding UX is not needed for the initial domain.
- Driver registration then merchant affiliation request: recommended; driver explicitly requests a target, tenant staff endorse only their own store, platform approves eligibility/activation.

Registration may create only an INCOMPLETE, ineligible profile. Native auth association never grants ACTIVE state. Existing users sharing an EmailPass identity must authenticate through the native driver login flow; a customer/merchant session alone is insufficient.

One DriverProfile per native auth_identity_id, unique even after deactivation. Binding is immutable and server-derived. M14 never writes app_metadata.driver_id and never changes native customer provisioning.

Authority: verified DRIVER-scoped native session → req.auth_context.auth_identity_id → unique DriverProfile → current affiliation/eligibility. Native actor_id is not DriverProfile authority.

The boundary authenticates DRIVER with the supported allowUnregistered option because metadata-free sessions have no native driver_id. Only exact onboarding bootstrap/identity routes may proceed without a profile; every business route additionally requires a live profile. This is authenticated onboarding, never anonymous access. Same-email CUSTOMER and DRIVER scopes remain supported and distinct.

Bootstrap takes an identity-scoped PostgreSQL advisory lock, revalidates native Auth identity through the public service, and creates profile plus audit in one custom transaction. Uniqueness is final enforcement. Duplicate requests return the same profile, without native metadata binding, compensation or fresh-login requirement. Driver registration retains the shared EmailPass anti-reclaim guard; existing emails must sign in using existing credentials.

Profile binding remains after suspension/deactivation. Every business request resolves current profile state, and missing native identity fails closed. There is no native auth SQL or separate credentials store.

## 4. Minimal persistent model

Use existing Marketplace module, separate driver policy/service owner. No separate DriverAccount plus DriverProfile duplicate; DriverProfile is the business account.

### DriverProfile

- id; unique immutable auth_identity_id (native reference through supported Auth APIs, not cross-module SQL FK).
- bounded display_name and contact_phone. Email comes from native authenticated provider identity, not a browser-selected owner. Phone is contact information, not verified identity or auth.
- lifecycle status, monotonic revision, submitted_at, reviewed_at, reviewed_by native user reference; timestamps.
- No GPS, online flag, assignment, zone allocation, prices, earnings, bank data, ID number or document bytes.
- No mandatory vehicle/registration/photo field without an approved use case. M15 may later need a delivery-method constraint; do not invent it now.

### DriverAffiliation

- id; driver_profile_id FK; kind PLATFORM or MERCHANT.
- merchant_id and merchant_store_id: both null for PLATFORM; both non-null with composite store→merchant FK for MERCHANT.
- status REQUESTED / ENDORSED / ACTIVE / REJECTED / REVOKED; revision; driver request time; tenant endorsement actor/time; platform activation actor/time; terminal reason/time.
- PLATFORM does not use ENDORSED. MERCHANT activation requires current endorsement.
- Partial unique index on driver_profile_id for REQUESTED, ENDORSED, ACTIVE: at most one open affiliation, stronger than merely one active affiliation. Use migration SQL if the pinned model DSL cannot express multi-status predicate; preserve the database guarantee.
- Historical rejected/revoked rows retained; no silent overwrite/rebind. New request is a new generation.

### DriverEvent

Existing domain audit convention: append-oriented row with profile/affiliation reference, action, authenticated actor type/id (member/user reference as applicable), merchant/store scope, from/to state, previous/resulting revision, server timestamp and bounded reason. Unique transition identity prevents duplicate replay audit. State and event commit atomically. No secrets, full provider identity records, documents or unnecessary contact PII.

No driver document/vehicle model is required under the approved evidence policy (section 8).

## 5. Approved onboarding lifecycle

INCOMPLETE → PENDING_REVIEW → ACTIVE

PENDING_REVIEW → CHANGES_REQUIRED → PENDING_REVIEW

ACTIVE → SUSPENDED → ACTIVE

ACTIVE / SUSPENDED / CHANGES_REQUIRED → DEACTIVATED (platform authority only).

DEACTIVATED is terminal within M14; cannot escape via a second profile. Suspension is temporary platform-controlled ineligibility, not deactivation or deletion. If future policy needs reactivation of deactivated accounts, require a separately approved recovery action, not generic PATCH status.

- Both affiliation types share lifecycle and platform review requirement.
- Required submission fields: display name and contact phone plus a current affiliation request. No unsupported claim that a phone or legal identity is verified.
- Driver edits are permitted only in INCOMPLETE or CHANGES_REQUIRED. PENDING_REVIEW edits are rejected. Explicit submission/resubmission validates complete current fields; pending-review fields are immutable and review uses the current profile revision, including affiliation changes. Exact duplicate submission may return its receipt; stale review must conflict. Drivers cannot directly assign lifecycle states.
- No ACTIVE/SUSPENDED edits are added in B: both minimum fields are reviewed information and no separate harmless field is currently required. This bounded choice preserves review authority; a later approved contact-maintenance flow may be added without generic state editing.
- Admin approval requires complete current submitted revision. For MERCHANT, current tenant endorsement required. Approve profile and activate its current affiliation in one custom DB transaction. A platform transfer for an already ACTIVE profile still requires explicit admin affiliation activation.
- Suspension and deactivation cannot be overwritten by approval of an older submitted generation. Suspension/reactivation requires explicit reason and confirmation; reactivation revalidates requirements and current affiliation, never revives revoked affiliation.
- Authentication remains available for own status while suspended/deactivated; all operational eligibility is false. No in-flight delivery behavior is defined here.

## 6. Affiliation authority and transitions

Driver requests PLATFORM or a selected eligible merchant store. A request-supplied store ID is only a proposal selector: resolve owning merchant/store server-side, require an active valid store, and record no grant. Strict body must reject merchant_id, driver_id, approval/status and all authority fields.

A bounded, authenticated selection projection may expose only approved active store ID/name already public to the marketplace. It is not a driver directory or access to merchant-private data. No M7 customer address requirement or duplicated geographic logic is introduced.

Merchant request: REQUESTED → ENDORSED by owning active OWNER/MANAGER → ACTIVE by platform. Merchant may reject REQUESTED or revoke ENDORSED/ACTIVE. Platform may reject or revoke either kind. Driver may withdraw own open affiliation (REVOKED). Every transition revalidates scope/revision.

Platform request: REQUESTED → ACTIVE by platform approval only. Merchant cannot create, activate or edit a PLATFORM affiliation.

No merchant can add a driver by email/known ID, take over another affiliation, or grant global ACTIVE eligibility. The driver first consents through their own request. PICKER has no driver capability.

After revocation, driver is unaffiliated and ineligible even if profile status remains ACTIVE. Never auto-convert to PLATFORM. Switching requires explicit revoke/withdraw, then a new request, required endorsement and platform activation. MVP allows a deliberate ineligible gap instead of complex automatic transfers. Request replay cannot recreate a revoked generation.

Tenant roster includes only that store's pending/current affiliation and minimal historical revocation receipt. After revocation, no fresh contact/private profile fetch through old relationship. No visibility into a driver's other affiliation or rejection/suspension reason outside merchant scope.

## 7. Authoritative persistent eligibility contract for M15

One owning service provides a bounded projection/predicate, conceptually:

readPersistentDriverEligibility(driverProfileId, targetStoreId, transactionContext?)

Inputs are server-resolved candidate and target from future dispatch, never a driver browser claim. It returns eligible flag, safe internal reason codes, driver ID, profile revision, affiliation ID/revision/kind and merchant/store reference if applicable.

Eligible iff:
- live non-deleted profile and valid native auth association;
- profile ACTIVE, reviewed required fields current;
- exactly one ACTIVE affiliation, not revoked/rejected/superseded;
- mandatory configured evidence valid IF such requirements are separately approved; current approved policy has no uploaded evidence requirement;
- target merchant/store exists and is operationally active;
- for MERCHANT, exact affiliated merchant/store equals target and association is still active;
- PLATFORM affiliation is explicit and active, not inferred from null merchant IDs.

Do NOT call this complete dispatch eligibility. M15 owns mode selection: MERCHANT_ONLY selects the merchant cohort, PLATFORM_ONLY the platform cohort, HYBRID ranks eligible merchant cohort before platform fallback. M14 supplies affiliation facts and persistent admissibility; it does not store modes, rank candidates or implement fallback.

A read is a point-in-time result, not a permission lease. M15 must revalidate persistent facts under the same relevant locks at its authoritative offer/assignment boundary, in addition to its own online/load/serviceability rules. Cache/browser results and revision tokens cannot authorize dispatch. M14 must expose a transaction-aware revalidation contract; M15 must not reimplement the predicate.

Merchant suspension/store disable, driver suspension/deactivation, native identity invalidity or affiliation revocation make fresh eligibility false immediately. In-flight delivery reassignment/cancellation is explicitly M15/M16 scope. M6 remains geography authority; M14 adds no driver-zone assignment.

## 8. Evidence and private storage

Approved M14-B policy: profile completion and platform review, with no mandatory uploaded documents. This is not a legal-compliance claim. No licence/ID/vehicle requirement or upload subsystem is authorized.

Do not build an empty configurable document subsystem or accept arbitrary sensitive uploads just because storage exists. No expiry scheduler is justified without expiring evidence requirements.

If the approved checklist changes, amend this contract before implementation: define server-owned requirement codes/version and required/optional state; private DriverEvidence metadata belongs to driver domain, not merchant_application_document. Reuse native File Module routed private class, bytes validation/size limits and authorized download patterns. Extract generic validation only if needed, preserving M2 behavior; never repurpose M2 merchant ownership rows or copy its business document enum.

Required future evidence semantics: DRAFT/replacement version → submitted immutable review version → approved/rejected; superseded versions retained according to policy; rejected/invalid required evidence blocks eligibility. Driver reads own evidence; authorized platform reviewer reads submitted evidence; merchants/customers receive no keys/URLs/bytes. Upload rollback cleans orphan files; removal/replace follows existing removal-pending guarantees. Expiry, if policy requires it, must use fresh DB time at eligibility read and cannot depend on cleanup timers. No public bucket policy change; legacy keys remain private.

## 9. RBAC and privacy projections

| Actor | Own profile | Merchant roster / affiliation | Global review / suspension |
|---|---|---|---|
| DRIVER | Create/bootstrap, edit permitted draft, submit/resubmit, view own safe status; request/withdraw own affiliation | No tenant roster or endorsements | None |
| Merchant OWNER | No arbitrary driver profile edits | Own-store read + endorse/reject/revoke | None |
| Merchant MANAGER | Same as OWNER for affiliation only | Own-store read + endorse/reject/revoke | None |
| Merchant PICKER | None | None | None |
| Platform user (ADMIN trust class) | Review necessary submitted profile fields | Review/activate/reject/revoke with server scope | Approve/reject/suspend/reactivate/deactivate |
| CUSTOMER / anonymous | None | None | None |

Add MERCHANT_DRIVER_VIEW and MERCHANT_DRIVER_AFFILIATION_MANAGE to existing capability mapping for OWNER/MANAGER only. Do not misuse MERCHANT_TEAM_MANAGE (currently OWNER-only) or inline role checks.

Platform authority deliberately reuses existing session-only user boundary, plus supported native User existence check for sensitive decisions. Driver review policy is an explicit reusable server gate, not browser role strings or arbitrary user metadata. Current repository does not supply a fine-grained platform grant registry; do not claim otherwise or silently build one. Platform role subdivision/MFA is M23/M25 hardening; restricting reviewer subsets now is an unresolved product choice if required.

Projections:
- Driver: own display/contact, own lifecycle, own affiliation status/revisions and safe action/review messages; no reviewer internal secrets or another driver's records.
- Merchant: affiliation-scoped display name, kind/state, server-derived availability-for-new-dispatch indicator (persistent eligibility only), and contact phone only when ACTIVE for that store. Pending requests need display identity, not private onboarding documents. No global review notes, auth_identity_id or unrelated history.
- Platform: necessary profile/contact, affiliation scope, review submission and audit. Bound queries and explicit fields; never provider auth records/password hashes.
- Customer courier projection: not implemented. Future delivery assignment must authorize minimal display/contact projection; no public driver profile endpoint.

## 10. API families to implement in B (proposed contracts)

Routes validate/authenticate; owning Driver service/workflow decides. No generic status PATCH or ORM entity exposure.

- Existing GET /driver/me: retain actor envelope, with id resolved from DriverProfile rather than native actor_id; requires an established profile. GET /driver/onboarding/me admits authenticated DRIVER identity before bootstrap; returns no identity identifiers.
- POST /driver/profile/bootstrap: authenticated onboarding exception; idempotent metadata-free profile ensure.
- GET/PATCH /driver/profile; POST /driver/profile/submit. No driver lifecycle-state PATCH, reopen or deactivate endpoint.
- GET /driver/affiliation-targets: bounded public store projection only.
- GET/POST /driver/affiliations; POST /driver/affiliations/:id/withdraw.
- GET /merchant/drivers and /merchant/drivers/:affiliationId: tenant scoped before projection.
- POST /merchant/drivers/:affiliationId/endorse, /decline, /revoke.
- GET /admin/gospaza/drivers and /:id; POST /:id/approve, /require-changes, /suspend, /reactivate, /deactivate.
- POST /admin/gospaza/drivers/:id/affiliations/:affiliationId/activate, /decline, /revoke for later affiliation changes; initial approval may atomically activate as above.
- Internal persistent eligibility service only; no public dispatch/candidate API.

All mutations have strict allowlists, resource-ID validation, expected_revision and explicit confirmation/reason where relevant. Driver profile bodies accept only editable personal fields. No submitted native identity, eligibility, merchant owner, timestamps or audit actor. Error behavior foreign=unknown404 within actor boundary; invalid actor401, insufficient capability403, stale/opposite transition409. Paginate before projection with enforced bounded limits and allowlisted filters. No raw query filters.

New driver mutations need authOrigin/no-store as well as actorCors; actorCors alone is not the mutation security policy. Proposed methods use existing allowed POST/PATCH/GET. No new PUT dependence on the existing CORS method list. Registration retains rate limits and anti-reclaim guard. Bound submission/reason sizes and affiliation request frequency (at most ten newly created requests per profile per database-clock hour); no notification loop or enumeration by email.

## 11. Concurrency, idempotency and recovery

Authoritative custom state + audit in PostgreSQL transactions. No in-memory mutex or event chain as correctness.

Lock discipline for any merchant-related driver operation:
1. Determine candidate merchant/store from persisted affiliation (or validated request target), never as authorization.
2. Lock affected merchant row(s) in sorted ID order, following existing M4 discipline; revalidate staff membership/capability if merchant actor.
3. Lock DriverProfile, then its affiliation row(s) in deterministic ID order; reread revisions/status and scope.
4. Apply transition + audit atomically.

Driver/admin paths must follow the same order. If initial affiliation lookup changes while locks are acquired, fail409 and require fresh state; never acquire a newly discovered merchant lock after the profile lock. PLATFORM-only operations lock profile then affiliation; if reread discovers a merchant affiliation, abort rather than invert order. First merchant request also takes target merchant then profile. This prevents platform review/suspension and tenant revocation from operating on an obsolete relation.

Bootstrap uses identity-scoped advisory locking because no profile row exists yet; a unique auth_identity_id is final enforcement. No later driver mutation takes the bootstrap lock after tenant/profile locks. Bootstrap performs native identity reads only; custom profile and audit commit atomically.

Uniqueness: one profile per identity; one open affiliation per profile; valid PLATFORM-null/MERCHANT-composite identity check; one audit per successful revision transition. Multi-value partial indexes belong in checked migrations if DML cannot express them.

Replay uses persisted transition receipt keyed by entity/action/previous revision (and request fingerprint where needed). Same logical action/payload returns original result only after current caller authorization; creates no extra event. Opposite/stale generation conflicts. An old revoke replay must not revoke a newly requested affiliation. Submit/approve duplicates cannot act on a later resubmission revision. No historical audit deletion.

Specific races:
- Endorse/activate vs revoke: same locks; revoke first prohibits activation; activation first may then be explicitly revoked, final eligible=false. Old approval cannot resurrect it.
- Two reviewer decisions (approve vs require changes): only one transition from submitted revision; other exact replay returns receipt or opposite conflicts.
- Resubmission/edit vs review: fixed submitted revision and row lock; review cannot approve changed details.
- Duplicate request/create: unique constraints converge same logical request; conflicting target409, never another open affiliation.
- Affiliation update vs eligibility read: read obtains consistent projection; future dispatch commit must use locked revalidation, not trust earlier read.
- Suspension vs approval: revision and state guard prevent older approval overwriting suspension.

Audit failure rolls back custom decision. Native auth failure cannot produce an approved profile. No asynchronous notification is required for primary transaction correctness.

## 12. Audit and security acceptance plan

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:
- Driver session + body → strict fields and native identity resolution → profile/affiliation ownership under lock → own incomplete submission/request only.
- Merchant actor + known affiliation ID → membership/capability + tenant predicate → merchant-first locked revalidation → own-store endorsement/revocation, never platform approval.
- Platform session + reviewed revision → live User and driver policy gate → locked current submission/affiliation → approved/active or suspended state with actor audit.
- Eligibility candidate ID → native association/current profile + affiliation + target relationship → consistent read / M15 locked revalidation → persistent eligibility facts, not an assignment.

No current driver operational vulnerability is asserted from absent future functionality. M14 introduces new boundaries that require executable tests before acceptance.

B/D real-database/API tests must exercise:
- identity uniqueness, concurrent bootstrap, immutable metadata-free binding, preserved customer/unrelated metadata and concurrent native customer association;
- driver registration anti-reclaim, customer/merchant/user actor confusion, invalid/stale driver binding;
- cross-driver and cross-merchant real known IDs; equal foreign/unknown responses; safe pagination/filtering;
- forged driver/merchant/store/affiliation/status/reviewer/timestamp fields and self-approval;
- platform approval required for both types; merchant cannot grant platform eligibility; PICKER denied; revoked membership revalidated under lock;
- one open affiliation, two merchant requests racing, target ownership composite constraint, no takeover;
- approval/changes-required duplicates and opposites, resubmit/review race, endorse/revoke and activate/revoke races;
- revoked driver not eligible, merchant/store inactive not eligible, profile suspended/deactivated not eligible, no automatic PLATFORM fallback;
- read-vs-change and locked eligibility revalidation, audit rollback/append-only integrity;
- own contact/privacy allowlists, no merchant/private evidence access if evidence is subsequently approved;
- no native commerce writes, no dispatch state.

C/D browser tests: register/login/bootstrap/reload; incomplete/pending/changes-required/resubmit/active/suspended/deactivated states; request affiliation and merchant endorsement; platform review; stale revision refetch; membership loss; denied foreign detail; no online/accept-delivery controls. Browser mocks prove UX only, not authorization/concurrency.

## 13. Slice boundaries

- M14-A: this evidence-based contract and decisions only.
- M14-B: approved profile/affiliation/audit schema and migration; metadata-free native identity/profile resolution; guarded driver registration; lifecycle/eligibility service and transaction boundaries; actor APIs and contracts; real DB/API/security tests. No UI redesign or dispatch.
- M14-C: mobile-first driver onboarding/status; scoped merchant roster/request decisions; admin review/suspension UX; shared clients; deterministic browser coverage. Cream/charcoal/orange conventions and safe loading/empty/error/retry/reload/focus states.
- M14-D: missing acceptance/security/regression only, complete authority/lock/privacy audit and user-run verification. No next-milestone features.

## 14. Approval questions / safe start gate

The user approved DRIVER-specific public registration into INCOMPLETE only, a single open affiliation, driver-originated requests, own-merchant OWNER/MANAGER endorsement followed by platform activation, and the existing authenticated platform-user administrative authority. No generic cross-actor registration endpoint or new platform RBAC system is authorized.

The approved profile lifecycle uses CHANGES_REQUIRED, not ordinary review REJECTED. Platform alone approves, requires changes, suspends, reactivates and deactivates. Drivers edit INCOMPLETE/CHANGES_REQUIRED and explicitly submit; submission does not grant eligibility. DEACTIVATED is terminal.

Affiliation open statuses are REQUESTED/ENDORSED/ACTIVE. Closed history may use REJECTED for merchant decline and REVOKED for withdrawal/revocation; these are affiliation states, never the profile review state. A new request requires explicit closure of the old one. Activation atomically updates current profile/affiliation and audit where both transitions are required. Merchant endorsement never activates eligibility.

No document uploads, vehicle requirement, dispatch state or M14-C UI is approved in B. The existing private File Module/R2 boundary remains unchanged.

The prior shared-metadata gate is resolved by approved Outcome A. M14-B may proceed with the metadata-free boundary in section 3; no shared native mutation boundary or Auth compatibility patch is authorized.

## 15. M15 handoff and completion report

M15 may trust M14's current server-derived identity/profile revision, active affiliation ID/revision/type, merchant/store scope and persistent eligibility result at a validated read/commit boundary. It must add its own online/location/load/mode/offer/assignment logic and revalidate M14 at commitment. No browser identity or old eligibility result grants authority.

A changes only this milestone file. No schema, source, UI, tests, dependencies or runtime changes; no commands, commit or merge. M14-A documentation needs policy review rather than lint/build/migrations. Commands for user to run for A: none. Subsequent slices must supply exact verified package-script commands grouped by required runtime environment, without inventing scripts before they exist.

## 16. Approved Auth investigation outcome — 2026-10-18

A. METADATA-FREE DRIVER BINDING PROVEN from pinned 2.18.0 source; runtime tests remain required.

- EmailPass authenticates provider/entity_id=email, not actor-qualified email. ProviderIdentity has unique(provider, entity_id) and belongs to AuthIdentity.
- Native token generation signs actor_type from the login scope and auth_identity_id from AuthIdentity; actor_id is independently read from app_metadata. Native /auth/session accepts authenticated unregistered identities.
- authenticate("driver", ["session"], { allowUnregistered: true }) still rejects CUSTOMER/MERCHANT/user sessions. DriverProfile lookup is an additional business boundary, analogous to existing merchant applicant/member resolution.
- Native association updates load metadata and merge in memory before persistence; no AuthIdentity version/CAS predicate protects that JSON object. Driver-only locking cannot protect native customer writers.
- setAuthAppMetadata compensation reads current metadata and reverses its actor key; it does not restore a whole historical snapshot, but still uses read/modify/write.
- Avoid that write entirely: immutable DriverProfile.auth_identity_id, no app_metadata.driver_id. Native customer association and credentials remain unchanged.
- Existing registration anti-reclaim guard must include DRIVER, including identities whose app_metadata is empty. Same-email use requires existing credentials, never a replacement registration password.

Locking clarification: PLATFORM-only affiliation operations lock profile then affiliation. Any operation affecting a MERCHANT affiliation first locks its merchant, then profile and affiliation, including platform review. This retains the established contract's common merchant-first discipline and avoids inversion with tenant mutations. Re-read the open affiliation after locks and conflict if the observed generation changed; never acquire a newly discovered tenant lock after a profile lock.

No M14-C/M15 implementation is authorized. No commands were run during reconnaissance.
