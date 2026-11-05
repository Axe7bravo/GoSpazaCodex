# M21 — Driver earnings

## 1. Authority and slice status

M21-A is the approved durable policy contract. This slice introduces documentation only. M20 is complete and merged. M21-B compensation terms/assignment snapshots, C recognition, D payment accounting and E UX each require separate implementation instructions and user verification. This contract does not authorize M22 notifications, M23 operations or later milestones.

Authority inspected: `AGENTS.md`, `docs/build/BUILD_PLAN.md`, `docs/product/PRD.md`, `docs/ux/UX_SPEC.md`, M15–M17 lifecycle contracts/implementation, M19 recognition and M20 settlement/payment patterns. The current M21-A approval governs the decisions below. No production compensation amount is approved here.

## 2. Ownership and money

M21 owns prospective driver compensation terms, commitment-time snapshots, driver earning recognition, append-only earning records/exceptions, manual external driver payment recording, allocations, reconciliation and driver/platform projections.

M21 does not own customer delivery pricing, merchant commission/settlements, M20 payouts, customer refunds or native commercial fulfillment/payment state. In particular:

```text
marketplace_service_zone.delivery_fee_minor
delivery_reservation.quoted_fee_minor
≠ driver compensation
```

Customer fees, M19 economics and M20 payable amounts never supply a driver rate or payer. Current ServiceZone pricing cannot reconstruct historical driver terms. Driver payments never consume M20 statements or deduct driver pay from merchant settlements.

Currency is ZAR (`zar` at repository persistence/API boundaries). All amounts use checked integer minor units, never floating-point financial arithmetic. Exact database bigint readbacks must not lose precision in DTOs or presentation.

Medusa ownership decision: the pinned Medusa 2.18.0 native module surface does not supply marketplace driver compensation/payment accounting. M21 will be a small GoSpaza Finance extension referencing existing DriverProfile, Delivery, commitment, native Order and fulfillment evidence. Native Medusa remains owner of authentication, commercial Orders, fulfillment and customer payments/Store Credit. No driver wallet or duplicate commerce engine is authorized.

## 3. Payer and compensation structure

| Authoritative committed classification | Initial M21 treatment |
| --- | --- |
| PLATFORM with applicable frozen GoSpaza payer terms | GoSpaza payer; one flat ZAR amount per successful ordinary delivery may become earned. |
| MERCHANT | No GoSpaza-payable earning. Operational affiliation does not create platform debt or merchant payroll liability. |
| Missing/contradictory payer or compensation evidence | Unresolved; no invented amount or attribution. |

Only one platform flat amount is supported initially. No distance/GPS pricing, zone premium, merchant override, restricted/alcohol premium, percentage of shipping or base-plus-distance formula is approved. Dispatch mode is routing configuration, not compensation pricing: use the immutable committed path/affiliation and payer snapshot, including a PLATFORM commitment after HYBRID fallback. Current affiliation is not historical authority.

Future merchant-funded or GoSpaza-funded merchant-driver compensation requires explicit prospective payer terms. Do not infer historical payer responsibility. Merchant-driver completion is a known no-GoSpaza-payable classification under this policy, not an R0 earning or a conclusion about the driver's external employment compensation.

## 4. Prospective terms and activation

Versioned terms must retain payer type, driver applicability/affiliation scope, amount_minor, currency, effective_at, recorded_at, revision, bounded reason and publication actor. Preserve publication/request identity and audit according to repository conventions. Decisions are append-oriented; historical decisions cannot be edited into different rates.

Require explicit publication and prospective activation. No production rate is seeded by migration, startup, fixture code or a fallback. Test fixtures may publish clearly synthetic terms.

Publication cannot take effect before its authoritative recording/publication time. Immediate/future publication must follow the existing server-clock and publication-serialization conventions; a caller's clock cannot authorize backdating. Publication and assignment selection must share a database boundary so an earlier-started transaction cannot later insert retroactive applicable terms.

Select only the applicable published terms at authoritative assignment time. Later rates do not reprice an existing snapshot. Persist enough publication identity/evidence to reproduce that selection without consulting today's rate.

Absent applicable terms produce `MISSING_COMPENSATION_TERMS`, not R0, customer shipping or a current-rate guess. An ordinary production assignment cannot acquire a payable compensation snapshot without applicable terms. Recognition must fail closed. **M21-B clarification approved by the user:** for an active postactivation platform offer, reject ACCEPT, retain the unaccepted offer and record one deduplicated missing-terms exception. Do not commit an unresolved payable assignment. Preactivation behavior remains historical/review-only; all other M15 admission/capacity predicates remain authoritative.

An explicitly published zero and missing terms are distinct. Zero is valid only if deliberately published and permitted by an explicitly approved zero-rate policy; A supplies no production zero-rate authorization/default. B must not treat missing as zero. Zero-rate admission/payment semantics must be settled explicitly before enabling that capability.

Existing preactivation commitments without snapshots remain historical compensation unresolved/review-only. Never attach today's terms retroactively, even if completion occurs after activation. Completion before activation is likewise historical review, not automatic unpaid debt. No app payment record does not prove no external payment occurred. Catch-up requires separately approved evidence/policy; no historical earnings/payments are synthesized.

## 5. Assignment-time snapshot

Freeze compensation when the assignment/dispatch commitment becomes authoritative: M15's successful ACCEPT transition to ASSIGNED, not offer creation, driver intent, pickup or completion. Bind the snapshot to:

* DriverProfile, Delivery and immutable commitment;
* merchant/store context and committed affiliation/path evidence;
* payer classification and compensation resolution;
* currency and amount only where authoritatively resolved;
* terms identity/version/effective time and authoritative snapshot time;
* source revision/identity and bounded audit evidence.

Exactly one immutable resolution belongs to a commitment. Missing terms have no numeric payable compensation. Merchant classification has no GoSpaza payable. Keep those distinct from a resolved published rate.

Snapshot persistence and the authoritative assignment decision must be atomic. Duplicate acceptance/readback must reuse the same resolution, not select newer terms. A failed assignment must not leave an independently payable snapshot. Rate-publication/assignment races must have a defined database linearization point. No external calls or process-local mutex may establish this authority.

## 6. Ordinary earning source and identity

One unique successful completion establishes at most one ordinary successful-delivery earning. Recognition requires the committed M16/M17 evidence chain:

```text
delivery_completion.state = SUCCEEDED
native_done and valid retained native completion receipt
successful immutable SHIP operation and matching native fulfillment
consumed handoff generation
dispatch_commitment = COMPLETED
Delivery = DELIVERED
authoritative completion audit
matching compensation snapshot
```

Historical performer identity is `delivery_completion.commitment_id → dispatch_commitment.driver_profile_id`. Cross-check Delivery/Order, SHIP input/manifest, fulfillment, commitment and audit. Never reattribute through a browser driver ID, current affiliation or current merchant membership. Restricted completion must also have same-generation satisfied recipient evidence under M17; M21 references that proof without copying sensitive recipient observations.

Economic time is authoritative `Delivery.delivered_at`; recorded time is the earning transaction's database time. OTP success, workflow designation, native timestamp alone, arrival or pickup does not establish an earning. A technically ambiguous completion remains unresolved until the existing M16 observer proves terminal success; M21 cannot invent it.

`gospaza.delivery-completed` is an accelerator, not economic authority. Event handling re-reads persisted evidence. Event, duplicate event, explicit repair and concurrent recognizers invoke one recognition primitive. PostgreSQL uniqueness on compensable source identity/earning type, source validation and atomic audit prevent duplicate earnings. A differing fingerprint for the same source fails closed rather than overwriting history.

## 7. Failure, restricted return and reassignment

Accepted-but-uncollected work, pickup without completion, recipient unavailability/refusal, wrong/expired OTP, technical ambiguity and merchant cancellation before pickup do not establish the ordinary successful-delivery earning. This is not a determination that exceptional work is forever worth zero. Special compensation remains unresolved unless separately approved.

Age/ID/compliance failure means no ordinary successful-delivery earning. M18 refund amounts, retained shipping and merchant economics cannot supply an attempt fee. M17 return custody records RETURN_REQUIRED → RETURNING_TO_STORE → RETURNED_TO_STORE and retains the commitment/SHIP/receipt lineage; it does not price the outbound attempt or return trip. Initial return-trip compensation remains unresolved. No second full fee, copied customer fee or arbitrary return amount is authorized.

MVP has no split earnings. Existing dispatch commitments are immutable and ordinary reassignment is not a shipped operational command. A-pickup/B-completion contradictions withhold recognition and create an exception. A future reassignment feature must first establish explicit custody/performer lineage; M21 does not implement handover percentages or an operational override.

## 8. Append-only financial concepts

Proposed logical records (exact implementation names may follow repository conventions):

