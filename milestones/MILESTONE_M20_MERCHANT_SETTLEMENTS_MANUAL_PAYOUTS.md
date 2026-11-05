# M20 — Merchant settlements and manual payouts

M20-A is the approved policy contract. B, C and D require their own implementation instructions and user verification. M19 is complete and merged. This document does not authorize driver earnings or an opening-balance import.

## 1. Ownership and terminology

M19 owns historical merchandise economics, commission terms/basis/amount, promotion attribution, merchant economic entitlement and finance exceptions. M20 consumes those immutable economic facts. Never recalculate them from a current Order, promotion, commission rule or ServiceZone. Native Medusa retains commerce/payment/Store Credit ownership. M18 financial_settlement remains the customer-adjustment settlement domain.

The M20 chain is M19 posting → source claim → immutable merchant period statement → positive payable settlement if any → approval → recorded external transfer → reconciliation.

| Term | Meaning |
| --- | --- |
| Merchant economic entitlement | M19's tax-exclusive merchandise entitlement after commission. |
| Period effects | Sum of eligible M19 merchant merchandise entitlement effects included in this statement. |
| Signed statement net | Period effects plus incoming nonpositive carry. |
| Payable settlement | A strictly positive amount generated from a statement, subject to the approved lifecycle. |
| Recorded payout | Evidence of an externally performed transfer of the exact approved amount. |
| Reconciliation | A separate authorized assertion that payment evidence matches the settlement and beneficiary. |

M21 independently owns driver earning creation, compensation and payment accounting. Customer delivery fees and merchant settlement records establish no driver earnings.

## 2. Activated period policy

Use a versioned, explicitly activated policy. The initial currency is ZAR, represented as integer minor units. Initial calendar policy is Africa/Johannesburg, Monday 00:00 inclusive through the following Monday 00:00 exclusive. Cutoff is the period end. Generation is allowed only after cutoff according to database time.

Calculate local calendar boundaries with timezone-aware logic in one owning policy module. Store their UTC instants, timezone and policy version. Do not scatter seven-day or UTC-offset arithmetic across callers. No activation date is silently selected by migration or application startup.

The first ordinary period starts at the first Monday 00:00 at or after the approved activation instant. An activation exactly at Monday 00:00 selects that instant. A later instant selects the next Monday. Policy versions must not create overlapping active periods for the same merchant/store/currency. Historical statements retain their policy forever.

## 3. Eligibility, cutoff and late records

A candidate must satisfy every condition:

* It is an authoritative M19 economic posting and belongs to the merchant/store/currency of the statement.
* economic_at is strictly before period_end, recorded_at is at or before cutoff, and the committed posting is available during serialized generation.
* It has no existing consumption claim, except a reusable claim transferred by the explicit DRAFT supersession path.
* No blocking unresolved authoritative finance evidence affects it.
* It satisfies activation/catch-up policy.

There is deliberately no period-start lower bound excluding old unconsumed economics. Eligible earlier economic events may appear as prior-period items with their original economic_at and recorded_at. The economic window is half-open; a delivery at the exact period end belongs to a later period. The recorded cutoff comparison is inclusive.

Generation freezes the committed manifest under the merchant lock shared with M19 posting creation. Later arrivals never join the sealed manifest. A posting recorded after cutoff first becomes eligible at a later cutoff. A posting discovered after sealing, even if otherwise timestamp-eligible, waits for the next ordinary statement or the expressly authorized pre-ready supersession path.

Generation identity is merchant/store/currency/period/policy version. Protect merchant/store/currency/period uniqueness as well so a different policy version cannot create a second independent payable statement for the same period. Exact generation replay returns the current authoritative statement for that identity, without new claims or recalculation.

## 4. Amount, tax and delivery policy

For the initial policy, current_period_effects is exactly the sum of included M19 merchant merchandise entitlement effects. Do not subtract commission again or add subsidy again. Preserve recognized merchandise, attributable tax, subsidy, commission and entitlement component totals for explanation, reconciled to the source items.

M19 attributable tax is separately disclosed as TAX_HELD and excluded from payout. TAX_HELD is an internal MVP settlement treatment, not a legal conclusion about ultimate tax ownership. It is not platform revenue. Use the exact recorded M19 tax; no VAT percentage or independent tax calculation. Consuming the source captures its tax-hold attribution once. Replaying or carrying the net must not recreate the held tax.

Delivery fees and shipping tax are excluded. No source establishes merchant ownership of them. A future delivery allocation or tax-release policy must be explicitly versioned and prospective; it cannot alter the statements that first recorded these facts.

Compute with checked signed integer arithmetic:

    net = current_period_effects + incoming_carry
    payout = max(net, 0)
    outgoing_carry = min(net, 0)

The signed statement is separate from a positive payable settlement. Zero or negative net creates no payout receipt or fictitious PAID/RECONCILED settlement. Nonpayable statements retain their preparation/finalization evidence and carry outcome without passing through a payment lifecycle.

## 5. Carry and the current negative-source limit

Carry is an immutable nonpositive effect from one finalized statement to the next eligible statement for the same merchant/store/currency. Consume each carry identity once and establish a unique successor link. Never sum every historical negative balance. Finalize periods in order; an earlier unresolved draft cannot feed multiple successor statements. A positive result consumes the incoming carry and has no further negative outgoing effect.

Shipped M19 currently permits only nonnegative DELIVERY_RECOGNITION postings. Its post-delivery shortage/delta source is deferred. M20 must not manufacture negative merchant effects from refunds, credit issuance, goodwill, return custody or inventory disposition. Model and test signed arithmetic/readiness, but production negative carry stays dormant until an approved authoritative negative source exists.

No general manual-debit command or synthetic opening balance is authorized. Importing an opening balance requires a separate approved, audited migration/import policy.

## 6. Holds and clean-item settlement

Unresolved M19 finance is not zero. Exclude affected postings/orders from payable claims and preserve a statement exclusion manifest with source/order identity, reason/category, and held amount only where authoritative. Distinguish excluded posting count from unresolved orders without postings to avoid presenting one Order as several separate unknown liabilities.

