# M14-D — Acceptance, security and regression review

Date: 2026-10-19. Scope: M14 only. No M15 implementation.

## Verdict and verification boundary

Static acceptance review complete; no CRITICAL, HIGH or MEDIUM vulnerability established in the reviewed reachable paths. No production defect fix or schema change was required. Targeted real-backend acceptance assertions were added and require user execution before final milestone commit/merge.

User-reported baseline: M14-A/B/C complete and verified; dedicated browser suite 22/22 and full browser regression 143/143 passed. These are baseline results, not results for the newly extended verifier. Codex ran no commands, tests, migrations or builds. Static file inspection does not prove runtime concurrency or production deployment safety.

## Architecture reviewed

Medusa 2.18.0 owns credentials, AuthIdentity/ProviderIdentity, signed actor context and sessions. DriverProfile owns operational identity binding and lifecycle; DriverAffiliation owns persistent affiliation; DriverEvent owns transition evidence. No native commerce table writes, alternative credential store, dispatch state or financial ledger was introduced.

Pinned source inspected: auth-emailpass/dist/services/emailpass.js and framework/dist/http/middlewares/authenticate-middleware.js. EmailPass keys identities by provider/email and can replace the password of an identity with empty app_metadata during native registration. GoSpaza registration-guard rejects existing EmailPass identities before native registration, under the shared email advisory lock. All public customer/merchant/driver registration paths use that guard. Login with existing credentials remains supported across actor scopes. Driver bootstrap never writes app_metadata.driver_id or native customer metadata.

Driver boundary: native DRIVER session -> auth_context.auth_identity_id -> native identity validity -> unique immutable DriverProfile.auth_identity_id. URL/profile IDs and email do not authorize driver actions. Native allowUnregistered does not remove actor-type validation. Platform review requires a user-scoped session and existing native User. Merchant access uses current M4 membership and capability under the merchant lock.

## Security data flows

| Source | Transformation | Trust boundary | Sink / result |
|---|---|---|---|
| Public email/password registration | format/size validation, rate limit, strict driver fields, provider identity lookup under email lock | existing credentials cannot be reclaimed through missing profile/metadata | native registration only for a new identity |
| Driver cookie + body | native actor validation, auth identity lookup, strict command schema | authenticated identity determines profile; submitted identity/status fields rejected | locked own-profile/request transition and audit |
| Merchant cookie + affiliation ID | tenant resolution, capability check, tenant predicate and revalidation after merchant lock | known/foreign IDs do not grant ownership | own-store endorsement/decline/revoke only |
| Platform cookie + profile/affiliation ID | native user existence, strict confirmed reason/revision | IDs select a target only after platform authorization | explicit lifecycle transition, never generic status edit |
| Target store selection | supported active-store lookup and composite merchant/store relationship | selected target is a request, not an endorsement/activation grant | REQUESTED affiliation only |
| Candidate profile/store IDs used internally | sorted merchant locks, profile/affiliation locks, generation reread and native validity | old eligibility is not a permission lease | current persistent eligibility inside withEligibility callback |
| Browser form/response | whitelisted client payload, server DTO, revision, fresh read after write/conflict | presentation never grants identity or eligibility | displayed authoritative state; no local-storage authority |

## Findings

- CRITICAL: none identified.
- HIGH: none identified.
- MEDIUM: none identified.
- LOW: no confirmed defect requiring a change in this slice.
- INFORMATIONAL: current approved platform policy trusts an authenticated existing native User; finer admin capabilities/MFA/governance remain M23 work.
- INFORMATIONAL: auth rate limiting uses a conservative socket-address bucket; proxy-aware abuse policy and capacity testing remain M25 work.
- INFORMATIONAL: workflow execution persistence may contain authorized operational input (display name, contact, review reason). Request logging omits bodies, credentials, tokens and query strings. Production workflow access/retention and log-pipeline review remain M25; no secret/client exposure path was established here.

No claim of exhaustive penetration testing, load testing or proof against arbitrary database administrators is made. No framework concern was classified as a vulnerability without a reachable GoSpaza abuse path.