| Record | Authority |
| --- | --- |
| driver_compensation_terms | Prospective published payer/applicability/rate decisions and audit. |
| driver_compensation_snapshot | Immutable assignment-time resolution and original terms. |
| driver_earning | Successful source, performer and frozen economic amount. |
| driver_earning_exception | Deduplicated missing/conflicting source or terms evidence; no invented numeric earnings. |
| driver_payment | External payment accounting/evidence, not a bank instruction. |
| driver_payment_allocation | Exact whole earning consumption by a payment. |
| driver_payment_reconciliation | Separate matching/review assertion. |
| driver_payment_discrepancy / attention evidence | Uncertainty or conflict without rewriting payment history. |

An earning freezes driver, Delivery, Order, commitment/completion, merchant/store context, payer, earning type, amount/currency, snapshot/terms reference, economic_at, recorded_at and source identity/fingerprint. Database FKs, unique source keys, immutability and audit consistency must enforce the relationships.

No mutable balance field is authority. Derived unpaid totals come from immutable earnings and allocations/reservations, with unresolved/held entitlement distinguished from available unpaid earnings. Payment accounting does not rewrite the earning.

Future corrections must append an entry referencing the original earning. Negative adjustments, clawbacks and arbitrary admin debit commands are not approved initially. Paid history must not be rewritten by a later rate, refund, return or complaint.

## 9. Manual payment accounting and allocation

There are no automatic daily/weekly driver settlement periods, merchant settlement batches, carry cycles or banking integration. An authorized operator selects whole unpaid, unreserved earnings for one driver, one payer and one currency, and records one externally performed payment.

The server derives the driver and exact total from selected authoritative earnings. A submitted observed amount is evidence and must equal that total. Enforce checked integer aggregation; no partial/excess amount, mixed driver/payer/currency or fabricated earning may pass.

```text
DriverPayment → immutable PaymentAllocation → DriverEarning
```

Each successful allocation consumes the whole earning. Database uniqueness prevents successful consumption twice. No installments, residual earning balance, partial allocation or split successful payments are supported. Selection alone is not proof that money moved; stale selection must be revalidated under locks.

For a successful external payment record require server-derived driver/selection/total, currency, actual timestamp, channel, origin account/channel reference, external transaction identity, verified beneficiary reference, actor, reason and confirmation. Use bounded opaque references, not credentials or public proof URLs. Reserve a durable external identity rather than correlating by driver/amount or narrative alone. Final D policy must define identity scope/channel normalization and timestamp validation explicitly before implementation.

An uncertain external attempt is not successfully paid and must not release selected earnings for another payment. Durable reservation/attention must preserve the selected entitlement until outcome is authoritative. Pending/uncertain reservations and successful allocations must share a single consumption boundary; independent tables must not each permit a second claim. Exact D states and safe evidence-based resolution rules require D approval. No guessed success, automatic retry or release on timeout is authorized.

Reconciliation is a separate authorized assertion that recorded evidence matches selected earnings, exact amount, beneficiary and payment identity. Recorded payment is not reconciled payment. Discrepancies preserve history and block assertions of certainty where unresolved. D may reuse M20 principles without copying merchant period/preparation machinery. No new failed-payment/retry/reset semantics are implicitly approved by this A contract.

## 10. Actor projections and authorization

Driver self-read derives DriverProfile from the authenticated native driver identity and exposes only that driver's earned/unpaid/payment-recorded/reconciled/unresolved records and bounded references/dates. `/driver/earnings` is the approved UX entry point. Totals are server-derived; no withdrawable wallet is implied.

Operational suspension may block new work but does not revoke authenticated access to historical financial records. Native identity/session revocation still denies access. Do not use present dispatch eligibility to erase prior earnings or deny historical self-read.

Merchant actors have no M21 financial read or mutation, including merchant-affiliated driver amounts, unpaid totals, payment references/status. Existing operational visibility is unchanged. Customers have no M21 access.

Platform authority uses separate explicit capabilities (repository-equivalent grant names allowed):

| Capability | Scope |
| --- | --- |
| DRIVER_EARNINGS_VIEW | Ordinary platform earning/payment projections. |
| DRIVER_COMPENSATION_MANAGE | Prospective terms publication. |
| DRIVER_PAYMENT_RECORD | External payment accounting evidence/commands. |
| DRIVER_PAYMENT_RECONCILE | Separate reconciliation. |

No grant implies another, M20 grants do not confer M21 authority, and FINANCIAL_VIEW/COMMISSION_CONFIGURE/refund/goodwill permissions do not confer these grants. Recheck native actor and current capability per request and after relevant write-lock acquisition. A stale session is not a permission lease.

Platform ordinary projections and narrower sensitive payment evidence must be separate. Driver projections exclude platform-private notes, origin account details, proof internals and other drivers. No financial projection copies OTP, GPS, DOB/ID or recipient observations. Routes validate strict shapes; owning services decide. Known resource IDs never grant authority; no generic CRUD/status edit bypass is allowed.

## 11. Locking, concurrency and repair

Assignment integration preserves the existing operational prefix: sorted merchant rows → DriverProfile → affiliation → availability → OrderOperation → picking → Delivery → commitment. Snapshot selection/write must fit that transaction without reversing an existing lock dependency. Publication has an explicit shared selection boundary; final B SQL must document its order and verify all publishers/assignment callers before implementation.

Recognition runs after committed completion in a separate short finance transaction. It validates immutable source lineage; it must not call finance back into an in-progress handoff mutation or acquire a driver lock then request the operational merchant-first prefix. Neither current eligibility nor M19 merchandise recognition success is an extra authority for driver compensation.

Payment locking direction: driver → earning IDs in deterministic order → payment → allocations → evidence/reconciliation. It must not subsequently acquire merchant/operational locks. Final SQL must verify the complete dependency graph, including global external-payment identity uniqueness, reservations and audit. No Redis/process-local lock is sole financial authority.

Prove duplicate event/two recognizers/event+repair convergence, publication+assignment ordering, replay after rate change, conflicting performer lineage, return/completion exclusion, payment recorder/allocation races, reused payment identities and transactional audit rollback. Preserve M15 single active capacity; M21 does not redesign it.

Bounded keyset repair may find committed successful completions missing recognition, invoke that same primitive, surface exceptions and inspect payment/allocation consistency. C/D must define finite page bounds/cursors. Repair cannot manufacture delivery/payment evidence, invent terms, apply current rates historically or rerun native handoff. Unpaid without allocation is normal. Unknown outcomes remain reserved; no generic recovery reset is authorized.

## 12. Security acceptance design

| Source → transformation | Trust boundary → sink | Required proof |
| --- | --- | --- |
| Browser driver/resource ID → strict lookup | Native actor/self ownership → DTO | Foreign known/missing IDs denied without cross-driver disclosure. |
| Completion/event → persisted lineage validation | Immutable terminal source → earning | Fake completion, duplicate source and changed fingerprint rejected; event loss repair converges. |
| Rate decision → server-clock publication | Explicit capability/database boundary → snapshot | No backdating, retroactive repricing or missing-as-zero. |
| Observed payment/selection → exact server sum | Action grant/locks/uniqueness → allocation | No forged amount, mixed ownership, double allocation or reused identity. |
| Repair input → bounded source scan | Internal authorized primitive → ledger | No amount/source override or manufactured completion/payment. |
| Financial records → role allowlist | Actor projection → UI/logging | No merchant leakage, sensitive evidence exposure or secret logging. |

These are required future executable tests, not runtime verification claimed by A. Static audit identified no confirmed critical/high/medium vulnerability in the inspected dependencies; M21 financial implementation has not been created. Review injection, mass assignment, BOLA/BFLA, grant revocation and generic native/custom CRUD bypasses in each implementation slice. Sensitive evidence must not enter ordinary logs or browser storage.

## 13. Worked examples — synthetic amounts only

R50/R60 below are explicit test publications, never production defaults.

| Scenario | Expected result |
| --- | --- |
| Platform commitment with published R50 (5000 minor units), postactivation successful completion | One GoSpaza earning of 5000, with completion economic time. |
| Terms R50 → R60 after commitment | Existing commitment completion earns 5000; a new commitment under R60 freezes 6000. Delayed recognition does not reprice either. |
| Missing terms at assignment | MISSING_COMPENSATION_TERMS, no payable numeric snapshot; recognition unresolved, not zero. |
| Merchant-affiliated successful completion | No GoSpaza-payable earning; no merchant payroll or M20 debit. |
| Duplicate completion event | Same single earning; no second effect. |
| Event and repair race | One source-unique earning/audit outcome. |
| Recipient unavailable | No ordinary successful-delivery earning; exceptional compensation unresolved. |
| Alcohol age/ID failure and proven return | No ordinary successful-delivery earning; outbound/return compensation unresolved. |
| Preactivation completion | Historical review candidate, no automatic unpaid debt. |
| Two whole unpaid R50 earnings, same driver/payer/ZAR | One exact R100 (10000) external payment may fully allocate both. |
| Two attempts to allocate the same earning | At most one consumption; competing allocation rejects without duplicate payment evidence. |
| Observed R75 against R100 selection | Reject; no successful payment/allocation or partial residual. |
| External payment outcome unknown | No successful-paid assertion; selected earnings stay reserved for evidence-based review. |
| Operationally suspended, native-authenticated driver | Historical self-read remains; new work may be blocked. Native identity/session revocation denies read. |
| A pickup / B completion contradicting commitment | Recognition exception; no split or reassignment shortcut. |