Clean eligible items may settle while unrelated unresolved items remain held. The approver sees and acknowledges exclusions; approval never waives them. A new blocking issue affecting an included item blocks readiness, approval or payout on the fresh consistency check. Preserve frozen membership and amount; do not silently subtract an item from an approved settlement.

M19 has no implemented exception-resolution/supersession authority. M20 cannot mark its exceptions resolved. Holds remain until an authoritative upstream resolution exists. Record the reasons observed at generation immutably and display subsequently discovered holds separately. Paid discrepancies remain visible without pretending the original payment did not occur.

## 7. Immutable generation and DRAFT supersession

Atomically create the statement, items, source claims, carry consumption and a positive payable settlement if the net requires one. Freeze period/policy/cutoff, merchant/store/currency, included and excluded manifests, component totals, incoming carry, net and outgoing carry. Exact replay returns existing records.

Only an authorized preparer may explicitly supersede a DRAFT before READY_FOR_APPROVAL. Require expected revision, confirmation, bounded reason and request identity. Preserve the old statement and items, append supersession evidence identifying replacement, time and actor, and create the replacement in the same transaction. A superseded draft is no longer actionable.

A globally unique posting claim is the consumption authority. Historical items on a superseded draft are evidence, not another payable consumption. Claim ownership may transfer atomically only when the prior draft is still active and legally reusable, has not reached READY, has no payment, and its carry has no finalized downstream consumption. Preserve an append-only claim-assignment history. Transfer the same carry-consumption lineage rather than consume its effect a second time. Claims for newly held items may be released only by this guarded path, with the reason retained.

No supersession after READY_FOR_APPROVAL, no arbitrary reset/delete, and no reassignment of an approved, paid or reconciled source. Prefer superseded markers/audit over adding another payable-settlement lifecycle state. Period identity points to one current statement version. Replaying supersession returns its recorded replacement, including a later superseded marker if applicable.

## 8. Payable settlement lifecycle

These are the complete permitted transitions for positive payable settlements:

| Transition | Required authority and evidence |
| --- | --- |
| DRAFT → READY_FOR_APPROVAL | Preparer, closed cutoff, verified immutable manifest/component sums/carry, recorded exclusions, no included-item inconsistency, expected revision and confirmation. |
| READY_FOR_APPROVAL → APPROVED | Approver, expected revision, confirmation, fresh source/hold check and unchanged authoritative amount. |
| APPROVED → PAID | Payout recorder, expected revision, confirmation, exact external transfer receipt, currency and verified-beneficiary reference; no unresolved included-item block. |
| PAID → RECONCILED | Reconciler, expected revision, confirmation, reviewed matching payment evidence and no unresolved payment discrepancy. |
| APPROVED → FAILED | Payout recorder with evidence that a transfer was attempted and the beneficiary received no funds; retain the failed attempt, actor, reason and audit. |
| FAILED → APPROVED | Approval/retry authority, expected revision, explicit confirmation and reason after reviewing the immutable failed-attempt evidence. |

No other edge is permitted. There is no generic status-edit API. An exact request replay returns its recorded result. Reusing request identity with changed content conflicts. Opposing concurrent transitions have a deterministic winner through revision/state checks and locks.

Nonpositive statements use the preparer's explicit finalization of manifest/carry and have no positive payable row to approve or pay. Their outcome is represented by signed net and carry records, not a fabricated bank event.

## 9. External transfer evidence and FAILED

MVP supports one full successful external payment per settlement. Partial payments, overpayments and installments are rejected. Required receipt evidence is settlement ID, exact approved amount/currency, actual transfer timestamp, transfer channel, originating channel/account identity, external transaction/transfer ID, recording actor, confirmation and an opaque off-platform verified-beneficiary reference. Optional proof uses private storage. A caller reports the observed amount; the server compares it with the immutable approved amount.

No raw merchant banking credentials or beneficiary-management subsystem is needed for MVP. The operator records a beneficiary reference verified off-platform according to internal operations. This is an audited operational assertion, not an application-verified bank identity. Ordinary financial projections must not expose private beneficiary details.

Uniqueness is transfer channel plus originating account/channel identity plus external transfer ID, across merchants and settlements. A free-text narrative is not the key. Preserve the external identifier according to that channel's identity rules; never use fuzzy matching. An exact receipt replay for the same settlement returns the original result. Changed amount, settlement or transfer identity under a replay identity fails closed. Failed attempts also retain their identity so they cannot later be passed off as a new unrelated transfer.

FAILED requires actual attempted-transfer evidence proving nonreceipt. HTTP timeout, UI error, validation failure, backend error or an abandoned form does not establish it. Retry retains all approved economics and the failed record; a subsequent successful transfer has a new attempt/receipt identity.

After PAID, later returned/disputed/mismatched evidence creates a discrepancy and prevents reconciliation. It never changes PAID history into FAILED or deletes the receipt. An external event discovered after RECONCILED likewise appends discrepancy evidence; it does not rewrite the completed decision.

## 10. Reconciliation and audit

Reconciliation independently asserts that the reviewed receipt matches the settlement, verified beneficiary, currency, exact approved amount, transfer identity and transfer date, with no unresolved discrepancy. Recording payout never automatically reconciles it. Keep the reconciliation actor, time, request identity, confirmation and evidence reference separate from the recording actor.

Transition audit commits atomically with each action. Preserve who/what/when/why, request fingerprint, prior/resulting revision, statement/settlement and evidence references. A failed audit means no action commits. Do not copy proof contents, bank details, credentials or private beneficiary information into logs or ordinary audit payloads.

## 11. Authority and actor projections