## Acceptance matrix

Existing real-backend cases are in apps/backend/src/scripts/verify-drivers.ts; policy cases in apps/backend/tests/driver-policy.test.ts; client cases in packages/api-client/tests/drivers.test.ts; browser cases in tests/browser/drivers.spec.ts. Browser mocks establish UX only.

| Invariant | Evidence / executable case | Status |
|---|---|---|
| CUSTOMER/MERCHANT/user cannot bootstrap DRIVER | HTTP requests with real actor sessions | existing |
| DRIVER cannot access CUSTOMER endpoints | native customers/me and GoSpaza customer probe | existing |
| Wrong actors cannot read platform driver list/detail or driver profile | real HTTP actor matrix | added D |
| Registration cannot replace existing credentials | hostile replacement password rejected; old password still authenticates | existing |
| Same-email customer/driver association is safe | concurrent native customer creation + two profile bootstraps, metadata preservation | existing |
| One profile per identity, immutable identity | concurrent bootstrap, repeat bootstrap, unique violation and binding-update rejection | existing |
| Profile mass assignment rejected | HTTP PATCH/bootstrap hostile fields, strict policy tests | existing |
| Decision mass assignment rejected | merchant/admin status/identity/actor/store/eligibility/revision/reviewer injection | added D |
| Own/admin/merchant DTO privacy | exact profile keys and merchant/affiliation keys, no Auth identity | strengthened D |
| No private merchant read after closure | closed detail 404, receipt-only mutation handler | existing + static |
| OWNER/MANAGER allowed; PICKER denied | real endorsement + capability tests and HTTP deny | existing |
| Foreign known affiliation equals unknown | HTTP detail equality and denied mutation | existing |
| Tenant-safe bounded lists | foreign list empty, limit=1, forged filter 400 | existing |
| Platform filters cannot query by native identity | auth_identity_id query rejected | added D |
| Membership revalidated | inactive manager list/action denied, merchant-first service review | existing |
| One open affiliation | database partial unique index + concurrent different-store requests | existing |
| Merchant endorsement cannot activate | unavailable merchant activate endpoint; eligibility remains gated | existing |
| Revocation never creates PLATFORM | closed affiliation, explicit later request, old receipt cannot touch replacement | existing |
| Endorse vs decline | concurrent HTTP 200/409 | existing |
| Endorse vs review | concurrent requests: endorsement succeeds, old unendorsed review conflicts | existing |
| Duplicate approval | concurrent same request returns two 200s, one audit row | existing |
| Opposing reviewers | concurrent approve/require-changes: one 200, one409 | existing |
| Resubmission vs stale review | concurrent submit/approve: old review conflicts | existing |
| Activation vs suspension | concurrent HTTP 200/409 and final state validation | existing |
| Activation vs deactivation | concurrent HTTP 200/409, one revision/event, terminal ineligibility, no revival | added D |
| Revocation vs eligibility | concurrent HTTP/service transactions and final false result | existing; intermediate read may validly precede revocation |
| Audit atomicity | state+event same transaction; deferred no-audit update rejected with unchanged revision | existing |
| Audit actor identity | native reviewer ID asserted for approval and terminal race; merchant identity from locked membership | existing + strengthened D |
| Eligibility truth table | ACTIVE+active platform/matching merchant; inactive/missing/revoked/mismatched/unavailable false | policy + real backend |
| Native identity removal invalidates driver | deletion followed by denied own read and false eligibility | existing |
| DEACTIVATED terminal | bootstrap returns same terminal profile; request/activation cannot revive | existing + strengthened D |
| Driver UX lifecycle and restoration | bootstrap/edit/submit/reload, changes-required, active/suspended/deactivated, explicit withdrawal | browser baseline 22/22 |
| Merchant/admin UX | real links, explicit confirmed decisions, conflict refetch/no replay, membership loss | browser baseline 22/22 |
| Registration/outage/duplicate-click UX | actor rejection, sign-in direction, refresh recovery, one write | browser + client baseline |
| Earlier browser regression | entire customer/merchant/driver/admin suite | user-reported baseline 143/143 |

