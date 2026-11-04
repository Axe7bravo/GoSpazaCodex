# M19 — Marketplace finance and commission ledger

M19-A is the policy contract. B, C and D are proposed implementation slices. The PRD's marketplace economics, the build plan and the M18 handoff are the product and source boundaries for this contract.

## 1. Ownership and vocabulary

Medusa owns the commercial Order, native item and shipping economics, payment, refunds and Store Credit. M10 supplies the completed checkout and funding receipt. M11 binds that Order to one merchant/store through OrderOperation. M16 supplies verified delivery completion. M17 supplies restricted-return custody. M18 owns customer adjustments, approval, allocation and compensation execution. M19 owns commission rule history, frozen terms, economic recognition, attribution, exceptions and append-only marketplace postings.

| Term | Meaning |
| --- | --- |
| Order economic value | Historical consideration for goods and shipping, with discounts and taxes distinguished. It can exceed the amount charged externally. |
| Tender | How the customer funded that value, including native Store Credit and Yoco. |
| Commission basis | Eligible delivered tax-exclusive merchandise consideration including any proven merchant make-whole merchandise subsidy. |
| Platform commission | Rounded charge on the cumulative basis under the Order's frozen rule. |
| Merchant economic entitlement | Merchant-attributable merchandise consideration after commission and signed economic adjustments. Attributable tax is separately identifiable. Settlement tax treatment is outside this calculation. |
| Settlement | M20's later consumption of postings into weekly merchant statements and payout accounting. M18's existing financial_settlement is a customer-adjustment settlement and retains that meaning. |

M20 owns cutoffs, negative carry-forward execution, batches, DRAFT / READY_FOR_APPROVAL / APPROVED / PAID / RECONCILED / FAILED, manual transfer recording and reconciliation. No payout-provider call belongs here. M21 owns driver earnings. Delivery fees do not measure driver earnings.

## 2. Published terms and historical selection

Publish an append-only platform default or merchant override with integer basis points in [0, 10000]. Zero is explicit. A merchant CLEAR is an effective-dated decision with no rate. Starting at its effective instant it follows the platform default applicable at each Order's rate date. It does not freeze the platform default at the clear date. A missing applicable default yields an exception; do not silently install a production rate.

Use authoritative native Order creation time once the linked M10 completion proves success. Effective intervals include their start and exclude the next decision's start. Resolve the latest effective merchant decision and applicable platform default against that instant. Store the selected version, including the clear/default chain where relevant. Never select by delivery time, retry time, current merchant settings or the time the worker first sees an Order.

Use database timestamps, expected revision and a unique effective instant per scope. Serialize publication and establish a prospective effective instant at or after the serialized publication boundary; forbid inserting a decision behind an already frozen Order so delayed and immediate materialization agree. Keep published history and audit immutable. Conflicting simultaneous publications fail explicitly. No platform CLEAR or retrospective replacement of published terms.

## 3. Original component evidence and basis

Use the native Order and verified M10 handoff through the existing economic reader in `apps/backend/src/lib/financial-native.ts`. Cross-check original line IDs, quantities, recorded totals/tax, shipping and funding. M18 splits native discounted line total into net merchandise and recorded tax; shipping net and tax remain separate. Allocate by the existing stable unit ordinals. Preserve component evidence needed beyond the M18 public DTO, especially original discounts and sponsor attribution. Never reprice from current catalogue, promotion, tax or ServiceZone settings.

For eligible units, let N be recorded discounted tax-exclusive merchandise and S the proven tax-exclusive platform-funded amount that makes the merchant whole. Basis B = N + S. Record N and S separately; the merchant merchandise entitlement before attributable tax is B minus commission. A subsidy is counted once in B and never again as a second merchant sale. Merchant-funded discounts already in N receive no second deduction. Require stable line/component allocation for order-wide or split-funded discounts. Missing sponsor evidence for an applied discount, or missing proof of its merchandise portion or make-whole treatment, makes the affected economics unresolved.