## 14. Proposed implementation boundaries and verification

| Slice | Scope | Minimum proof |
| --- | --- | --- |
| B — terms and snapshots | Forward persistence, strict prospective publication, explicit activation, immutable assignment compensation resolution and bounded exceptions/readback needed internally. No earned posting/payment/UX. | Currency/integer/rate scope; missing versus zero; effective/exact activation boundaries; forbidden backdating; concurrent publishers; publication versus assignment; duplicate ACCEPT/readback; rollback; immutable driver/payer/terms binding; merchant no-platform-payable; historical no-current-rate backfill; fresh grants. |
| C — earnings | Source-validated append-only recognition/exceptions and bounded repair/event integration. | Real M16/M17 evidence; duplicate creators/event+repair; technical ambiguity; restricted success/failure/return; conflicting performer; historical/missing terms; rate changes after commitment; audit/deferred COMMIT rollback. |
| D — payment accounting | Approved exact manual payment/reservation/allocation, evidence, separate reconciliation and attention. No bank API. | Exact sum/full allocation, mixed driver/payer/currency denial, concurrent selections/recorders, global identity reuse, unknown holds, replay/staleness, reconciliation, grants and audit rollback. Freeze exact D states/identity/resolution policy before coding. |
| E — projections/UX and final acceptance | Own-driver historical finance and explicit platform operations, role-safe DTOs/clients, small real-API journeys. | Foreign-driver/merchant/customer denial, projection allowlists, suspension self-read/native revocation, per-request platform grants, persisted financial state after refresh, no private financial storage/logging. |

Use the existing isolated `_test`/Redis1 verifier and user-run verification convention. Do not rerun unrelated M15–M20 suites. A narrow assignment integration may require the smallest affected M15 acceptance/atomicity regression, not redesign of dispatch. M25 performance/harness debt remains separate.

Proposed B persistence is terms/publication audit, explicit activation and unique immutable commitment-resolution snapshot, with only the bounded missing/conflicting resolution evidence needed for B. Use FKs and commit-time consistency for assignment linkage; do not add C earning or D payment tables early. The assignment boundary is `DispatchService.decide`'s authoritative ACCEPT transaction, preserving its replay behavior and existing eligibility/readiness/capacity locks. No public client chooses rate, payer, amount or another driver.

## 15. Remaining rollout inputs and stop boundary

The actual production rate, publication actor/grants and activation instant remain explicit deployment inputs. Failure/return compensation, historical catch-up and negative corrections are intentionally unresolved/deferred, not implied authorizations. Zero-rate enablement needs explicit policy; D must settle exact payment identity/state/uncertainty-resolution details before implementation.

M21-A is complete as a policy/documentation slice and ready for user review. No schema, production code, terms publication, assignment hook, earnings, payments, UI or tests have been implemented by A. No verification commands were run and no commit was made. Stop before B; a separate instruction is required to implement it.

## 16. M21-B implementation — user-verified before M21-C

### Persistence, native boundary and publication

Forward migration `Migration20261108120000` installs SQL-owned `driver_compensation_terms`, singleton `driver_compensation_activation`, `driver_compensation_snapshot`, `driver_compensation_exception` and append-only `driver_compensation_audit`. No native Medusa entity is replaced or duplicated and no earning/payment table is added. Each top-level migration statement is separate; each PL/pgSQL function uses one named-dollar-quoted statement with an internal END semicolon. Migration rollback is transactional; destructive down migration is refused.

Terms are PLATFORM_FLAT / PLATFORM affiliation / GOSPAZA payer / ZAR only, positive safe-integer minor units. Zero is rejected because its enablement is unapproved. No default rate or activation is inserted. Immediate effective time equals authoritative database publication time with its microseconds retained; a submitted future instant cannot precede that time. Revision/effective/request uniqueness and immutable history apply. Publication and activation require confirmation, reason, expected revision and request identity; exact same-command replay returns the original decision and changed replay conflicts. Activation is a one-time prospective decision, not a mutable operational toggle.

`DRIVER_COMPENSATION_MANAGE_USER_IDS` authorizes configuration publication/activation/inspection. `DRIVER_EARNINGS_VIEW_USER_IDS` permits the bounded B read surfaces only. Management can inspect its own configuration domain, without acquiring the future global earnings-view capability. Neither permission is inferred from native driver administration, commission, financial/refund/goodwill or settlement grants. Native User existence and grants are checked before/after relevant locks and before completing publication. No grant is seeded; `.env.example` contains empty documented keys.

### Assignment boundary and resolution states

`DispatchService.decide` integrates only the ACCEPT branch, after existing eligibility/readiness/affiliation locks. Existing replay returns before any new rate selection. Publication uses exclusive advisory transaction lock `21021001`; assignment acquires its shared counterpart after the operational prefix and **before the final live location check**, so publication waiting cannot silently age that final check. Publishers acquire no merchant/profile/order locks. Selection then captures database time and chooses committed terms effective at that exact instant, ordered by effective time/revision. The assignment timestamp is copied into PostgreSQL without a JavaScript microsecond round trip.

After activation, a PLATFORM commitment freezes `RESOLVED_GOSPAZA_PAYABLE`, its positive amount, original terms identity/revision/effective time, activation/policy identity, exact assignment time, snapshot time and immutable performer/tenant/affiliation/payer lineage. MERCHANT commitments freeze `RESOLVED_NON_GOSPAZA_PAYABLE`, null amount and no platform terms. They do not need a platform rate and are not classified missing.

The approved missing-terms clarification supersedes A's earlier unresolved-admission wording: the active platform offer stays OFFERED; no assigned commitment, snapshot or assignment audit is written. Exception plus audit commit, then the domain returns `409 MISSING_COMPENSATION_TERMS` outside the transaction. Repeated attempts deduplicate by commitment/reason. Normal expiry/decline/offline rules still own the unaccepted offer; compensation does not extend its deadline. A later explicit driver acceptance can succeed after terms are published, provided all operational predicates still pass. No automatic acceptance replay occurs. The historical missing-attempt exception remains evidence and does not overwrite the later resolved snapshot.

Before activation (including absent/future activation), assignment does not acquire payable compensation. B creates no numeric or synthetic historical snapshot. Authorized reads derive `HISTORICAL_PREACTIVATION`; inspection may append its deduplicated exception. Thus two states are stored as immutable successful snapshots and two are explicit resolution/read/exception outcomes; missing/historical are never fake R0 snapshots. Existing commitments are not backfilled with today's terms.

Snapshot insert guards re-read the immutable commitment, Delivery, exact selected activation/terms and amount. Unique commitment identity prevents repricing. Update/delete is rejected. A deferred trigger on new OFFERED → ASSIGNED transitions requires the matching postactivation snapshot at COMMIT; snapshot/publication/exception audit checks also run at COMMIT. Any later failure rolls back assignment, Delivery, snapshot and audit together. The domain preserves M15's single occupied capacity and native commerce behavior. No M16/M17 completion/handoff code is changed.

### B reads and bounded inspection

* `GET/POST /admin/gospaza/driver-compensation`: bounded term history/current decision and publication.
* `POST /admin/gospaza/driver-compensation/activation`: explicit activation.
* `GET /admin/gospaza/driver-compensation/commitments/:id`: explicit snapshot/resolution and bounded reason/time history.
* Internal `drivers:repair-compensation`: requires `M21_COMPENSATION_USER_ID` plus the management grant; at most 25 assigned commitments per pass, ascending ID, optional exclusive `M21_COMPENSATION_AFTER`.

Reads are allowlisted, private/no-store and platform-only. They omit request fingerprints and internal audit objects. There is no driver/merchant snapshot endpoint or final UI. Current published terms and activation are reported separately; publication alone does not enable earning. Unknown IDs are checked only after authorization. Strict bodies/query/params reject payer/driver/scope/currency/recorded-time mass assignment. Responses are bounded and do not expose SQL.

Inspection never updates a snapshot, assigns a driver, runs native handoff or invents rates. It classifies missing preactivation snapshots as historical, missing postactivation snapshots as `SNAPSHOT_MISSING` and inconsistent immutable lineage as `SNAPSHOT_CONFLICT`; exceptions are deduplicated. A valid old snapshot remains frozen despite current affiliation or rate changes. B does not reconstruct missing postactivation snapshots because no exact original assignment resolution is available.

