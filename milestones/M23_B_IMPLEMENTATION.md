# M23-B implementation and user verification

Status: complete and user-verified, as confirmed in the M23-C instruction. No commands for lint, typecheck, build, tests, migrations or infrastructure were executed by Codex. No commit. This record describes B; subsequent C work is recorded separately.

## Authority and read purity

Native Medusa User/Auth validates platform identity. Native Order retrieval supplies only ID, status and currency. Marketplace owns the current persistence for the projected custom domains; its explicit `OperationsAttentionRead`, `MarketplaceOperationsRead` and `OperationsTimelineRead` ports select bounded allowlisted fields. `OperationsService` composes these ports after source-specific authorization. Existing finance, settlement, compensation and notification grants remain independent.

Rejected diagnostic shortcuts: order-operation ensure/repair; Delivery ensure/discovery/materialization; dispatch readiness helpers that may establish domain state; financial observation/recognition/settlement orchestration; inventory or provider workflows; fulfillment provisioning. Diagnostics do not call any of them. Existing pure `completedOrderCandidates` provides handoff identity evidence, and `NotificationInbox.health` supplies persisted M22 health. No subscriber/event emission, provider call, repair cursor advancement or audit write is part of the GET graph.

Source grouping is intentionally implemented inside the current Marketplace persistence owner, rather than giving HTTP handlers direct SQL access or inventing new financial/Delivery authorities. Moving persistence to separate modules later would require replacing these owner ports, not changing frontend business rules.

## Capability rollout

New explicit default-deny `_USER_IDS` grants: ORDER_OPERATIONS_VIEW, DELIVERY_OPERATIONS_VIEW, DELIVERY_RESCUE, MERCHANT_REVIEW_VIEW, MERCHANT_REVIEW_MANAGE, MERCHANT_DOCUMENT_VIEW, DRIVER_REVIEW_VIEW, DRIVER_REVIEW_MANAGE, SERVICE_CONFIGURATION_VIEW, SERVICE_CONFIGURATION_MANAGE. DELIVERY_RESCUE grants no B action. Manage requires the matching view grant; document access requires review-view plus document-view. Native user membership alone grants none of these.

Merchant application list/detail/history/actions/documents, driver review/actions/affiliation actions, service-zone reads/writes, scheduling and dispatch configuration use the narrower grants. The existing protected domain mutation and workflow boundaries remain in place. Configure actual platform-user IDs before deploying this narrowing. A process restart loads changed environment grants; sessions remain valid but each request evaluates current authority. In-process grant changes are also not cached.

Older verifier fixtures that use placeholder platform principals or omit new grants are not evidence of authorized behavior under M23. Their actor/grant setup must be updated before using them as broad regression gates. Do not add test-mode authorization bypasses. The B verifier contains focused live-session legacy read authorization and denied-action regressions; it does not claim a complete rerun of M1–M22.

## Read surfaces

GET `/admin/gospaza/operations`: independently authorized source summaries; inaccessible sources are not queried. Available-empty differs from unavailable. Independent source failure does not erase healthy sections.

GET subroutes: `attention/:source`, `orders/:id`, `deliveries/:id`, `lookup`, `orders/:id/timeline`, `deliveries/:id/timeline`, `health`. No mutation method is exported. Role contracts are in `packages/contracts/src/operations.ts`, client methods in `packages/api-client/src/operations.ts`.

Attention has fifteen finite sources: order handoff/action, delivery, checkout recovery, adjustment, Store Credit, inventory disposition, marketplace recognition, merchant settlement, driver payment, driver recognition, compensation, notification, merchant review, driver review and restricted-registration review. It is a live projection, not persistent work-item state. A changed owner predicate removes current attention without deleting history. Store Credit rows identify the operation, not merely an adjustment. Notification intent identity already includes its channel; delivery is one-to-one by intent ID.

Order detail reports native state, handoff proof/unproven state, linked operational state, store identity and picking state. Delivery and finance are separate optional authorized sections; failed authorized sections are explicitly unavailable. Delivery detail reports persisted generation/revision/state, assignment identity, timing, native-operation state and custody state, without OTP/GPS/recipient evidence. Merchant context is limited to store/merchant identity and safe operational state; driver context is limited to profile/commitment identity and state. Exact-ID merchant/driver lookup does not fetch private applications, documents, contact data or financial records.

Rescue `eligible` means only `scope=PERSISTED_PRECHECK`, with `requires_admission_revalidation=true`. It rejects missing bindings, unstarted searches, unsupported attention, active/prior assignment, unproven history, fulfillment/custody and compensation evidence. It does not authorize rescue, prove fresh native dispatch readiness, change generation or reserve capacity. C must atomically validate fresh authoritative readiness and current DELIVERY_RESCUE authority.

Lookup accepts only finite type + exact validated ID; no email, phone, provider reference, arbitrary table or broad search. Links use fixed role routes, never user-supplied URLs. No invented merchant detail link. Timeline uses six separately authorized source pages; labels are deliberately generic, actor is explicitly NOT_PROJECTED, and event notes/evidence/payloads are never selected. The timeline is not a globally complete chronological audit export.