Exclude shipping, delivery fees, their tax and adjustments from B. Preserve recorded attributable merchandise tax separately; do not apply a fixed VAT rate. Do not gross up a Yoco capture by assumption. Reconcile actual Store Credit and external tender to the immutable order value. Issued credit and later redeemed credit are distinct events.

## 4. Recognition and M18 attribution

| Authoritative source | Marketplace effect |
| --- | --- |
| Authorization, payment initiation | No frozen commercial Order or earning from authorization alone. |
| Successful M10 completion and native Order | Freeze terms and original economics. No earned posting. |
| Acceptance, picking, pickup | No ordinary earning. Retain terminal picked/omitted unit evidence. |
| Verified successful delivery | Recognize eligible delivered units once at delivery completion. Exclude known terminal omitted ranges. |
| M11 rejection or completed all-omitted order | Preserve paid-order history. Zero earned sale; no recognition posting. |
| Terminal omission or delivered shortage | Use M18 approved attributable merchandise components and original unit ranges. Exclude at recognition if already known, otherwise post only the change to previously recognized units. Tax changes have a separate component. Open shortages and review flags alone authorize no debit. |
| Approved goodwill | Platform customer-care cost by default. No change to merchant entitlement, commission or inventory. Only a distinct authoritative responsibility source could establish a different attribution. |
| Restricted failure and completed return custody | Undelivered goods earn no ordinary sale. M18 recipient cause may retain shipping; POLICY/review remains unresolved. Neither custody, native inventory disposition nor a refund proves a separate merchant compensation amount. |
| Cancellation, carriage failure, returned/damaged goods | Use only authoritative terminal source and attribution. If separate merchant compensation is at issue without approved policy, record an exception. Never manufacture commissionable revenue to settle it. |
| Refund/credit requested, uncertain, failed or settled | M18 owns execution. Preserve references/status separately. No merchant posting solely because customer money moved. Do not duplicate an approved allocation on its settlement or tender restoration. |

Before posting a reversal, intersect the approved source's ranges with previously recognized units and previously posted changes. A known omission excluded at recognition consumes no later reversal. An unexplained mismatch requires review. Post corrections at their economic event date with their own recorded date and original recognition reference. Reprocessing does not rewrite historical amounts.

## 5. Arithmetic and worked acceptance vectors

All figures below are ZAR minor units. Rates are fixtures. For nonnegative cumulative B and integer rate r, C(B) = floor((B × r + 5000) / 10000). Use checked integer or bigint intermediates and enforce persistence bounds. For any change post C(new B) minus C(old B), including negative changes. A reversal cannot make the cumulative recognized basis negative. Apply this once per Order's cumulative basis, not separately to each line. Preserve M18's deterministic per-unit net and tax allocations.