Not every permutation is independently runtime tested: dedicated process-termination injection and production load/resource exhaustion are deferred to M25. Endorse/revoke has state-dependent validity (revoke of REQUESTED is prohibited); the common profile revision/row lock and existing opposing-action tests support the ordering argument, rather than claiming an unexecuted race test. Database audit trigger inspection supports append-only update protection; no hostile database-admin threat claim is made.

## Locking / recovery review

Bootstrap takes an identity advisory transaction lock and database uniqueness. Merchant mutations take merchant lock -> revalidate membership -> profile -> current affiliation. Driver/admin mutations discover the candidate merchant before the transaction, lock merchant then profile, reread affiliation generation, and conflict if changed. They never acquire a newly discovered merchant after profile lock. Eligibility locks sorted affected merchants before profile/affiliation and rereads generation.

All state/audit writes use the same PostgreSQL transaction. Same-action replay checks persisted action/input fingerprint at the prior revision, after current caller authorization; it returns a receipt without another transition. Opposing stale actions conflict. Closed affiliation replay cannot mutate a replacement. Unique profile revision audit and deferred commit checks supplement service logic. No process-local mutex, sleeps, blind retry or asynchronous notification is required for correctness.

## Browser synchronization review

The corrected tests still click real Next links, register waitForURL before the click, assert destination URL and destination-specific rendered data, then mutate that detail resource. M14 document/bundle readiness is shared by base and dedicated configs and excluded from other named milestone configs. No arbitrary sleep, retry, global timeout change, production prefetch modification or assertion weakening. Do not broaden this user-verified fix in D.

## M15 handoff (frozen boundary)

M15 may consume authenticated DriverProfile identity; profile status/revision; affiliation ID/type/status/revision; active merchant/store relationship; and the server-derived persistent eligibility result. It must re-evaluate through withEligibility at dispatch commitment and perform its critical work inside the supplied transaction callback. An earlier eligibility response is not authorization. A false predicate must prevent dispatch. Native identity checks are current reads, not a transaction shared with native Auth administration.

M15 owns online/offline availability, live location, current assignment/load, merchant-first dispatch, PLATFORM_ONLY/MERCHANT_ONLY/HYBRID selection, offers, assignment races, timeout/fallback and commitment. None is implemented in M14. M14 has no distance/ranking/location/load fields or rules.

## Deferred items

M23: narrower platform review roles/capabilities and administrative governance.
M25: proxy-aware rate policy, bounded-query/load evaluation, workflow/log retention and access, production session invalidation/identity-deletion coordination, crash/fault injection and operational observability. No current blocking abuse path is asserted from these future controls.

## Changes and verification

Changed only this document and verify-drivers.ts. No production source, migrations, API routes, UI, browser fixtures or dependencies changed. Existing fixture ownership/cleanup remains unchanged; no extra accounts or authentication requests were introduced by D.

Commands from repository root, stop on the first failure:

A. No dev servers: pnpm run lint; pnpm run typecheck. Expected zero errors. Stop Next processes first so generated .next state is not concurrently written. These are separate one-line commands, not a chained shell command.

B. Backend only (existing PostgreSQL/Redis and backend ready): pnpm --filter @gospaza/backend run test:drivers. Expected successful M14 verifier including new assertions and isolated cleanup. No Next servers required. This is the only changed runtime test; existing browser/client/policy baseline need not be repeated solely for these verifier/document edits.

Optional final unchanged-browser recheck: pnpm exec playwright test --config=playwright.m14.config.ts --workers=1 (22 passed), then pnpm exec playwright test (143 passed). Let Playwright manage its configured app stack; no backend required for these mocked browser cases. Their prior passing output was supplied by the user.

Ready for final M14 commit/merge only after new static checks and extended real-backend verification pass and user review. No commit/merge performed. M15 not started.