### Verification and security

`driver-compensation-policy.test.ts` covers strict positive ZAR configuration, unapproved zero, state distinctions, independent grants/revocation and non-platform handler denial. `test:driver-compensation` uses the real M15 Order/picking/driver/Redis/offer fixtures and actual ACCEPT service transaction, not mocked eligibility or direct assignment seeding. Its compensation SQL is installed into a generated private schema on the existing `_test` database. Native operational input remains real and is cleaned by the existing fixture; the private schema is removed before that cleanup. The applied public deferred assignment trigger is exercised with the request/transaction search path. No public rate or activation is published. The verifier refuses an already activated public compensation database so baseline M15 behavior remains deterministic.

The PostgreSQL proof covers prospective publication/activation, exact microsecond boundaries, merchant known non-payable classification without terms, missing-term rejection/deduplication with capacity retained, R50→R60 rate freezing, duplicate/concurrent acceptance, competing publishers and publisher/acceptance ordering, future terms, revoked/unrelated grants, forged fields, immutable direct mutation, snapshot-audit failure rollback and a real deferred-COMMIT missing-snapshot negative control. Fault injection is restricted to private fixture tables; no public protection is disabled. The historical inspection proof does not mutate assignments or apply current terms.

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK review:

| Path | Implemented boundary |
| --- | --- |
| Publication body → strict decision → current native user/manage grant → immutable rate/audit | Fixed payer/applicability/currency; positive integer amount; database clock, revision and replay guards. |
| Driver ACCEPT → existing operational admission → shared publication boundary → snapshot/assignment | Server-derived driver/affiliation; no rate input; original exact terms; missing terms retain offer. |
| Native commitment → binding guard → deferred snapshot/audit consistency → persisted history | Unique commitment snapshot; immutable lineage; no generic custom CRUD registration. |
| Known ID → explicit platform read permission → allowlisted resolution DTO | No merchant/customer/driver access, fingerprints or sensitive operational evidence. |
| Repair cursor → bounded immutable-source inspection → same exception/audit boundary | No retroactive pricing or assignment/native mutation. |

No confirmed critical/high/medium finding remains from static review. Runtime security/concurrency remains user verification, not a claimed pass. No verification command was run by Codex, no dependency was changed and no commit was made.

### Commands for user to run

Repository root, one PowerShell command at a time; stop on the first failure:

```powershell
pnpm run lint
pnpm --filter @gospaza/backend run typecheck
pnpm --filter @gospaza/backend exec tsx --test tests/driver-compensation-policy.test.ts
pnpm --filter @gospaza/backend run build
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; pnpm --filter @gospaza/backend run test:driver-compensation-migrate
```

Expected: clean lint/typecheck, passing policy tests/build, then migration success against the established `gospaza_m18_c2b_test` database carried forward from M18–M20. The explicit shell DATABASE_URL is required in this workflow: the command preserves the configured connection credentials/options from `.env`, changes only the database pathname and captures the URL without printing credentials. The companions already preserve an explicitly selected `_test` database and reject an explicit non-`_test` target. With no shell override, the shared helper's valid generic fallback derives `gospaza_test` from `gospaza`; that is not the established database for this repository. No test database name is hardcoded in application/shared-helper configuration.

The migration/start companions reuse `isolatedEnvironment` unchanged, preserving `.env` secrets, Redis /1, NODE_ENV=test, APP_ENV=test and disabled payment/refund recovery workers. They create/drop no database and edit no environment file. No production rate/activation is supplied. Keep the selected DATABASE_URL in terminal A for subsequent `test:isolated` calls.

In a second terminal at repository root, leave the **built isolated** backend running:

```powershell
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; pnpm --filter @gospaza/backend run test:driver-compensation-server
```

Expected: sanitized `_test`/Redis1 summary and listening backend. Dispatch/pickup/handoff workers are disabled for these fixtures. Do not simultaneously run another backend on the configured port or another verifier against these fixture resources.

In the first terminal:

```powershell
pnpm --filter @gospaza/backend run test:isolated -- test:driver-compensation
pnpm --filter @gospaza/backend run test:isolated -- test:dispatch
```

Expected: the B verifier completes all assertions; then the targeted standalone M15-B regression reports M15-B passed. This existing verifier owns acceptance, duplicate decision, capacity, offline/location/affiliation admission and race invariants. B already uses its native prerequisites; the final standalone run checks that the private B fixture/activation left no changed public dispatch state. No M16–M20, browser or unrelated checkout regression commands are added; inherited M15 prerequisite composition remains unchanged.

### C handoff and remaining inputs

B was subsequently user-verified before C was authorized, including the targeted verifier pagination correction. Production rate, activation instant and actual authorized users remain explicit rollout inputs; no code default is provided. Zero remains rejected. C implementation is recorded below; B's assignment/snapshot production paths remain unchanged.

## 17. M21-C implementation — user-verified

### Ownership, schema and source authority

Forward migration `Migration20261109120000` adds SQL-owned append-only `driver_earning_recognition`, `driver_earning`, `driver_earning_exception` and `driver_earning_audit`. No native Medusa state, B table/trigger, assignment, pickup or handoff/completion production code is altered. Each top-level SQL statement is separate, with named-dollar-quoted functions and complete PL/pgSQL terminators. There is no production rate/activation seed, new dependency or destructive down migration.

This remains the small GoSpaza Finance extension justified in A/B: Medusa owns native commercial Order/fulfillment/payment state; M16/M17 own terminal completion and restricted handoff; B owns the immutable rate/payer snapshot. C directly reads the persisted operational proof as a documented immutable input contract, following M19's recognition pattern. It neither repeats native mutation nor queries current native quantities/prices, current compensation rates, ServiceZone fees, current affiliation or merchant economics to price a driver earning.

`gospaza_driver_earning_source` is the shared SQL provenance validator used by both the recognition primitive and insert guards. It checks successful/native-done completion, retained native receipt and workflow identity, COMPLETED commitment, DELIVERED Delivery with physical timestamps, exact SHIP/PREPARE/native fulfillment linkage, immutable SHIP driver/Order/commitment/manifest references, completed picking fingerprint, OrderOperation identity, consumed generation and original DELIVERED/NATIVE_DELIVERED_PROVEN audits. A restricted successful source additionally requires same-generation SATISFIED recipient evidence bound to the same driver/commitment. Receipt date format/data is validated without making current native API calls. This consumes M16's committed native proof rather than treating a mutable native timestamp or event payload as fresh financial authority.

The historical driver is always completion → commitment → DriverProfile. The snapshot must match that driver, Delivery, merchant/store, assignment instant, committed affiliation/path, original activation, payer and resolution. No current affiliation or eligibility lookup is involved. The ordinary amount is copied directly from the frozen B snapshot inside PostgreSQL. Economic time is copied exactly from Delivery.delivered_at; database recording time is separate. Original terms identity/revision/policy and snapshot reference are retained; no current-rate lookup occurs even on repair/replay.

### Outcomes, uniqueness and exceptions

Only SUCCESSFUL_DELIVERY creates an earning, with positive integer minor units, ZAR and GoSpaza/PLATFORM payer classification. The row freezes performer, Delivery/Order/commitment/completion, merchant/store, snapshot/terms, economic/recorded times, original event/revision and a bounded source fingerprint. There is no paid boolean, balance, payment record or allocation. D will derive financial settlement state from its separately approved allocation model.

One valid completed merchant-affiliated NON_GOSPAZA_PAYABLE snapshot creates an audited recognition outcome without a driver earning, numeric zero, payroll liability or M20 deduction. A preactivation completion/assignment remains HISTORICAL_REVIEW with no monetary row; reads can derive that candidate state from retained operational evidence without creating unpaid debt or a synthetic snapshot. Completed restricted return is NO_ORDINARY_EARNING. Incomplete/failed/OTP-refused/technically ambiguous work is PENDING for ordinary earning purposes and creates no ordinary monetary effect. Special attempt/return compensation remains unresolved policy.

Postactivation missing snapshots, conflicting snapshot performer/identity, payer/path contradiction and invalid completion proof create deduplicated earning exceptions. Exceptions bind authoritative source context, stable source identity, bounded reason, database time and immutable first metadata. That metadata contains source state/reason, original/observed fingerprints and snapshot identity, not recipient observations, receipt contents or PII. Re-observation never overwrites the first conflict. There is no generic resolution command.

Source changes discovered after recognition append SOURCE_CONFLICT/attention and preserve the original earning unchanged. Existing exceptions block creation of a new earning; no automatic clearing or correction is introduced. Future D must respect attention rather than treating an existing earned amount alone as unconditional payment admission. No negative correction, clawback, attempt fee, return fee or bonus is implemented.