| Case | Inputs and expected facts |
| --- | --- |
| Yoco sale | Delivered N=10000, r=1000, external=10000. B=10000, commission=1000, merchant merchandise entitlement=9000. |
| Identical mixed tender | Credit=6342, Yoco=3658. Same 10000 basis, 1000 commission and 9000 entitlement. |
| Merchant promotion | Original net=10000, merchant discount=1000, N=9000. At 1000 bps, commission=900, entitlement=8100. |
| Platform promotion | Same customer net=9000; proven S=1000. B=10000, commission=1000, entitlement=9000; record subsidy=1000. Unknown sponsor instead produces an exception. |
| Recorded tax and shipping | Merchandise total=11500 including recorded tax=1500; shipping=2300 including tax=300. Gross=13800. B=10000, commission=1000, merchant merchandise entitlement=9000; preserve tax=1500, shipping net=2000 and shipping tax=300 separately. |
| Odd cents | B=105, r=1000. Exact charge=10.5 cents, rounded charge=11, entitlement=94. |
| Omission before delivery | Net=1001 over three units allocated 334,334,333. Last unit omitted. B=668, C=67, entitlement=601. Later issuance for the omitted unit changes none of those figures. |
| Delivered shortage proved later | Previously B=1001, C=100, entitlement=901. Approved merchant-attributable reduction=333 from recognized goods. New B=668, C=67, entitlement=601; signed changes −333 merchandise, −33 commission, −300 entitlement. |
| Rejected order | Paid 10000, rejected before delivery. Preserve terms, zero earned, no sale posting even after refund. |
| Full unfulfillable order | All five units terminally omitted. Zero earned, no sale posting, no second reversal on customer compensation. |
| Goodwill | Approved platform goodwill of 500 after ordinary sale. Original B=10000 and C=1000 remain; merchant delta=0. |
| Restricted handoff failed | Returned goods worth 4000, no successful delivery. No earned sale. If merchant reimbursement is sought without an approved responsibility source, record unresolved compensation. |
| Rate changes in transit | Order created under 800 bps, 1200 bps becomes effective before delivery. For delivered B=10000 charge 800, entitlement=9200 even if the provisioning worker runs after the change. |
| Two partial reversals | At 1000 bps, B=10 gives C=1. Reduce to B=5: C=1, delta=0. Reduce to B=0: C=0, delta=−1. Combined commission delta=−1, exactly the one-step full reversal. Independently rounding two 5-cent reversals would wrongly subtract 2. |
| Historical Order with no trustworthy rule | An old paid Order predates available rate history. A current 1000-bps default provides no evidence for it. Record unresolved historical terms, with no numeric earnings inferred. |

## 6. Durable records and invariants for implementation

| Concept | Minimum evidence and constraints |
| --- | --- |
| Commission rule version | Scope, platform or merchant identity, SET/CLEAR, effective instant, bps or null on CLEAR, recorded timestamp, actor, bounded reason, audit ID and scope revision. Unique revision and effective instant per scope, including singleton platform scope. Enforce valid rate/decision combinations and immutable history at database level. |
| Order finance snapshot | Unique native Order and unique OrderOperation; bind both to the same M10 completion, merchant/store and ZAR. Freeze rate instant, effective rule/clear/version/rate, calculation-policy version, economic version/fingerprint, unit and component evidence, sponsor evidence and resolution state. Preserve unknowns rather than representing them as zero. Track resolution evidence additively; never overwrite a resolved snapshot's terms. |
| Finance posting | Immutable signed merchandise, attributable tax, platform subsidy, platform commission and merchant entitlement effects with explicit component meanings. Include currency, tenant, snapshot, source identity/revision, economic date, recorded date, policy version and original posting/correction link. Unique recognition per Order and database-unique effect identity per source/component or unit range; prevent overlap across revisions. No caller-supplied amount. |
| Finance exception | Durable reason, affected Order/source/ranges, missing or contradictory evidence, first observation and linked resolution evidence. Deduplicate repeated discovery. Distinguish confirmed zero earnings, pending fulfillment and unresolved economics. Preserve trustworthy facts; withhold unsupported postings. M20 must be able to identify unresolved effects without interpreting provider states. |

M20 owns posting consumption. The M19 ledger stores no batch ID, payout state, bank transfer, or editable remaining balance.

## 7. Authority, serialization and recovery

| Actor | Server authority |
| --- | --- |
| Customer, driver, PICKER | No marketplace commission, postings or entitlement access. Existing customer adjustment resolution remains M18. |
| Merchant OWNER/MANAGER | If exposed, read-only own effective/applied rate, order adjustments and merchant entitlement. Resolve active membership and verify merchant/store/order relationships server-side. No cross-merchant figures, platform-only notes or configuration writes. |
| Platform finance reader | Separately authorized read of rule history, postings and exceptions. |
| Platform commission configurator | Explicit write grant; validate merchant scope, effective instant, revision, rate, reason and confirmation. Record actor/audit atomically. No implied M18 refund, goodwill or credit-execution authority. |
| Internal posting workflow | Derive all inputs from authoritative records; no public posting or caller-calculated total endpoint. |