| Actor/capability | Allowed surface |
| --- | --- |
| Platform settlement reader | Bounded statement and settlement financial/status data. |
| Platform preparer | Generation, pre-ready supersession, readiness and nonpayable finalization. |
| Platform approver | Approval and explicit FAILED retry authorization. |
| Platform payout recorder | Exact manual transfer or proven failed-attempt recording. |
| Platform reconciler | Review restricted payment evidence, discrepancy/reconciliation decisions as explicitly implemented. |
| Active merchant OWNER/MANAGER | Read own statements and safe payout status only. |
| PICKER, customer, driver | No merchant settlement access. |

Use specific grants for each action, independent of commission, refund, goodwill and Store Credit authority. One authorized human may hold multiple grants; mandatory different-user/four-eyes checks are not required for MVP. Revalidate grants and membership at every operation.

Merchant APIs derive tenant from active authenticated membership, check store/order/source ownership server-side and filter before pagination. No actor submits an authoritative settlement amount, posting effect, currency ownership, merchant/store binding or lifecycle state. Unknown and foreign IDs must not disclose another tenant.

Statement DTOs distinguish M19 entitlement, signed period net, positive payable amount, actual recorded payment and reconciliation. Include period, status, included orders/items, component summaries, disclosed TAX_HELD, carry, exclusions and bounded payout reference/date where applicable. Private proof/beneficiary retrieval requires a narrower authorized path; list endpoints never return storage keys, proof contents or provider/private audit objects. Existing UX route families are /admin/settlements and /merchant/settlements with per-ID detail.

## 12. Activation and historical catch-up

No backdated activation. Pre-activation M19 postings enter historical catch-up review, since merchants might already have been paid off-platform. Missing payment evidence is a hold, not an inferred unpaid liability. Release requires an explicit authorized, source-bound, audited catch-up decision. It permits the trustworthy posting to enter an eligible future statement once; it does not create a past payout or opening balance.

Post-activation earnings before the first ordinary Monday boundary can enter that first generated statement as prior-period items under the ordinary earlier-unconsumed eligibility rule. They do not create an extra pre-start settlement period. Pre-activation records still require catch-up authorization. M20-A authorizes no bulk historical import or automatic catch-up release.

## 13. Concurrency, identities and repair

Use the merchant-first boundary, then store/currency serialization as needed, statement/payable row, source claims in stable posting-ID order, carry claim, and payout receipt. Supersession locks both statement versions in deterministic order under the same prefix. M19 posting generation also uses the merchant lock. No process-local mutex, Redis balance or sleep is authoritative.

Database guards must cover period identity/current head, globally unique posting claim, one carry successor/consumption, request identity, transfer identity and one successful full receipt per settlement. A superseded statement cannot become ready during concurrent replacement. Generation racing generation or repair converges. Approval racing supersession is permitted to win only while state rules still allow that action. Payout and reconciliation serialize; reconciliation cannot precede the committed receipt.

Repair is bounded and calls ordinary generation/transition validation. It may discover unconsumed inputs, retry generation, detect incomplete operational transitions and surface inconsistencies. Transactions/deferred consistency should prevent committed partial membership. Never rewrite paid history, change approved membership, fabricate a receipt or clear upstream exceptions.

## 14. Worked contract examples

Amounts are ZAR minor units. These vectors describe policy, not executed tests.

| Example | Expected result |
| --- | --- |
| Ordinary positive week | Eligible entitlement 9000, carry 0 → net/payable 9000, no negative carry. Approval is still required before recording a transfer. |
| Two postings | Entitlements 9000 and 4500 → effects/net 13500, two unique source claims and one positive payable settlement. Commission/subsidy are not added or subtracted again. |
| Late after cutoff | Economic Sunday 23:59, recorded Monday 00:00:01 → excluded at Monday cutoff and eligible at the next cutoff, retaining the Sunday economic date. |
| Prior-period item | An eligible unconsumed earlier economic posting enters the next statement as a prior-period item. The original period statement remains unchanged. |
| Exact boundaries | Economic time equal to period end → later period. Economic time before end and recorded time exactly equal to cutoff → eligible if committed and otherwise admissible. |
| Clean item plus hold | Clean entitlement 9000 and blocked posting 4500 → included effects 9000, one excluded/held source with authoritative held amount 4500; approval does not release the hold. Unknown held amount is null, never 0. |
| Tax-bearing sale | M19 merchandise 10000, tax 1500, commission 1000, entitlement 9000 → net/payable 9000 and disclosed TAX_HELD 1500. Tax is not platform revenue. |
| Shipping excluded | Customer shipping 2000 plus shipping tax 300 changes neither the above 9000 payout nor its 1500 merchandise-tax hold. No source claim is fabricated for shipping. |
| Zero net | Effects 0, carry 0 → net 0, no payable settlement, no PAID receipt. |
| Three carry periods | Effects −3000, then +2000, then +5000 → net −3000/−1000/+4000, payout 0/0/4000, outgoing carry −3000/−1000/0. These are arithmetic/model-readiness vectors because no approved production negative source exists. |
| Future negative effect | A separately approved future economic effect of −5000 offset by +8000 yields net 3000. A customer refund alone cannot supply the −5000 source. |
| Duplicate generation | Repeating the same period/policy request returns its authoritative statement and existing claims; totals and counts stay unchanged. |
| Concurrent generators | Two attempts for two eligible postings create one current statement, two claims and one payable amount, with no duplicate consumption. |
| Draft supersession | Active DRAFT A claims P1. An audited pre-ready replacement B can reassign that unique claim and add P2 atomically. A remains historical/superseded; only B is actionable. If A became READY first, supersession rejects. |
| Approval | READY settlement 13500 at revision r becomes APPROVED only with the proper grant, confirmation, expected r and fresh consistency check. Amount stays 13500. |
| Exact payout | Receipt amount 13500 ZAR, verified beneficiary reference and unique transfer identity → PAID 13500. Reconciliation remains a separate step. |
| Partial/excess rejection | Reported 13000 or 14000 against approved 13500 → reject before PAID, with no successful receipt or economic mutation. |
| Exact receipt replay | Repeating the same receipt identity and payload returns the recorded payment. No new payout is recorded. |
| Changed receipt replay | Same request/transfer identity with another settlement, amount or changed transfer identity → conflict, no new payment claim. |
| Failed attempt then retry | Proven attempted nonreceipt moves APPROVED to FAILED; approver reviews, confirms with reason and restores APPROVED. A new successful transfer identity can later produce PAID. |
| Paid discrepancy | A disputed receipt discovered after PAID appends a discrepancy. PAID history stays present; reconciliation is blocked pending explicit discrepancy resolution. |
| Reconciliation | Authorized matching review of settlement/beneficiary/exact amount/currency/transfer/date with no unresolved discrepancy → RECONCILED, retaining a distinct review audit. |
| Pre-activation posting | Trustworthy M19 entitlement 9000 dated before activation remains on historical catch-up hold. No existing application payment record does not prove it is unpaid. An authorized release may permit one future inclusion. |
| First live period | Activation Wednesday 2026-11-04 at 12:00 local → first ordinary period Monday 2026-11-09 00:00 through Monday 2026-11-16 00:00; generation after the latter. Post-activation earnings before November 9 can appear as prior-period items; pre-activation earnings require catch-up review. |