Pages default to 20, maximum 25 plus one sentinel. Overview uses five per source, at most four concurrent source tasks. Cursors are source/context-bound keyset positions. Page/sample counts are not global totals. Finance detail is capped at 25 with truncation. Health reports bounded due/pending samples and configuration flags; noninstrumented worker execution health remains NOT_INSTRUMENTED. M22 persisted last-success evidence is reused without inventing heartbeats. No live provider, Redis administration or infrastructure probe is added to operational GETs.

## Privacy and security review

SOURCE authenticated native platform identity → TRANSFORMATION current explicit source grant → TRUST BOUNDARY owner read port → SINK allowlisted no-store DTO.

Known IDs confer no authority. Operations-view does not grant finance, documents, restricted-review, disposition, compensation or notification operations. Grant filtering occurs before domain queries and again before returning protected optional sections. No broad ORM serialization, document/storage key, bank proof/reference, raw provider message, credential, OTP, GPS or recipient observation is selected into the DTO. Legacy write authorization is checked before request target/body work and rechecked within relevant mutation boundaries. No blanket operations-manage role.

Static review found and corrected potential misleading health flags and Store Credit attention identity. B runtime security/purity verification is user-confirmed; final D API security/privacy/purity/revocation acceptance and exactly three browser journeys were also confirmed passing on 2026-11-07. See [M23_D_ACCEPTANCE.md](M23_D_ACCEPTANCE.md). No confirmed unresolved security finding is asserted away by documentation.

## Verification scope and limitations

Unit tests: explicit capability independence/current revocation, finite selectors/cursors/bounds/links, narrow persisted rescue precheck, authorization-before-query and native identity linkage. API-client tests cover the eight GET methods, credentialed no-store transport and query fields.

`verify-operations.ts` uses real PostgreSQL, native User/Auth and cookie sessions, a real native synthetic empty Order, and an owned built backend. Private generated schema source fixtures copy column shapes, not public rows, constraints or triggers; partial/unproven inputs are deliberate. They prove read-contract behavior and table-state purity, NOT payment, dispatch admission, finance arithmetic or rescue concurrency. Existing domain invariant tests remain authoritative for those concerns.

The verifier checks exact projection keys/private sentinel exclusion, scoped denial with known IDs, pre-query denial, bounded source availability, current attention disappearance, unproven handoff, assigned rescue rejection, persisted health, focused legacy authorized reads/denied writes, and same-cookie revocation after owned-backend restart. It fingerprints private domain/evidence/work tables and the native Order before/after reads. It creates no provider operations and never changes an existing public financial/delivery row. Only its own generated schema and synthetic identities/empty Order are cleaned up.

`operations-verification-scope.ts` is inert without an environment-selected test schema. It requires NODE_ENV/APP_ENV=test, an `_test` database, Redis /1, exact generated schema/run marker; requests cannot choose their schema or grants. The launcher explicitly selects the existing gospaza_m18_c2b_test database and refuses a conflicting shell selection. It does not create/drop databases or modify .env. The verifier owns port 9000 and refuses an existing server. Native identities remain real; there is no auth bypass.

Verification status: B is user-verified, and the user confirmed all final D checks passed on 2026-11-07, including workspace typecheck, builds, direct API acceptance and browser journeys. Source query latency/plans were not benchmarked; old placeholder-principal fixtures require explicit actor/grant adaptation if subsequently selected. No assertion of complete historical write-path regression coverage is made. M23 is complete and verified; no later milestone work is begun by this record update.

## Commands for user to run

Repository root, Windows PowerShell, one at a time; stop on every failure:

1. `pnpm run lint` — zero warnings/errors.
2. `pnpm run typecheck` — all workspace typechecks pass.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/operations-policy.test.ts tests/operations-boundary.test.ts` — all targeted policy/boundary tests pass.
4. `pnpm --filter @gospaza/api-client exec tsx --test tests/operations.test.ts` — all client tests pass.
5. `pnpm --filter @gospaza/backend run build` — built backend generated successfully.
6. Stop any existing backend on port 9000, then `pnpm --filter @gospaza/backend run test:operations-environment -- gospaza_m18_c2b_test` — sanitized isolated summary, M23-B proof message and Finished executing script. Requires the existing carried-forward test database to have all previously approved migrations. No new B migration.

Do not run broad historical finance/dispatch suites merely for this read slice. Focused old-domain read/denied-action regression is embedded in step 6. If later evidence identifies a specific mutation regression, run the smallest affected owner test with valid native actor/grant setup.

## C handoff

C alone owns Delivery rescue admission, new generation g+1 and associated forward constraint migration, receipt/audit/idempotency, rollback/concurrency proof, and operations admin UX. B supplies no rescue route, native mutation, schema expansion, UI, persistent work-item/notes model, MFA, provider change or later-milestone implementation.