Serialize first publication and later decisions per scope. Use a database-backed boundary between effective publication and Order-rate selection, including simultaneous creation; a transaction started earlier must not publish a rule retroactively after a snapshot has resolved. Under the existing merchant → OrderOperation lock order, serialize snapshot, recognition, adjustment range claims and postings. No provider, inventory or payout calls under ledger locks. Use unique source/effect keys, transactionally coupled audit and atomic commit. Duplicate triggers converge; differing fingerprints for one identity fail closed. Order approval versus recognition must yield the same final economics in either order. A worker crash after commit must re-observe the original effect. Use bounded durable keyset repair for missing snapshots/postings and deduplicated exceptions; events may accelerate discovery.

## 8. Cutover, slices and acceptance

Record the deployment cutover instant and publish approved prospective rules before enabling earning. No implicit percentage or blanket historical backfill. Before cutover, require demonstrable rule history, attributable economic components and recognition evidence as of the original dates. Missing evidence creates a durable exception. Validate counts and component totals in a bounded replay; rerunning the same range must neither duplicate earnings nor replace exceptions with today's configuration.

* **B — terms and snapshots.** Add rule publication/history/audit, snapshot/evidence, exception persistence, deterministic basis/rounding policy and bounded provisioning. Use migrations for ownership, uniqueness, rate and immutability constraints. Verify arithmetic vectors, mixed tender, cutoff and exact-time boundaries, zero vs missing, clear vs override, forbidden backdating, sponsorship gaps, known foreign IDs, unauthorized writes, simultaneous publications, delayed snapshotting and transactional audit failure. No earned postings in B.
* **C — economic postings.** Add recognition, approved attributable changes, correction lineage and repair. Verify real delivered/rejected/omitted/restricted fixtures, same source in opposite event orders, overlapping ranges, duplicate workers, crash recovery and rollback at COMMIT.
* **D — projections and acceptance.** Implement approved role-specific visibility and configuration UX. Verify known foreign tenant IDs, revoked access, strict requests and bounded DTOs. Use browser acceptance for user-visible behavior. Keep calculation/concurrency proofs in unit and real PostgreSQL tests.

Use the repo's isolated verifier with the existing test database, Redis /1 and matching built backend. M18 regression coverage remains authoritative for customer money movement. Outstanding rollout inputs are the actual authorized default/rule effective dates, evidence for promotion sponsorship and merchant make-whole amounts, and any future policy for exceptional merchant compensation or settlement tax allocation. An absent input never supplies an implicit rate, sale or payout.

## 9. M19-B implementation and verification gate

The Marketplace migration introduces four SQL-owned records: commission_rule, commission_rule_audit, order_finance_snapshot and order_finance_exception. They are deliberately absent from generic MedusaService write methods. An immutable rule FK supplies historical revision/effective-time evidence. Exception rows inherit their order/tenant from the snapshot. A new mismatch against a previously resolved snapshot appends a deduplicated exception; the read projection reports UNRESOLVED without modifying the original state, evidence or fingerprint. Provisioning a snapshot produces no earned effect.

The admin commission-rules GET/POST uses the existing platform user session boundary. COMMISSION_CONFIGURE_USER_IDS permits publication and history; FINANCIAL_VIEW_USER_IDS permits history and Order finance reads. Configuration authority alone cannot read an Order snapshot. Publication requires confirmation, a bounded reason, expected revision and request identity. Identical replay returns its original decision. Same-key changed content conflicts. The Order snapshot GET accepts only an Order ID; no merchant/customer/driver route is added.