## 15. Proposed persistence and slice boundaries

| Concept | Minimum persisted authority |
| --- | --- |
| settlement_period_policy | Version, explicit activation, timezone, calendar/cutoff, ZAR, TAX_HELD and shipping-exclusion policy. No retrospective edits. |
| merchant_period_statement | Period identity/version/head, immutable manifests/totals/carry/net, preparation audit and supersession lineage. |
| settlement_source_claim | Globally unique posting/effect identity, current legal owner and immutable assignment history. |
| settlement_item | Exact posting reference, recorded component effects and temporal classification; membership of one statement version. |
| settlement_carry_effect | Immutable amount, originating statement, unique successor claim and lineage. |
| payable_settlement | Positive amount, authoritative statement version, approved six-state lifecycle and revision. |
| payout_attempt / payout_receipt | Failed or successful external evidence, globally scoped transfer identity, verified-beneficiary reference, exact amount/currency and private proof reference. |
| settlement_transition_audit | Append-only actor/action/request/confirmation/reason/revision/evidence. |
| settlement_discrepancy | Source-bound payment inconsistency and append-oriented resolution evidence. It cannot modify M19 economics. |

**B** implements policy/period persistence, claims/items, immutable generation, carry arithmetic, holds/catch-up evidence, guarded DRAFT supersession and bounded generation/repair. Model lifecycle boundaries but do not implement approval, payment or reconciliation. Verify boundary dates, replay, concurrent claim acquisition, supersession/readiness exclusion, carry lineage, held-source exclusion, cutover and rollback using actual PostgreSQL. Negative vectors are explicitly readiness tests.

**C** implements approval after B's readiness transition, manual attempt/receipt recording, failed retry, discrepancy and reconciliation actions, private proof handling where needed, with real concurrency and audit proofs. No payout-provider execution.

**D** implements actor-safe statement/operations DTOs, the operational UX and small real-API browser acceptance. Verify known foreign IDs, forged totals/statuses, stale grants, revoked membership, receipt replay, protected evidence, and truthful unpaid/paid/reconciled terminology.

Use the existing isolated _test PostgreSQL database, Redis /1 and matching built backend. New verification scripts must follow test:<name> → medusa exec ./src/scripts/verify-*.ts and work through test:isolated. No verification result is claimed by this contract.

## 16. Implementation-time decisions and open inputs

The economic policy above is frozen. Production activation time, operator grants, supported transfer-channel identity rules and operationally verified beneficiary references remain deployment inputs. No default value creates those facts.

Before enabling C discrepancy resolution, freeze its bounded evidence/decision schema; a generic “clear discrepancy” checkbox is insufficient. Before enabling historical catch-up release, define the bounded authoritative review evidence and request identity. These commands may record the approved operational assertions but may not adjudicate source economics or import opening balances.

Production negative-source creation, upstream M19 exception resolution, post-delivery shortage adjudication, tax release, delivery allocation and opening-balance imports remain outside this authorization. Their absence leaves the associated records held or dormant without blocking approved clean-item settlement.

## 17. M20-B implementation — user-verified before C

The B instruction explicitly includes DRAFT → READY_FOR_APPROVAL. The implementation stops there. A nonpositive statement instead receives immutable finalization evidence (`finalized_at` plus `FINALIZED` audit), retaining statement status DRAFT with no payable record. A finalized or superseded DRAFT is non-actionable. Future consumers must inspect these markers, not status alone.

### Ownership and storage

Medusa 2.18 remains owner of native Orders/payments/customers. The installed configuration has no merchant-liability statement/payout primitive. M20 therefore adds SQL-owned marketplace-finance records following M19's immutable SQL pattern, not a second native commercial order/payment model. Migration `Migration20261106120000` installs separate top-level SQL statements from `merchant-settlement-schema.ts`; each named-dollar-quoted function remains one migration statement. No M19 or M18 production source is changed.

Tables: `settlement_period_policy`, `merchant_period_statement`, `settlement_item`, `settlement_exclusion`, `settlement_source_claim`, `settlement_claim_history`, `settlement_carry_effect`, `settlement_carry_claim`, `payable_settlement`, `settlement_transition_audit`. No ORM-generated CRUD surface is registered. Statement/version/manifest/money, items, exclusions, effects and audits are immutable; operational markers and source/carry ownership have precise guards and deferred commit-time consistency.

`gospaza_settlement_period` is the single calendar owner. It uses PostgreSQL local-calendar `date_trunc('week', ... AT TIME ZONE 'Africa/Johannesburg')`, then converts local boundaries back to instants. No fixed offset or floating-point money calculation is used. The policy freezes `M20_B_V1`, currency, timezone, activation, `TAX_HELD` and shipping exclusion. The prospective activation command requires explicit ID, instant, confirmation, reason and preparation grant. Replays must match. There is no startup/migration activation default or historical-release command.

### Generation and preparation