Recognition is source-unique per Delivery/completion/commitment, with unique earning per recognition/source. SQL insert guards independently verify frozen amount/identity and original proof. Deferred consistency requires an EARNED recognition to have exactly one matching earning, a non-payable outcome to have none, and recognition/earning/exception rows to have matching append-only audit. All persistence commits or rolls back together. The source fingerprint is a deterministic integrity checksum over bounded immutable proof, not an authorization secret; foreign keys, source guards and uniqueness are the correctness boundary.

### Event, locks, repair and reads

New subscriber `recognize-driver-delivery.ts` listens to the existing post-commit `gospaza.delivery-completed`, with its own stable subscriber identity. It validates/extracts only Order identity; event-provided amount, driver, payer or status is ignored. It calls `DriverEarnings.recognize`. Infrastructure errors remain failed subscriber executions, not invented financial exceptions/success. Duplicate delivery/event/ACK loss re-observes the original row. No M16/M17 finance callback is added.

Recognition runs in a separate short transaction using finance-only PostgreSQL advisory locks: driver-finance identity, then Delivery-recognition identity. It takes no merchant, profile/affiliation eligibility, OrderOperation, picking, Delivery, commitment or handoff row lock, and performs no external native/Redis mutation. A changed source driver between observation and the locked reread defers without acquiring a second driver lock or reattributing money. Operational lock hierarchy is not reversed. Database uniqueness remains final authority even for a caller bypassing the service lock.

Internal `drivers:repair-earnings` invokes the same recognition primitive for at most 25 successful/native-done DELIVERED completions, ordered by completion ID. `M21_EARNINGS_AFTER` is exclusive; optional `M21_EARNINGS_THROUGH` is inclusive. It discovers missing recognition and revalidates existing outcomes for replay/integrity. It returns bounded items, deferred IDs and a cursor; it never loops indefinitely, completes a delivery, runs native handoff, prices an old snapshot or manufactures payment evidence. Unpaid/unallocated earnings are not stuck work. No new worker/scheduler or M22 infrastructure is introduced; an operator must run/follow the bounded repair sweep to cover missed events.

`GET /admin/gospaza/driver-earnings/orders/:id` is the only new actor-facing surface. Native platform User plus explicit DRIVER_EARNINGS_VIEW are required before resource lookup and rechecked before return. Compensation management, M20 and other finance grants do not imply this read. The explicit allowlisted DTO distinguishes EARNED, NON_GOSPAZA_PAYABLE, HISTORICAL_REVIEW, PENDING_RECOGNITION, operational non-earning and UNRESOLVED/attention. It preserves an original earning alongside attention. It exposes no receipt/OTP/GPS/compliance data, fingerprints, private audit or exception evidence. Responses are private/no-store with coherent read snapshots. There is no public create/update/delete/repair/mark-paid route, merchant/driver/customer financial surface or final UX. Event and CLI repair are internal server authority, not an extra action implicitly granted to a financial viewer.

### Focused verification and fixture discipline

`driver-earning-policy.test.ts` covers frozen amount versus known non-payable, missing/historical/pending/return exclusions, invalid zero/fractional amounts, source comparison, financial event-field forgery and independent read permissions/non-platform denial.

`test:driver-earnings` consumes the established explicit `_test` database and native pickup fixture. Its optional assignment-service argument is test-only and defaults to the original service for all existing callers; no established verifier assertions or production behavior change. The C fixture uses the actual B ACCEPT snapshot path in a private compensation/earning schema, real native fulfillment/shipment/delivery, real OTP and M17 registration/document/purchaser/recipient/return domain APIs. Synthetic purchaser eligibility uses the existing fixture provider interface; it does not enable restricted production sales. The normal public subscriber sees absent public activation and creates no public earning/debt for these private-rate fixtures. The verifier refuses an already activated public test compensation schema.

Proof includes real R50 snapshot completion after R60 publication, new R60 completion, exact economic timestamp, duplicate events, independent recognizers, subscriber+repair/two-repair races, targeted repair replay, known merchant non-payable outcome, preactivation completion before and after activation, incomplete/wrong OTP, restricted success and failed compliance with completed store receipt. Event forgery cannot change amount/driver. Audit injection proves transaction rollback, and suppressed private audit insertion exercises the deferred COMMIT guard with no partial ledger/audit truth.

Impossible-input controls copy a real completed source contract into separate private schemas with C's actual guards; they do not disable public/B/M16 protections or mutate public sources. They prove missing postactivation snapshot, conflicting performer and mismatched fulfillment cannot earn, exceptions deduplicate, and later source conflict retains an existing earning unchanged. Such copies are corruption/legacy-boundary controls, not claims that production permits these operational transitions. Fixture schemas are removed before the existing native owner performs teardown. Finance history is not edited to clean fixtures. Environment grants are restored. Keyset tests use the actual target predecessor and inclusive upper bound; they never assume a random fixture is in the first global page of the retained database.

### Security review

| SOURCE → TRANSFORMATION | TRUST BOUNDARY → SINK | Implemented protection |
| --- | --- | --- |
| Completion/event Order ID → persisted source validation | Internal event/repair → source-unique earning | No trusted event economics; native/commitment/SHIP/audit chain and frozen snapshot required. |
| Frozen snapshot → exact SQL copy | Insert guard/unique identities → immutable ledger | No current rate/fee/affiliation lookup, zero fallback, driver reassignment or duplicate economic result. |
| Known Order ID → current native User/read grant | Explicit projection → HTTP | Other actors denied; no manage/settlement implication; private/no-store and field allowlist. |
| Conflicting source → bounded reason/first metadata | Immutable exception/audit → attention | Original earning retained, no silent overwrite or generic mark-resolved bypass. |
| Repair cursor → bounded successful-completion page | Same recognition primitive → ledger | No historical repricing, operational mutation or manufactured payment. |

No confirmed critical/high/medium finding remains from static inspection. Runtime verification is pending user execution; no command, migration, build or test was run by Codex and no commit was made. M25 performance/deprecation/harness debt is unchanged.

### Commands for user to run — repository root, stop on first failure

Run each line separately in PowerShell:

```powershell
pnpm run lint
pnpm --filter @gospaza/backend run typecheck
pnpm --filter @gospaza/backend exec tsx --test tests/driver-earning-policy.test.ts
pnpm --filter @gospaza/backend run build
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; pnpm --filter @gospaza/backend run test:driver-earnings-migrate
```

Expected: clean lint/typecheck, passing policy tests/build, then successful forward migration against the established existing `gospaza_m18_c2b_test`. No database is created/dropped/renamed. Shared isolated-helper safety is unchanged. The selected connection retains `.env` credentials/options and is captured without printing them; Redis /1 and NODE_ENV/APP_ENV=test are enforced. Keep that DATABASE_URL in terminal A. An explicitly selected different existing `_test` target can instead be retained by the unchanged helper; do not run with a production target.

Stop the earlier test backend before starting the newly built C backend. In terminal B, leave this running:

```powershell
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; pnpm --filter @gospaza/backend run test:driver-earnings-server
```

Expected: sanitized established test DB/Redis1 summary and listening built backend, with fixture workers disabled. In terminal A:

```powershell
pnpm --filter @gospaza/backend run test:isolated -- test:driver-earnings
```

Expected: all C assertions complete and M21-C passed. No separate M21-B or broad M15–M20 regression command is requested: shared assignment/snapshot and operational completion production code did not change. The focused native fixture inherits its existing M15/pickup prerequisites; restricted cases are targeted C journeys, not a rerun of the entire recipient suite. The optional fixture argument preserves existing callers. No browser/UX suite belongs to C.

### D handoff and stop boundary

C was subsequently user-verified before D was authorized. Production rate/activation/grants remain explicit B rollout inputs; exceptional failed/return compensation and historical catch-up remain unapproved. C itself adds no payment record, allocation/reservation, reconciliation, payout evidence, paid flag, driver/platform UX or M22 functionality. D consumes immutable earned rows and attention/source state as described below.

## 18. M21-D implementation — user-verified

### Ownership and frozen evidence policy

D consumes only immutable `driver_earning` amounts/identity and C's append-only exceptions. No C/B source, recognition, snapshot, migration or operational path is modified. The existing A Medusa ownership decision applies: pinned Medusa 2.18.0 retains native User/auth and commercial payments; externally performed marketplace driver payments are custom GoSpaza Finance accounting, not customer Payment/Refund transactions, M20 statements or a bank integration. No dependency is added.

`DriverPayments` exposes explicit domain commands, not generic CRUD. Strict bodies accept at most 100 distinct whole earning IDs, canonicalized in ASCII order (SQL `COLLATE "C"`). The server derives driver/payer/currency/total from those rows. All must belong to one driver, payer GOSPAZA, currency zar, with no C exception or active hold/allocation. Checked BigInt addition returns only a safe integer minor-unit total. Observed amount must equal that entire total. Historical candidates, merchant nonpayable outcomes and client-invented earning/driver/total fields cannot create payments.