PostgreSQL stamps a decision after acquiring the publication lock. Immediate effectiveness rounds upward to the first representable millisecond on the native Order clock. Explicit effective times have millisecond-or-coarser precision and may never precede actual recording. Readers take the shared side of the publication lock for historical resolution. A deferred constraint requires matching audit at commit. No seed installs a production rate; the first verified historical decision establishes coverage for its scope. Existing orders outside that coverage get an exception.

Original sale evidence comes from the native Order and M10 funding/capture handoff. The M18 wrapper still applies its own current customer/refund eligibility checks. M19 has no immutable promotion-funder source in the current checkout. The calculator supports documented allocations, but a native discount or adjustment alone cannot prove them: such Orders remain unresolved. No field on an admin snapshot request can supply this evidence.

An authorized single-Order read serves the durable snapshot and linked exceptions, provisioning it when missing. Repeated internal ensure commands compare newly observed evidence against the original fingerprint. The internal finance:provision-snapshots script processes at most 25 missing records per invocation; M19_PROVISION_AFTER resumes the returned keyset cursor. Restart a sweep from the beginning to revisit deferred records. No subscriber or worker is required for commercial checkout to succeed.

Verification consists of commission-policy unit tests, test:commission-foundation (rollback fixture, native Order reads, deferred constraints and mismatch evidence), and test:commission-api (retained disposable fixture, actual HTTP grants and simultaneous committed requests). test:commission-actors provisions two disposable native users for that API verifier; its manifest contains synthetic emails/IDs only. Run the API verifier with explicit financial fixture retention. Verification is pending user execution.

## 10. M19-C recognition and the approved delta deferral

M19-B is user-verified. The current M18 source set can prove a terminal picking omission on the undelivered suffix of a line. It has no approved adjudication command for a shortage on a unit already handed over. The implementation decision for C is to defer post-delivery economic deltas, including the recognition-versus-new-reversal race, until that M18 source exists. Do not construct a synthetic source, accept caller-submitted reversals or claim that B's rounding tests establish a production reversal path.

After the M16 successful completion transaction commits, it emits gospaza.delivery-completed containing the Order ID. The subscriber treats the ID as a lookup hint. The internal repair command uses the same recognition service. A missed event or delayed snapshot can be recovered from the durable delivery record. Provision a missing B snapshot first. A snapshot with unresolved finance cannot produce an earned posting.

Recognition joins the frozen snapshot to the owned OrderOperation and delivery, exact successful delivery completion and native fulfillment receipt, successful SHIP operation, completed commitment and DELIVERED audit revision. The validated completed picking session, terminal omitted quantities and actual shipment manifest must agree. Only the physically supplied prefix of each line earns its M18 ordinal allocation of tax-exclusive merchandise and separately recorded tax. Mixed tender and shipping have no effect. A proven platform subsidy is a separate amount; an aggregate subsidy without trustworthy unit allocation cannot be guessed for a partial shipment.

One marketplace_finance_posting stores five signed minor-unit columns together: merchandise, attributable tax, subsidy, platform commission and merchant merchandise entitlement. Entitlement equals merchandise plus subsidy less commission. The snapshot FK supplies immutable merchant/store/Order, ZAR and original terms. The completion and delivery event FKs, revision, economic delivery instant, database recording instant, calculation version, recognized ranges and fingerprint are the audit trail. A source-validated insert publishes the entire effect. Unique Order-snapshot/kind and completion/kind/revision identities prevent duplicate earnings. Updates and deletes are rejected. Subsequent recognition recomputes from recorded evidence without looking up current configuration or promotions.

Lock order is merchant, OrderOperation, finance snapshot, then completed picking evidence under that Order lock. The M18 financial writer and recognition serialize on the same merchant/Order prefix. When the omission entitlement materializes after posting, its ranges must agree with the quantities already excluded. Goodwill approval, native Store Credit issuance, provider state changes and inventory disposition do not create another earning or debit. Rejection, completed all-omitted picking and a failed restricted handoff backed by its return source are known zero ordinary sales with their existing durable operational evidence. A separate merchant compensation claim has no approved source or pricing policy.