`MerchantSettlements.generate/repair` accepts one merchant/store/policy/period identity only. It validates merchant/store ownership and takes M19's merchant row lock before selecting committed postings. Eligibility uses snapshot tenant/currency/resolved state, economic time before end, recorded time at/before cutoff, economic time at/after activation, no active source claim and no M19 exception. SQL `INSERT SELECT` retains source timestamp microseconds. Prior-period flags use the original economic date. Dates/cutoff/amounts/source IDs/status supplied outside the strict command shape reject.

Generation atomically writes immutable source items/exclusions, exact component totals, unique claims, carry, positive payable if applicable and audit. `net = entitlement effects + incoming carry`; tax is copied separately and shipping is never queried. The manifest fingerprint is a built-in database digest for integrity checking, not an authorization credential. Deferred checks compare exact source identity, timestamps, components, tenant, arithmetic, membership, claims, carry, payable and audit. A transaction cannot commit its temporary `PENDING` manifest state.

Initial generation requires the first activated period. Later periods require the immediately preceding current statement to be READY or explicitly nonpayable-finalized. This prevents skipped carry and drafting successors against mutable predecessors. Repair is a single explicit merchant/period call to the same primitive; no unbounded worker, new global scheduler or automatic readiness transition is added. Existing generation replay returns the current head without recalculation.

Historical postings remain unclaimed `HISTORICAL_CATCH_UP` exclusions. Other blocked postings and unresolved snapshots without postings are `UNRESOLVED_FINANCE` exclusions; the latter have null held amount. One exclusion per snapshot prevents repeated exception reasons from inflating source counts. Newly raised exceptions on included sources block preparation; unrelated exclusions do not block clean items. M20 has no exception-clear or catch-up-release action.

Supersession requires preparation grant, expected revision, confirmation, bounded reason and unique request identity. One transaction preserves the predecessor, inserts its replacement, transfers reusable posting/carry claim ownership and appends assignment/transition history. Removed blocked sources retain a claim identity with null current owner and release history. An unrelated generator cannot acquire the merchant lock between release and replacement. Supersession cannot follow READY/finalization or finalized downstream carry use. Exact replay returns the recorded replacement; changed replay conflicts.

Preparation rechecks grants after acquiring the merchant lock, manifest/source/hold consistency, closed cutoff, carry and revision. Positive payables move together with their statements to READY_FOR_APPROVAL. Nonpositive finalization has no R0/negative payable or payment event. Audit failure rolls back the entire action.

### Authority and API

Capabilities are explicit, independent allowlists: `SETTLEMENT_VIEW_USER_IDS` and `SETTLEMENT_PREPARE_USER_IDS`. User existence is checked using native Medusa User; grants are re-evaluated for each operation and after write-lock acquisition. A preparation grant does not implicitly grant read. Financial/commission grants do not imply either. Platform preparation may target validated merchant/store pairs; a known foreign store cannot be bound to another merchant. Merchant/customer/driver actors cannot access these platform-only routes.

* `POST /admin/gospaza/settlement-period-policy`: explicit prospective activation.
* `POST /admin/gospaza/merchant-settlements`: bounded generation/replay.
* `GET /admin/gospaza/merchant-settlements/:id`: explicit B platform DTO (statement summary, source summaries and exclusions).
* `POST /admin/gospaza/merchant-settlements/:id/supersede`: guarded replacement.
* `POST /admin/gospaza/merchant-settlements/:id/prepare`: READY or nonpayable finalization.

Reads omit internal actor/reason/audit objects, fingerprints and native payment data. B money readbacks are exact integer-minor-unit decimal strings from PostgreSQL; no browser financial calculation is introduced. Responses are private/no-store. Existing platform actor/origin middleware applies and bodies are bounded to 8KB. There are no merchant routes/UI in B.

The internal `settlements:repair` script requires `M20_PREPARER_USER_ID`, `M20_MERCHANT_ID`, `M20_STORE_ID`, `M20_POLICY_ID`, `M20_PERIOD_START` and the ordinary preparation grant. It operates on one explicit period, uses the same service and logs only the resulting statement identity. It never activates policy or changes economics.

### Concurrency and security review

Lock order: merchant row (shared boundary with M19), then statement/current period, posting claims in sorted ID order, carry claim. Policy activation uses a separate global publication lock and does not take merchant/financial locks. Database uniqueness protects current period head, statement version, posting consumption, carry consumption, positive payable per statement and action request. No Redis/process mutex or retry loop supplies financial authority.

Static SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK review covered forged amounts/dates/status/source IDs, foreign store binding, action grants/revocation, supersession/claim stealing, carry omission/reuse, historical leakage, generic CRUD and logging. Strict schemas, native platform identity, explicit grants, merchant lock, source joins, append-only evidence and deferred constraints are the implemented boundaries. No outstanding critical/high/medium finding was identified by static inspection; runtime authorization/concurrency remains user verification, not a claimed pass.

### Verification scope and handoff

`merchant-settlement-policy.test.ts` covers strict inputs, independent grants, signed checked-integer arithmetic, zero/positive amounts and the three-period carry vector. `test:merchant-settlements` uses real PostgreSQL connections/transactions, native test User identity, production service and the same SQL schema/functions as migration. Its private generated schema contains persisted M19 input-contract fixtures; it does not disable or mutate public M19 history or reconstruct economics from current Orders. Signed source fixtures are explicitly model-readiness only. This tests M20's consumption boundary, not a rerun of M19's native lifecycle/provenance suite.

The database verifier covers calendar/exact cutoff and microsecond boundaries, activation/historical holds, concurrent generation/replay, tax disclosure, clean/blocked items, immutable history, supersession/claim transfer and competing generation, readiness revisions/replay, new source exceptions, revoked grants, audit rollback, invalid deferred COMMIT rollback, late producer/generator concurrency, single carry consumption and zero/negative finalization. No browser suite is required. Verification commands have not been run by Codex.