The approved channel is BANK_TRANSFER. External identity is the exact, case-sensitive tuple `(channel, origin_reference, external_transfer_id)`. References are trimmed, bounded opaque ASCII identifiers (1–120 characters); no fuzzy/narrative matching, raw account/credential fields, proof upload, URL signing or bank-account management is introduced. The tuple remains unique for the original attempt forever, including after CONFIRMED_NOT_PAID. A later fresh payment needs a fresh external identity.

An off-platform verified beneficiary reference is operator evidence, not an application bank account. Both successful and uncertain recording require this reference, exact observed amount, external identity, evidence reference and actual external-transfer/attempt timestamp. An unknown record uses that timestamp to identify the attempted transfer and does not assert receipt. D refuses incomplete identity rather than guessing a transfer correlation. Following M20, timestamp tolerance is **zero future tolerance** against database time. It cannot predate either economic earning time or recorded earning existence. Database triggers own recording timestamps. A request requires a bounded reason, confirmation, native platform User and current action grant.

### Schema, reservations and atomicity

Forward `Migration20261110120000` installs each top-level statement separately with named dollar quotes and complete PL/pgSQL terminators:

| Record | Authority |
| --- | --- |
| driver_payment | Immutable initial PAID or UNKNOWN attempt, exact source-derived driver/payer/currency/total, observed amount, beneficiary/transfer evidence, time, policy and recording-command linkage. |
| driver_payment_command | Append-only transition **and audit** evidence: action, native actor, request identity, full strict normalized evidence/reason/confirmation, database time. Exact actor/request identity is unique across actions/payments. |
| driver_payment_item | Immutable original whole-earning selection and exact amounts, retained even after nonpayment resolution. |
| driver_payment_hold | Unique current consumption claim per earning. Held for UNKNOWN and successful payments; successful allocation also has independent unique earning identity. |
| driver_payment_resolution | At most one immutable terminal outcome for an UNKNOWN attempt, bound to its audited command. |
| driver_payment_allocation | Immutable, unique full earning consumption, exact driver/payer/currency/amount and successful command. |
| driver_payment_reconciliation | At most one separate immutable matching assertion/command per successful payment. |
| driver_payment_discrepancy | Append-only bounded contradiction category and audited evidence, never an unpay/reset action. |

The hold is an effective claim index, not the reservation history. Creation history is the immutable UNKNOWN payment/item/command set. Release history is the immutable CONFIRMED_NOT_PAID resolution/command. SQL rejects hold update or deletion without proven nonpayment; successful holds cannot be deleted. No earning paid flag, wallet/balance engine or mutable ledger total is added.

Deferred COMMIT checks enforce original command/evidence, whole manifest totals, C identity/amount/timestamps, exact hold ownership, complete allocations only for paid outcomes, resolution provenance, reconciliation matching and action/audit linkage. FKs and unique identities remain the final concurrency boundary. Payment, evidence, selection, claims, allocations and audit either commit together or roll back. Financial history rejects UPDATE/DELETE. New selection and new paid/reconciliation assertions reject earning attention. Later C exceptions or discrepancies retain existing payment/allocation history.

### Unknown, nonpayment and discrepancy policy

UNKNOWN reserves all selected earnings and creates **no** successful allocation. It is not a failed/paid record. Resolution requires DRIVER_PAYMENT_RECORD, a fresh request, confirmation/reason, opaque review and evidence references, and no unresolved payment discrepancy:

* CONFIRMED_PAID allocates the **same** attempt/identity/manifest once; no second payment record or editable transfer facts.
* CONFIRMED_NOT_PAID additionally requires `nonreceipt_confirmed=true` and exactly BANK_REJECTED, RETURNED_BEFORE_RECEIPT or RAIL_CONFIRMED_FAILURE. Only then are its holds released atomically. The original attempt, items and transfer identity remain permanently retained.

Timeout, cancellation, form errors, HTTP errors and unknown status are never nonreceipt evidence. D deliberately has no direct failure/reset shortcut: proven nonpayment of an already attempted transfer is recorded through UNKNOWN followed by its authoritative resolution. It never instructs a new transfer.

Discrepancies support BENEFICIARY_MISMATCH, AMOUNT_MISMATCH, TRANSFER_DISPUTE, DUPLICATE_EXTERNAL_RECORD, RETURNED_TRANSFER and RECONCILIATION_MISMATCH. Any remains blocking; there is no clear/ignore/override control. A discrepancy discovered after reconciliation adds attention while preserving reconciliation and paid history. An uncertain payment with a separate unresolved discrepancy stays reserved; adjudication/corrective accounting needs a separately approved policy, not an arbitrary release.

### Idempotency, locks and reconciliation

Exact normalized actor/request/action/target/evidence replay returns the original payment and command identities, including after later state changes. Changed selection, amount, identity, reason, review or action conflicts. Reordered selection and equivalent offset timestamps canonicalize to the same evidence. A revoked actor is denied even for replay.

All writes use C's Finance-only driver advisory namespace `gospaza:driver-finance:<driver>` → earning rows in stable C-collated ID order → payment row → item/hold/allocation → resolution/discrepancy/reconciliation evidence. Grants are rechecked after lock acquisition and before return/commit. No merchant, Delivery, commitment, handoff, dispatch/eligibility or native commerce mutation/lock is requested. External-identity races across drivers arbitrate at the unique tuple without acquiring another driver lock. Only named D unique-identity failures become domain conflicts; unrelated database errors are not hidden. No Redis authority, process mutex, retry or timeout change is introduced.

Reconciliation requires DRIVER_PAYMENT_RECONCILE independently of recording. It compares the exact persisted driver, whole allocation selection/total, currency, beneficiary, transfer channel/origin/ID and timestamp, with a review reference, reason and confirmation. UNKNOWN/NOT_PAID, existing reconciliation, C earning attention or unresolved discrepancy reject. Same-request concurrent replay converges; distinct concurrent reconciliation commands permit only one assertion. A successful record is not implicitly reconciled.

### Internal reads, API and recovery

All routes are under `/admin/gospaza/driver-payments`, inherit native user/origin middleware and a 16KB request bound. Explicit methods only:

* `POST /record`, `POST /uncertain` — DRIVER_PAYMENT_RECORD.
* `POST /:id/confirm-paid`, `POST /:id/confirm-not-paid` — DRIVER_PAYMENT_RECORD.
* `POST /:id/reconcile` — DRIVER_PAYMENT_RECONCILE.
* `POST /:id/discrepancies` — either recording or reconciliation grant; this does not grant the other action.
* `GET /drivers/:id` — DRIVER_EARNINGS_VIEW; one driver's GoSpaza/ZAR ledger page plus derived UNPAID, RESERVED, ALLOCATED and ATTENTION_REQUIRED sums. Available unpaid excludes uncertain holds and source-attention rows. Amounts are exact decimal minor-unit strings. Per-row attention remains visible alongside existing allocations.
* `GET /:id`, `GET /attention` — explicit record/reconcile evidence authority. The first is a narrow operational evidence projection, not an ORM/command-payload dump. The second reads at most 25 payment IDs and validates persisted integrity. Cursor work remains finite and read-only.

Every action verifies an existing native platform User and the current explicit grant. DRIVER_EARNINGS_VIEW does not reveal beneficiary/origin/transfer/evidence/audit references. Compensation management, FINANCIAL_VIEW and M20 grants imply no D authority. Other actor classes are denied before resource lookup; known IDs grant nothing. Responses are private/no-store with sanitized errors. Driver self-read, suspension read behavior, final actor-specific payment UX and browser/privacy acceptance remain E.

Recovery classifies unknown outcome, awaiting reconciliation, discrepancy or integrity review. It never guesses bank results, releases holds, invents evidence, replays a transfer, marks paid/reconciled or rewrites history. Infrastructure errors propagate rather than masquerading as a repaired financial inconsistency.

### Security review and verification added

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK:

| Path | Protection / executable coverage |
| --- | --- |
| Earning IDs/observed amount → canonical whole sum | Strict schema, no driver/payer/total mass assignment, current grant + locked immutable rows → FK/manifest/full-allocation guards. Mixed identity/currency/payer, partial/excess and timestamp negatives. |
| Transfer/beneficiary evidence → bounded exact identifiers | Recording grant → permanent tuple uniqueness; same-driver/cross-driver/uncertain identity races and replay conflicts. No credential/proof contents or sensitive logging. |
| Unknown evidence → immutable reservation history | Record grant + proven nonreceipt categories → guarded release or same-attempt success; competing resolution, duplicate recording and rollback negatives. |
| Review evidence → exact allocation/transfer matching | Independent reconcile grant + no discrepancy/source attention → one immutable assertion; concurrent reconciliation and late discrepancy retain financial history. |
| Known IDs/grants → native platform authority | Other actors denied by handlers; unrelated grants and revoked same native User denied; ordinary projection excludes evidence. No generic model CRUD registration. |
| Cursor → bounded integrity scan | Narrow evidence authority → read-only classified IDs; no manufactured correction. |