Conflicting recognition evidence, unsupported adjustment attribution and posting source conflicts use append-only order_finance_exception records. A replay never replaces the original posting. The internal finance:repair-earned-sales command validates at most 25 delivered snapshots in ascending snapshot-ID order. Use M19_RECOGNITION_AFTER for the exclusive lower bound and optionally M19_RECOGNITION_THROUGH for an inclusive upper bound. Correct rows produce no new writes. Follow the returned cursor; restart the sweep to revisit late or deferred work. M19-C adds no public finance endpoint or permanent worker.

The test:commission-recognition verifier uses explicit single-use retained fixtures: a genuine restricted successful delivery with three of five units supplied, a separate failed restricted handoff, a rejected Order and a completed all-omitted session. It exercises rollback, invalid source references, an isolated conflicting-fingerprint negative control, concurrent recognition/repair, an 800-to-1200 bps rule change, late omission materialization, goodwill and actual Store Credit issuance. Runtime verification is pending. M19-D owns authorized read projections, UX and final acceptance; M20 owns settlement consumption.

## 11. M19-D projections and final acceptance

A through C are user-verified. D adds no financial tables, earning source or settlement transition. Admin financial adjustments accepts an Order reference and shows the allowlisted marketplace economics. The merchant Order detail shows its own store's economic result under MERCHANT_ORDER_VIEW, which the current matrix grants to OWNER and MANAGER. Earned amounts come from the immutable posting. The original order basis is explicitly distinguished from the delivered basis. A terminal zero sale uses the same operational eligibility checks as recognition, without posting on the merchant read. An unresolved calculation carries no invented numeric entitlement.

The platform commission console at /admin/commissions reads paged scope history, the current applicable rule and the latest publication revision from the backend. SET, CLEAR, future and historical decisions remain distinguishable. A missing rule and a published zero rate render differently. Review freezes the selected scope, rate, instant, reason, revision and request identity before confirmation. Following a successful or uncertain submission the console reads server history again. A conflict requires reviewing a new decision.

| Source | Transformation and trust boundary | Sink and verification |
| --- | --- | --- |
| Merchant session and Order reference | Resolve active membership under the merchant lock, enforce order capability and match OrderOperation to both tenant IDs | Merchant DTO allowlists own Order, applied rate, safe outcome and earned economic amounts. Direct tests cover owner, manager, picker, missing vs foreign IDs, forged store query and revoked manager session. |
| Platform session and Order reference | Check VIEW before provisioning and recheck before returning. Select bounded snapshot, posting and exception fields | Platform DTO includes rule/version, merchant/store, dates and exception reasons. No native account, provider identity, source fingerprint, private custody or raw posting payload reaches the response. |
| Platform rule command | Separate CONFIGURE grant, strict command, database publication timestamp, expected revision, request identity and atomic audit | No history edit/delete. Direct checks cover ungranted and view-only writes, amount injection, backdating and configure-only denial for Order finance and credit issuance. |
| Customer or driver session | Existing actor middleware rejects access before M19 projections | Targeted verifier checks direct M19 reads and existing customer/driver response fields. |

The M19 browser gate uses two apps and three real-session journeys. The configuration test owns a single-use merchant rule scope. Earned and known-zero Orders are read-only and belong to another merchant. Browser contexts are isolated; no API interception or test-issued financial totals. The fixture command uses a new disposable lifecycle dataset and verifies the API boundaries before it writes its manifest. Membership revocation is exercised on a live API session; foreground/refetch uses the established resource lifecycle that clears denied data. No backend-restart browser ceremony is required.

Closure requires successful targeted API, component and browser verification and resolution of any credible security/correctness failure. Post-delivery merchandise adjudication remains deferred pending an approved M18 source. M20 consumes immutable economics and owns settlement and payout status. Existing M25 performance items remain separate.