The B handoff stopped before authorized READY_FOR_APPROVAL → APPROVED, payout receipts/attempts, FAILED/retry, PAID, beneficiary/transfer identity, discrepancies and reconciliation. C's implementation is recorded below. M20-D UX and M21 earnings remain unimplemented. Activation and grants are deliberate deployment inputs; negative production economics and upstream resolution remain the approved external boundaries.

User-run verification order (repository root; stop at the first failure): root lint; backend typecheck; targeted `tsx --test tests/merchant-settlement-policy.test.ts`; backend build; apply migrations to the existing isolated `_test` database; `pnpm --filter @gospaza/backend run test:isolated -- test:merchant-settlements`. The database verifier requires PostgreSQL/Redis for Medusa initialization, but no development or HTTP backend server. It creates/drops only its generated private test schema, never a database. The existing isolated environment helper remains unchanged. M19 production code is unchanged, so M19/M18 lifecycle or browser regressions are not requested for B.

## 18. M20-C implementation — user-verified before M20-D

### Ownership, forward migration and lifecycle

M20-A/B are user-verified. C consumes the immutable positive payable; it performs no bank transfer, refund, tax allocation, commission calculation, source reassignment or inventory mutation. No dependency upgrade or native Medusa payment/Order duplication is introduced. These are the marketplace's manual settlement assertions, following the SQL-owned M19/B architecture.

Forward migration `Migration20261107120000` adds a positive payable revision and the C statuses, preserving existing rows. The prepared **statement** remains READY_FOR_APPROVAL; only its linked **payable** advances APPROVED → PAID → RECONCILED, or APPROVED → FAILED → APPROVED. Statement and payable revisions are distinct. C command `expected_revision` refers to the payable revision, initially 1 at B readiness. No statement economics or B preparation history is rewritten.

The migration narrowly extends B's payable-status comparison to allow those downstream states against a READY statement. It retains the original item/component/manifest/source/claim/carry/preparation checks verbatim and fails migration construction if the expected B comparison changes. It replaces the payable guard with immutable-economics and audit-backed transition checks. Every SQL function is submitted in one named-dollar-quoted statement. No already-applied B migration is edited.

New immutable tables: `merchant_settlement_command`, `merchant_payout_identity`, `merchant_payout_receipt`, `merchant_payout_failure`, `merchant_payout_retry`, `merchant_payout_reconciliation`, `merchant_settlement_discrepancy`. There is no generated CRUD service. Command audit freezes actor, database timestamp, request fingerprint/identity, explicit confirmation/reason, prior/new payable revisions, prior/resulting status and the unchanged approved amount/currency. Deferred checks require a complete audit chain and the corresponding receipt/failure/review/evidence at COMMIT; failed persistence rolls back the action.

### Approval, recording, failure and reconciliation

Approval requires its own grant, READY payable, expected revision, confirmation/reason, a fresh locked read, B consistency and no open payment discrepancy. Exact request replay returns the recorded outcome plus current status/revision; changed-input replay conflicts. Concurrent identical requests converge; distinct commands for the same revision have one winner.

A successful receipt records externally performed transfer evidence. It copies the authoritative statement/payable/merchant/store/amount/currency and links the immutable approval command, operator command and transfer identity. It preserves the opaque off-platform verified-beneficiary reference, actual transfer instant, database recording instant and optional opaque evidence reference. The command actor/request/reason are joined immutable evidence, not copied mutable fields. HTTP success is not independent bank confirmation; D must label this as an **externally performed transfer recorded**.

Initial transfer channel is BANK_TRANSFER. Originating account/channel identity is an opaque operational reference, not banking credentials. Origin reference and external transfer identity are case-sensitive identifiers; surrounding whitespace is trimmed, no fuzzy matching or case folding. PostgreSQL reserves the globally unique tuple `(channel, origin_reference, external_transfer_id)` across successful receipts and failed attempts with known identities. A narrative is not the identity. Successful recording always requires an external transfer ID. Observed integer cents and ZAR must exactly equal the frozen payable; partial/excess/split payouts reject. One receipt per payable is enforced by uniqueness.

Actual transfer/attempt timestamps must be valid, at/after the most recent approval/retry and at/before database time. No forward clock-skew tolerance is introduced because the repository establishes no payout convention requiring one. Client preflight uses database time; a trigger compares exact PostgreSQL precision. Operators record real past events, not speculative future transfers.

FAILED requires an actual attempted transfer, explicit nonreceipt confirmation, beneficiary/origin references, attempted time, reason and evidence reference. Allowed categories are BANK_REJECTED, RETURNED_BEFORE_RECEIPT and RAIL_CONFIRMED_FAILURE. HTTP timeout, unknown outcome, cancellation and missing evidence are not failure categories. The failure is separate from successful receipt, immutable and retained through retry. If an external attempt identity is available it is reserved permanently; if unavailable it remains absent rather than invented. No correlation against an unknown identity is claimed.

Retry requires the approval grant, FAILED revision, confirmation/reason, exact prior failed-attempt identity and a review reference. It appends a retry audit and preserves the original failure and economics. A later successful receipt requires a new known transfer identity; a known failed identity cannot be reused.

Reconciliation requires its own grant, PAID revision, explicit confirmation/reason, matching successful receipt and a review reference. The operator must match amount/currency, beneficiary, channel, origin, external identity and transfer time to the recorded receipt. No open discrepancy may exist. The separate review command is immutable, exact retries converge and RECONCILED admits no further lifecycle transition. It does not claim automatic bank, accounting-system or merchant confirmation.

### Discrepancies and private evidence

Open discrepancies are append-only, bounded categories with evidence reference and command actor/time/reason/request. They may be recorded from READY onward by a payout recorder or reconciler. Unknown outcome preserves the current lifecycle state; it is neither PAID nor FAILED. Paid disputes/returns preserve receipt and PAID history. A later issue after RECONCILED appends attention evidence without reversing reconciliation. Discrepancies do not increment the payable lifecycle revision, but require its current expected revision under the same lock. Discrepancy versus reconciliation is serialized: earlier doubt blocks review; a later separately confirmed issue preserves the completed review.