Static inspection identified no remaining confirmed critical/high/medium issue. This is **not** runtime/browser acceptance. No production rate/default, new commerce owner, dependency, bank execution, payout proof file or public evidence URL is introduced.

`driver-payment-policy.test.ts` covers whole exact integer totals, duplicate/mixed selections, overflow, strict transfer/body validation, timestamp boundaries, proven nonreceipt categories, reconciliation blockers, independent grants/revocation and non-platform mutation denial.

`test:driver-payments` uses real PostgreSQL transactions and independent pooled connections in a generated private schema on the explicitly selected existing `_test` database. It seeds C's immutable input **contract**, not fake native completion/recognition, and installs D's actual SQL/guards. It never disables public C protections or reruns M15–M20. Native User lookup/cleanup remains real. Only the generated schema is created/dropped, never a database; grants are restored in finally.

The proof covers exact R50+R50 → R100/two allocations; R75/R125 rejection; duplicate earning/transfer; same/cross-driver external-identity races; exact/changed replay; UNKNOWN reservations; same-attempt paid resolution; proven-not-paid release and later fresh transfer; competing resolutions; original evidence/earning immutability; independent grants/revocation; source attention; reconciliation matching/blocking/races; post-payment discrepancy; bounded read-only recovery. Private-only fault triggers prove payment/hold/allocation persistence rollback, a real allocation uniqueness collision, missing command/audit at COMMIT, uncertain-resolution rollback and reconciliation-audit rollback. Fault triggers are removed immediately; no public constraint is bypassed. This proof does not claim bank/provider integration or native C source provenance afresh.

### Commands for user to run — repository root, one line at a time

Stop on the first failure. Codex has run none of these commands:

```powershell
pnpm run lint
pnpm --filter @gospaza/backend run typecheck
pnpm --filter @gospaza/backend exec tsx --test tests/driver-payment-policy.test.ts
pnpm --filter @gospaza/backend run build
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; pnpm --filter @gospaza/backend run test:driver-payments-migrate
pnpm --filter @gospaza/backend run test:isolated -- test:driver-payments
```

Expected: clean lint/typecheck, passing focused policy tests/build, migration applied to the established carried-forward `gospaza_m18_c2b_test`, then `M21-D driver payments passed` and normal script completion. The explicit DATABASE_URL command retains `.env` credentials/options without printing them; the unchanged isolated helpers enforce `_test`, Redis /1, NODE_ENV/APP_ENV=test and disabled refund/payment reconciliation workers. No database is created/dropped/renamed. No backend start is needed for this service/SQL verifier and it never starts `medusa develop`. Do not run another verifier concurrently against the fixture environment.

No full C regression is required: C schema/recognition/source invariants and B/operational production paths are untouched. D's focused input-boundary/immutability/exception tests cover the consumed contract. Do not rerun M15–M20 or begin E browser tests for D.

### E handoff / unresolved boundary

D was subsequently user-verified, including the targeted missing-audit verifier correction, before E was authorized. Bank evidence remains an authorized off-platform operator assertion; there is no provider lookup or banking integration. Discrepancy adjudication, compensating/negative accounting and historical catch-up remain separately approved future policy. Production user grant IDs remain deployment configuration, not seeded permissions.

E owns `/driver/earnings`, platform driver-finance operations UX, actor-safe final projections/self-read, suspension/history behavior, known-ID BOLA/BFLA/field-privacy acceptance, a small targeted browser suite and final M21 closure. D adds no UI, driver mutation, merchant payroll, settlement periods, bank automation, partial earning payment, bonus/return/failed-attempt compensation or M22 functionality. Stop before E.

## 19. M21-E implementation — pending final user verification

### Authority, projections and UI

A–D are user-verified. E adds read projections and UX; no B/C/D schema, recognition, amount, allocation, reservation, external identity, reconciliation or discrepancy rule changes. Native Medusa 2.18.0 authentication/User/Customer remains authoritative. The existing DriverService native identity → DriverProfile binding supplies self-read identity. E does not introduce a wallet, bank execution, new earning type, partial payment, merchant payroll, notification or operational override.

Explicit contracts in `packages/contracts/src/driver-finance.ts` separate driver earning/payment summaries, platform earning/payment summaries, recognition reviews, sensitive evidence and typed existing commands. The API client has actor-specific self-read and platform functions, native credentialed/no-store transport and bounded conflict wording. It has no update-earning/set-paid/amount-rewrite method.

`DriverFinanceProjection` is a Finance read adapter over authoritative C/D records. Exact minor-unit strings and timestamps come from persisted records. Driver unpaid excludes allocations, active reservations and C earning attention; reserved totals include uncertain holds without allocations. No current rate, shipping fee, customer total or completion recalculation supplies an amount. Read pages are bounded at 25, with keyset cursors and repeatable-read monetary views. Payment summary comes from D's original outcome, resolution, reconciliation, items and discrepancies. Successful history survives later attention.

Driver routes:

* `GET /driver/earnings` — own list, derived unpaid/reserved totals and up to 25 amount-free recognition reviews.
* `GET /driver/earnings/:id` — own earning detail.
* `GET /driver/earnings/payments` — own bounded payment history, retaining nonpayment attempts after holds are released.
* `GET /driver/earnings/payments/:id` — own bounded payment summary.

No self route accepts a driver selector. Known foreign and missing valid IDs have the same 404 response. Native identity/profile are rechecked before returning a monetary view, including unchanged profile identity. The gate checks existence/native authority, never dispatch ACTIVE eligibility. Operational suspension therefore retains history. Deleted/revoked native identity or session denies access. No new grant, browser state or present affiliation can replace that identity boundary.

The driver app adds `/driver/earnings` and `/driver/earnings/:id`, linked from the existing portal. Mobile cards show frozen earned amount, completion date, delivery/order reference and distinct Unpaid, Payment under review, Payment recorded and Reconciled states. Recognitions without a monetary earning say Earning under review, without R0. Historical candidates are not enumerated as debts; explanatory copy excludes them from unpaid totals. A payment date under UNKNOWN identifies the attempted transfer and never claims successful receipt. Reconciliation is explicitly a platform assertion, not a driver receipt confirmation. Loading, empty, unavailable, refresh, attention and pagination use existing resource/design conventions.

Platform routes under `/admin/gospaza/driver-finance` provide capabilities, earnings list/detail, payment list/detail and amount-free recognition-review pages. Native platform User plus current DRIVER_EARNINGS_VIEW is required for ordinary records. Projections preserve frozen snapshot reference/revision, economic/recorded dates, payer and bounded recognition/discrepancy categories. No first-evidence metadata or command payload is returned. Existing D evidence routes remain narrower (record/reconcile grant); E adds no evidence bypass.

The admin `/admin/driver-finance` console reuses operational tables, cards, feedback and session/resource patterns. It supports driver filtering, independent bounded earnings/payment/review pages and authoritative detail refetch. Filters/page changes hide stale rows and selections during loading. The console distinguishes recorded/reconciled/uncertain/nonpayment/discrepancy states. Existing B terms history shows current rate, effective dates, activation and absent terms distinctly; zero remains unsupported. Authorized managers review and confirm immediate/future platform-flat ZAR publication with reason and expected revision. Conflicts refetch and require fresh review. Activation is displayed; the previously approved B rollout command remains its authority, without adding an E activation workflow.

Authorized operators select whole unpaid earnings, inspect each driver/delivery/frozen amount and enter **observed** external-transfer evidence. No browser sum determines entitlement. Copy and CTAs say Record external transfer; GoSpaza does not send money. Opaque references are requested instead of bank numbers/credentials. UNKNOWN uses the existing explicit uncertain command and states that earnings remain reserved. Sensitive evidence is fetched only for record/reconcile-capable users. Confirmed paid/nonpayment, reviewed reconciliation and append-only discrepancy forms call the existing D commands with reason, confirmation and stable review request identities. Nonpayment requires the approved evidence category and explicit nonreceipt confirmation. There is no arbitrary release/delete/unpay/ignore action. Backend denial remains authoritative; hints do not confer permission. Network uncertainty does not generate a new command identity or replay a mutation automatically.

### Privacy and authorization