C implements no discrepancy-resolution command. OPEN records cannot be edited/deleted or cleared through a checkbox. An unresolved issue blocks approval, payout, retry and reconciliation. A future bounded resolution policy is required before held payment work can resume. This deliberately avoids inventing certainty or enabling another transfer while outcome is unknown.

Proof upload/download is deferred. `evidence_reference` and `review_reference` are bounded opaque off-platform references, not public URLs; no file is uploaded, fetched or served. No raw bank-account, credential, proof-content or storage-key field is accepted. Ordinary projections omit beneficiary/origin/transfer/evidence references and fingerprints/idempotency internals. A narrower evidence read is available only to explicit approvers, payout recorders or reconcilers; VIEW alone is insufficient. No evidence values are logged.

### Authority and minimal APIs

Separate allowlists are SETTLEMENT_VIEW_USER_IDS, SETTLEMENT_PREPARE_USER_IDS, SETTLEMENT_APPROVE_USER_IDS, SETTLEMENT_PAYOUT_RECORD_USER_IDS and SETTLEMENT_RECONCILE_USER_IDS. No financial, commission, goodwill or refund grant implies these. Native User existence and current grants are rechecked after write-lock acquisition. A single user may explicitly hold several grants. Merchant OWNER/MANAGER/PICKER, customer and driver actors have no operational access. Platform grants are platform-wide, not merchant-membership grants; merchant/store authority comes from the frozen statement, never a submitted tenant ID.

Under `/admin/gospaza/merchant-payouts`:

* GET collection: bounded keyset operational attention/read queue, at most 25 rows.
* GET `/:id`: ordinary status, amount, approval/history, bounded receipt/failure/reconciliation/discrepancy summary.
* GET `/:id/evidence`: narrower operational evidence read.
* POST `/:id/approve`, `/payout`, `/failed-attempt`, `/retry`, `/reconcile`, `/discrepancies`: strict, grant-specific commands.

Existing B statement reads now include the linked payable ID/status/revision/amount/currency so C/D can navigate to the authoritative lifecycle record. No full UX is introduced. Existing platform actor/origin protections apply, bodies are capped at 8KB, responses are private/no-store and errors do not expose SQL/evidence. No endpoint accepts authoritative net, source membership, tenant, approved amount or generic status. Payout/reconciliation amounts are observed evidence checked against persisted authority.

### Concurrency, recovery and verification

Lock order remains merchant → statement → payable → attempt/receipt → discrepancy/review audit. Global transfer uniqueness arbitrates conflicts across merchants without reversing this hierarchy. No process mutex, sleeps, retries, external calls or timeout increases are used. Approval/pay, two recorders, failure/pay, retry/pay, pay/reconciliation, two reconcilers and discrepancy/reconciliation all preserve the one-revision/one-receipt/audited-state boundary. Unknown outcomes remain explicit attention, not guessed terminal states.

Recovery is read-only and bounded: the collection query surfaces APPROVED/FAILED/PAID and discrepancy-bearing records for authorized review. It does not fabricate receipts, retry transfers, auto-mark PAID, auto-reconcile or rewrite evidence. Human assertions remain explicit actions.

Unit tests cover allowed/forbidden edges, exact money/currency, timestamp policy, identity validation, failure/retry/review shape, action grants and non-platform API rejection. `test:merchant-payouts` composes the smallest B PostgreSQL verifier against both forward schemas, then uses independent transactions for C races. It covers approval/replay/staleness, fresh M19 holds, exact payment, partial/excess/currency/date rejection, private projection boundaries, receipt uniqueness, failed-attempt retention/retry, unknown outcomes, paid disputes, terminal reconciliation, competing commands, audit/persistence rollback and a real deferred-COMMIT negative control. B assertions are preserved; the B verifier now installs the C schema because its constraints and B read projection are extended. No M18/M19 or browser rerun is required.

Static SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK review covered forged economics/status/tenant, action-level grants/revocation, known-ID access, transfer reuse, failure/retry abuse, timestamp backdating, reconciliation without matching evidence, unresolved discrepancies, generic CRUD and private-reference leakage. Strict commands, native platform identity, fresh action grants, source locks, immutable references, global uniqueness and commit-time audit consistency enforce these boundaries. No outstanding critical/high/medium finding was identified by static review; runtime proofs remain pending user verification.

M20-C was subsequently user-verified before D was authorized. Its economics, transitions and evidence authority remain frozen. D implementation is recorded below.

## 19. M20-D implementation — awaiting user verification

### Projections, authority and presentation

Explicit contracts and clients distinguish platform list/detail, merchant list/detail and narrower payout evidence. Existing admin statement GET routes are finalized to these DTOs; GET `/admin/gospaza/merchant-settlements` adds bounded pagination. Merchant GET `/merchant/settlements` and `/:id` derive tenant/store from active membership. OWNER/MANAGER alone receive `MERCHANT_SETTLEMENT_VIEW`; PICKER receives no new capability. No database migration or economic/transition change is introduced. C's existing action-grant mapping is extracted without behavior change and reused for server-derived action hints. Commands continue to revalidate independently.

Platform reads use coherent repeatable-read snapshots. Merchant reads use the established merchant authorization/locking boundary. Summary joins are one-to-one and attention uses EXISTS, avoiding duplicated statement rows. Merchant DTOs exclude platform actor IDs, notes, request identities, fingerprints, repair information and raw beneficiary/origin/evidence references. Their external transfer reference is masked. Ordinary platform VIEW does not imply sensitive evidence access or any action grant. Narrow evidence remains explicitly fetched under C's existing grants. All responses remain private/no-store.

Admin `/admin/settlements` and `/:id` and merchant `/merchant/settlements` and `/:id` reuse session, resource, feedback and table conventions. Exact signed minor-unit strings are formatted with BigInt; no browser financial arithmetic or period-policy calculation is introduced. Periods display the frozen server timezone. Entitlement, statement net, positive payable, approval, external payout and reconciliation remain distinct. Tax held is disclosed as policy, not revenue or a tax ownership conclusion. Historical holds are under review, not payable debt; unknown held amounts remain unknown. Nonpositive statements show no payout created, with signed carry where applicable.