| Actor/grant | E access |
| --- | --- |
| Native driver identity/profile | Own summaries only, including operationally suspended profiles; no finance mutation. |
| Merchant/customer | No M21 finance read/mutation. Existing operational/customer DTOs are unchanged. |
| DRIVER_EARNINGS_VIEW | Ordinary platform earnings/payments/reviews; no sensitive evidence or mutation. |
| DRIVER_COMPENSATION_MANAGE | B terms publication/configuration; no implied payment or ordinary earning grant. |
| DRIVER_PAYMENT_RECORD | D external-payment/uncertainty/resolution commands and narrow evidence. |
| DRIVER_PAYMENT_RECONCILE | D reconciliation and narrow evidence, independently of recording. |

Driver DTOs omit driver IDs, customer contact/address, merchant-private context, actor/request identities, compensation publication internals, beneficiary/origin/evidence references, raw transfer identity, fingerprints, repair data, OTP/GPS/recipient/compliance observations. The business-safe payment reference exposes only the last six characters of the external ID, never the origin. Ordinary platform DTOs add only approved identity/snapshot/review summaries; no raw evidence, notes or request/audit internals. Narrow evidence requires explicit D authority. All reads are private/no-store; failures are sanitized and other/missing self resources disclose the same response.

SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK static review:

| Path | Enforcement and acceptance |
| --- | --- |
| Session → native identity/profile → self DTO | Server-derived owner, repeated native/profile validation, owner-qualified earning/payment queries; foreign/missing equivalence. |
| C/D rows → explicit projection → role API/DOM | Key allowlists, exact persisted amounts, masked transfer reference, no ORM/payload dump or sensitive source join. |
| Platform session → current grant → action | Separate view/manage/record/reconcile; native User checked, D rechecks grants under locks. No merchant/customer implication. |
| Selection/observed evidence → existing B/D commands → SQL | No new policy/calculator; existing strict shape, frozen amounts, unique transfer/allocations, reservations and audited transitions remain final authority. |
| UI draft → reviewed stable request → mutation/readback | No automatic mutation retry; conflicts refresh and reset review; stale list scopes do not preserve hidden selections. |
| Test deployment environment → private contract schema → real API | APP_ENV/NODE_ENV=test, explicit `_test` URL, validated random schema and marker; no request/header schema selector or production bypass. |

No confirmed critical/high/medium issue remains from static review. Runtime authorization/privacy/security closure is pending the commands below. No temporary request tracing, secret logging or bank proof contents were added. M25 performance/deprecation/harness debt remains deferred.

### Acceptance and fixture discipline

Focused tests: `apps/backend/tests/driver-finance-http.test.ts`, `packages/api-client/tests/driver-finance.test.ts`, `packages/ui/tests/driver-finance.test.ts`. They cover wrong actors, credentialed/no-store transport, encoded owner-safe routes, bounded conflict messages and distinct amount/payment/attention presentation. Runtime field allowlists are asserted by the direct API verifier, rather than pretending TypeScript types alone enforce privacy.

`test:driver-finance-fixtures` creates native identities, real approved/suspended DriverProfiles through existing domain commands, a real merchant and customer, and a generated private C input-contract schema. It installs the verified B/D SQL there; no public C ledger/constraint is edited or disabled. This follows the established M20 acceptance approach. C terminal provenance was verified in C; E does not fabricate new public completion or duplicate that full native proof. New test references/amounts are explicitly synthetic and never production terms. The manifest contains safe fixture identities, not passwords or payment evidence. Passwords derive from a random shell-only test seed; the built backend never receives that seed.

`acceptance:m21-server` loads `.env` through the unchanged isolated helper and starts the **built** backend with the manifest-selected test schema/grants. Native auth remains native; only M21 finance SQL receives the private schema. The optional middleware is inert without its environment flag and refuses production/non-test targets. It creates/drops no database and edits no `.env`. No client can select a schema.

`test:driver-finance-surfaces` first requires untouched mutable API earnings. It uses real native login/session cookies and HTTP routes to prove self read, foreign earning/payment denial, missing equivalence, forged selector rejection, suspended-history read, live same-session suspension, native identity removal and session logout revocation. Platform tests cover exact ordinary field allowlists, missing/current/future terms, independent grants, invalid/forged payment evidence, exact/changed replay, duplicate transfer, separate reconciliation, UNKNOWN/discrepancy denial and retained history. Current grant revocation uses the actual route handlers with the same HTTP-authenticated native actors/cookies and persisted native User lookups, matching M19/M20's server-process environment-grant pattern; it does not add a public grant-reset endpoint or require a restart. Read, record and reconcile grants are checked separately. The verifier sets `api_verified` only after all assertions pass.

`playwright.m21.config.ts` starts only driver/admin apps; it requires successful direct API acceptance. Three actual-browser journeys use real APIs with no route mocks, sleeps, retries or scheduler-order assumptions:

1. Suspended driver self-read, immutable payment/reservation states, direct earning navigation, reload and private-field absence.
2. Dedicated platform browser earnings → reviewed external payment record → separate reviewed reconciliation → persisted list after reload.
3. Ordinary viewer privacy/no mutation/evidence UI, foreign driver navigation denial and real merchant-session finance denial.

Playwright creates a fresh browser context/page per test. No shared storage state is configured. API and browser mutations have separate earnings; the suspended driver's three read-only earnings are owned by a different DriverProfile from the mutable platform-browser records. API-only suspension/revocation actors are separate from browser identities. The API checks browser records remain unconsumed. A successful record/reconcile consumes the corresponding mutable fixture even if a later assertion fails. Do not rerun it blindly: preserve output and generate a fresh manifest when mutation has occurred. Preflight checks reject consumed records. Read-only history can be reused independently.

API preflight also detects an already suspended API actor or an already consumed terms-publication scope before running another scenario. After generating any fresh manifest, restart the isolated acceptance backend against that same manifest before API/browser acceptance; do not leave it bound to the previous schema/grant IDs. Run only one backend on the configured port.

### Commands — repository root, PowerShell, one at a time, stop on first failure

Codex ran no verification commands, builds, migrations, servers or tests. PowerShell was used only for user-authorized source-directory creation after sandboxed folder creation was denied. No commit/merge was made.

```powershell
pnpm run lint
pnpm run typecheck
pnpm --filter @gospaza/backend exec tsx --test tests/driver-finance-http.test.ts
pnpm --filter @gospaza/api-client exec tsx --test tests/driver-finance.test.ts
pnpm --filter @gospaza/ui exec tsx --test tests/driver-finance.test.ts
pnpm --filter @gospaza/backend run build
pnpm --filter @gospaza/driver run build
pnpm --filter @gospaza/admin run build
```

Expected: clean lint/typecheck, all focused tests pass and all three builds succeed. No E migration is needed; D is already applied/user-verified. Then in terminal A:

```powershell
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"
$env:APP_ENV='test'; $env:NODE_ENV='test'; $env:M21_VERIFY_SECRET=node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"; $env:M21_BROWSER_MANIFEST=Join-Path $PWD ('test-results/m21-'+[guid]::NewGuid().ToString('N')+'.json')
pnpm --filter @gospaza/backend run test:isolated -- test:driver-finance-fixtures
```

Expected: sanitized existing `gospaza_m18_c2b_test`/Redis1 summary, then a fresh manifest path. Preserve terminal A's seed and manifest variables. No database is created/dropped. A failed/consumed mutation fixture needs a new manifest, not deletion of financial rows.

In terminal B, stop any previous backend on the same port, then run this single line and leave it running:

```powershell
$env:DATABASE_URL=node -e "const fs=require('node:fs');const {parseEnv}=require('node:util');const u=new URL(parseEnv(fs.readFileSync('apps/backend/.env','utf8')).DATABASE_URL);u.pathname='/gospaza_m18_c2b_test';process.stdout.write(u.href)"; $env:M21_BROWSER_MANIFEST=(Get-Content -Raw 'test-results/m21-current-manifest.txt').Trim(); pnpm --filter @gospaza/backend run acceptance:m21-server
```

Expected: isolated built backend listening, correct test schema/grants and no credential seed supplied to the server. In terminal A:

```powershell
pnpm --filter @gospaza/backend run test:isolated -- test:driver-finance-surfaces
pnpm exec playwright test --config=playwright.m21.config.ts --workers=1
```

Expected: direct API/suspension/revocation/privacy success and normal script completion, then three browser tests pass. Do not start browser acceptance after an API failure. Do not run other verifiers concurrently against this fixture environment. No full M15–M20 or B/C/D rerun is requested: E leaves their shared production logic/schema untouched, while direct API acceptance exercises the exact existing B publication and D payment/reconciliation surfaces consumed by E.

### Final closure status

E is implemented and ready for final user verification, not yet verified/closed. A–D successful results were supplied by the user. E lint/typecheck, focused tests, builds, direct API acceptance and all three browser journeys remain user-run. M21 closes only after those results satisfy the existing closure criteria. No new product-policy blocker was identified. Activation rollout, bank evidence attestation, historical catch-up and discrepancy adjudication retain the approved A–D boundaries. M22/M23/M25 implementation is not authorized by this slice.