Admin actions require reason, review and confirmation. Approved payable is read-only; transfer amount is separately observed evidence. Transfer recording explicitly does not send money. Failure requires an actual attempt and proven nonreceipt; retry retains failure history. Reconciliation displays the recorded evidence and matches it through C's command. Discrepancies preserve PAID/reconciled history, display attention and block further actions while unresolved. No discrepancy-clear/reset/delete action is invented. Conflicts and uncertain responses trigger authoritative refetch and fresh review, never automatic replay. Sensitive review values remain component memory only and are cleared with the refreshed resource. Merchant UI is read-only. Loading, empty, denied, API-error and lifecycle states use existing patterns.

### Acceptance fixtures and security review

Fixtures use native auth/users, genuine merchant applications/provisioning and active team invitations. B/C's exact SQL and persisted M19 input-contract fixtures live in a private generated schema; public M19 economics are untouched. This proves M20's consumption/API boundary, not M19 provenance again. An opt-in request-scoped database override is restricted to the M20 route families, requires NODE_ENV=test, APP_ENV=test, an existing `_test` database, a strictly named schema and its explicitly qualified marker. Installed Medusa 2.18 creates a child scope per request, so this does not replace the global container connection. No header/client chooses the schema. With the flag absent the default path is unchanged. Native authentication/origin checks and real production handlers still execute; no browser API mocks are used.

The API verifier owns separate mutable statements from all browser journeys. It gates browser execution by marking the manifest only after success. Three journeys own distinct records: lifecycle; failed attempt/retry; immutable merchant-read fixture. Existing manifests are refused by setup. A transition consumes its mutable fixture; after a subsequent assertion failure preserve output and generate a fresh manifest rather than blindly replaying it. Browser contexts/sessions are independent. Credentials are HMAC-derived from a process secret, never stored in the manifest. Browser trace/video/screenshots are disabled to avoid persisting payout evidence.

Direct API acceptance covers action-specific grants, strict input/mass-assignment rejection, stale/changed replay, partial/excess/currency rejection, duplicate transfer identity, reconciliation without payment or with discrepancy, tenant isolation and explicit DTO field allowlists. Membership revocation is exercised over HTTP on the same session and restored. Environment-based platform grant revocation uses the established M19 pattern: obtain the identity through native authenticated HTTP, then invoke the actual handler with that same identity while removing the verifier-process grant, proving immediate denial without re-login. This is not claimed as an external backend process environment mutation. Grants on the acceptance backend are fixed explicitly by its launcher.

| Source → transformation | Trust boundary → sink | Protection |
| --- | --- | --- |
| Known/forged statement ID → scoped query | Merchant membership → DTO | Own merchant/store predicate; missing and foreign indistinguishable; PICKER denied. |
| Native platform session → current grant | Action/evidence handler → read/write | Independent grant checks; no VIEW implication; fresh command checks. |
| Client evidence/revision → strict C command | Persisted payable → audit/receipt | Frozen amount, transfer uniqueness, immutable audit and existing deferred invariants unchanged. |
| Database rows → role allowlist | Backend DTO → browser | No raw model serialization; merchant masking; narrow evidence separated. |
| Test manifest/schema → guarded child scope | Test process → private fixture schema | `_test`/environment/name/marker guards; no request selection; no default override. |

No confirmed critical/high/medium finding remains from static inspection. Runtime authority/privacy/browser acceptance is still pending user execution. No verification command was run by Codex. M20 cannot close until those checks pass. M25 performance/deprecation debt remains unchanged; M21/M22/M23 are not implemented.

### User-run verification (repository root; stop on the first failure)

Run each command separately in PowerShell:

```powershell
pnpm run lint
pnpm run typecheck
pnpm --filter @gospaza/api-client exec tsx --test tests/merchant-settlements.test.ts
pnpm --filter @gospaza/ui exec tsx --test tests/settlements.test.ts
pnpm --filter @gospaza/backend exec tsx --test tests/team-policy.test.ts tests/merchant-payout-policy.test.ts
pnpm --filter @gospaza/backend run build
pnpm --filter @gospaza/admin run build
pnpm --filter @gospaza/merchant run build
```

Expected: zero lint/type errors, targeted tests pass, three builds succeed. The targeted C grant-policy regression is required because D extracts its shared mapping; the real API verifier also exercises the unchanged C commands. No SQL/economic change requires repeating B/C concurrency or unrelated M18/M19 suites.

Use the existing migrated isolated database and Redis. In terminal A, generate fresh fixtures (expected: manifest path, no existing-file error):

```powershell
$env:APP_ENV='test'; $env:M20_VERIFY_SECRET=node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"; $env:M20_BROWSER_MANIFEST=Join-Path (Get-Location) ('test-results\m20-'+[guid]::NewGuid().ToString('N')+'.json'); pnpm --filter @gospaza/backend run test:isolated -- test:settlement-fixtures
```

Terminal B, start the isolated **built** backend and leave it running (expected: sanitized `_test`/Redis1 summary and listening backend; no develop server):

```powershell
$env:M20_BROWSER_MANIFEST=(Get-Content -Raw .\test-results\m20-current-manifest.txt).Trim(); pnpm --filter @gospaza/backend run acceptance:m20-server
```

Back in terminal A, retaining its manifest and secret, run API acceptance before browser acceptance:

```powershell
pnpm --filter @gospaza/backend run test:isolated -- test:settlement-surfaces
pnpm exec playwright test --config=playwright.m20.config.ts --workers=1
```

Expected: API authority/privacy assertions finish and mark the manifest; then all three browser journeys pass. Stop on any failure. After a financial transition, use a fresh manifest and restart terminal B against that manifest before retrying. The helper does not create/drop databases or edit `.env`; no new migration is required for D.
