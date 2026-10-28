# M17 — Alcohol Compliance

## Contract status and scope

### M17-D implementation status

M17-A/B/C, including forward migration `Migration20261027120000`, are user-verified. M17-D adds role-specific presentation, bounded review/return queues, transport-copy minimization and acceptance coverage. D runtime verification remains pending; no verification commands were executed by Codex. See `M17_D_ACCEPTANCE.md` for the static review, retained launch gates, M18 handoff and ordered verification commands. Earlier slice verification notes below are historical.

Merchant classification proposals remain distinct from platform-reviewed authority. Physical receipt by OWNER/MANAGER/PICKER restores custody only. Neither the UI nor the new reads authorize commercial returns, refunds, restocking or financial resolution. The driver transport copy excludes internal policy/record identifiers and customer name/phone while the full original remains immutable backend evidence.

### Approved M17-C contract — recipient evidence and physical return

M17-A/B are user-verified. C implements backend contracts only; D owns presentation and browser acceptance. The approved request supersedes earlier proposed C gates.

- The original electronic delivery document is retained immutably against the authoritative Order and origin Store; the assigned driver receives a bounded copy. Its address and transported restricted quantities come from native Order and completed picking/physical fulfillment evidence, never browser fields. Production documentation remains disabled unless DELIVERY_DOCUMENT_POLICY_APPROVED=true and a nonempty policy version is configured. This does not activate the unavailable remote purchaser provider.
- Recipient checks start only at ARRIVED with a current occupied assignment, proven native shipment and active handoff generation. PURCHASER and ALTERNATE_ADULT follow identical checks; predesignation is not required in MVP and remains counsel-reviewable.
- Physical IDENTITY_DOCUMENT, DRIVERS_LICENCE or PASSPORT must be viewed. DOB is transient only. Age is calculated in Africa/Johannesburg; a leap-day birth reaches the threshold on 1 March in a non-leap anniversary year (conservative product rule pending counsel confirmation). Future or malformed DOB is invalid. No document numbers/images or identity narratives are accepted.
- School uniform, declared current school-going learner status, apparent intoxication, refusal and address mismatch independently prevent handoff. These are bounded observations, not medical diagnoses or a claim of legally conclusive evidence.
- Immutable recipient outcomes are unique per Delivery/current handoff generation, bound to assignment and DriverProfile. Success and failure serialize under the existing merchant/profile/affiliation/availability/order/picking/Delivery/commitment lock prefix, then generation and recipient/return rows. A winning outcome cannot be overwritten. OTP consumes only current-generation SATISFIED evidence; absent evidence does not consume attempts. Native completion designation is an irreversible no-return boundary.
- Failure means hand over nothing, including groceries. RETURN_REQUIRED -> RETURNING_TO_STORE -> RETURNED_TO_STORE records physical custody only. Driver arrival and active origin-merchant OWNER/MANAGER/PICKER receipt are both required. Quantities derive from the actual native physical fulfillment manifest, excluding omissions. Receipt, audit, terminal return and exactly-once commitment release share one PostgreSQL transaction. No native Return, inventory restock, refund, store credit or earnings is performed.
- Capacity stays occupied through failed handoff and return arrival. Existing assignment authority survives eligibility/licence changes. Such changes never grant handoff permission; invalid seller authority fails closed into return/attention. Customer tracking stops exposing coordinates once return is required.
- M18 may trust immutable delivery/order/store/document references, outcome and bounded failure category, physical manifest, native fulfillment, failed/returned timestamps, return identity and merchant receipt actor. financial_review_required remains true; no financial resolution is implied.
- Remaining launch gates: remote purchaser method, final document format/electronic original-copy sufficiency, alternate-adult policy, school-learner evidence, licence conditions and privacy retention. No general override is introduced.

Implementation status: M17-C backend slice implemented; static review completed. Runtime verification remains pending; Codex has not run lint, typecheck, tests, builds or migrations.

#### C implementation and irreversible boundaries

`RestrictedDeliveryDocument` owns the retained original and bounded assigned-driver copy. `RestrictedCommerce.supplyAuthority` owns current seller/premises/category/stage-window checks. `RecipientService` owns transient observation evaluation, immutable generation-bound evidence and physical custody. M16 remains owner of OTP and native completion. No recipient input is persisted as workflow input; raw DOB is discarded after evaluation.

The unique recipient-generation constraint establishes one winning decision. M16 checks that exact generation before testing OTP. A `delivery_completion` designation remains the irreversible boundary: C cannot create a return after designation, even when native completion is uncertain. A new OTP generation requires fresh recipient evidence. No recipient outcome is rewritten.

Invalid seller authority before the winning recipient decision produces `COMPLIANCE_RECOVERY_REQUIRED` and whole-order return custody. If seller authority changes **after SATISFIED**, OTP is blocked and Delivery becomes `ATTENTION_REQUIRED`, retaining the assignment and immutable successful observation. Automatic reversal of that observation or an unproven capacity release is deliberately unavailable; explicit operational recovery remains future scope. Return commands remain available for already-established return custody even when driver eligibility changes.

`restricted_return` retains the exact successful SHIP manifest and origin Store. Driver arrival is insufficient to release capacity. Receipt by an active origin-merchant OWNER/MANAGER/PICKER, receipt audit, Delivery `RETURNED_TO_STORE` and commitment `RETURNED` commit together. Deferred checks prohibit a native delivery-completion operation alongside return custody. A duplicate receipt reads the original result. Native Return, stocked inventory, payments/captures/refunds and commercial Order fields are not mutated.

#### C static security review

| Source | Transformation | Trust boundary | Sink / enforcement |
| --- | --- | --- | --- |
| Driver session + supplied Delivery ID | M14 binding and existing merchant-first pickup lock prefix | Known ID is not ownership | Current assigned DriverProfile; foreign IDs unavailable |
| DOB/document/recipient observations | Strict allowlist and SA-calendar threshold evaluation | Client cannot set age, outcome, destination or quantities | Immutable bounded recipient evidence; no DOB/document number/image |
| Order/picking/registration evidence | Native readback, frozen restriction snapshot and exact physical manifest | Catalogue/address-book edits are not in-flight authority | Immutable document and current seller-policy checks |
| OTP request | Current-generation recipient lookup before OTP | Purchaser evidence and old recipient evidence cannot authorize handoff | Existing M16 OTP counters and one native completion designation |
| Merchant receipt | Active membership/capability revalidation under owning merchant lock | Driver arrival alone and client tenant fields cannot release capacity | Atomic return receipt/audit/commitment release |
| Customer/merchant reads | Existing ownership guard and bounded projection | No broad recipient or location disclosure | No DOB, document inspection details, OTP or return GPS trail |

New API families: driver recipient/document/return commands; origin-merchant return receipt and retained document; owned-customer restricted-handoff status. GET responses use private/no-store. Driver and receipt payloads are limited to 8 KB. Existing actor session/origin protection applies. Recipient admission uses M16's durable throttling; no browser replay or in-memory lock is authoritative.

#### C verification (user-run, stop on each failure)

2026-10-27 forward schema correction: `Migration20261027120000` replaces only `gospaza_recipient_consistency()`. The applied C function reused `v` as both a PL/pgSQL recipient record and a SQL alias in the restricted-completion subquery, causing PostgreSQL 42702 at deferred execution. Descriptive record names, separate SQL aliases and qualified columns preserve all predicates and the five existing deferred trigger attachments. The original migration remains unchanged; existing and fresh databases converge by applying the corrective migration in sequence. `test:recipient` now explicitly reaches COMMIT for valid restricted state and rejects invalid completion/custody combinations at COMMIT, checking rollback and exact invariant errors. No constraints are removed and no historical data is rewritten. Runtime verification remains user-run.

From repository root, with Next dev processes stopped: `pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @gospaza/backend run test`, `pnpm --filter @gospaza/api-client run test`, then `pnpm --filter @gospaza/backend run build`.

With PostgreSQL/Redis available and backend stopped: `pnpm --filter @gospaza/backend run db:migrate`. Then start the normal backend only with the established local Yoco verification configuration and HANDOFF_OTP_SECRET; keep background reconciliation/dispatch/handoff workers disabled as required by the existing verifiers. Run `pnpm --filter @gospaza/backend run test:recipient`, `pnpm --filter @gospaza/backend run test:handoff`, and `pnpm --filter @gospaza/backend run test:restricted-commerce` sequentially. Recipient composes all existing pickup/dispatch/order/reconciliation/checkout prerequisites; none is skipped. Its purchaser adapter and approved document policy are injected only inside the isolated local verifier. Do not enable production restricted commerce for tests.

Expected: zero lint/type errors, passing unit/client suites and build, successful migration, each integration verifier's success message. M17-D may start after these pass and user review. No new browser UI or browser suite belongs to C.

#### C material file manifest

- `milestones/MILESTONE_M17_ALCOHOL_COMPLIANCE.md`
- `apps/backend/.env.example`, `apps/backend/.env.production.example`, `apps/backend/package.json`
- `apps/backend/src/modules/marketplace/recipient-policy.ts`, `restricted-policy.ts`, `team-policy.ts`, `dispatch-rows.ts`, `service.ts`
- `apps/backend/src/modules/marketplace/models/recipient-compliance.ts`, `restricted-delivery-document.ts`, `restricted-return.ts`, `delivery-operation.ts`, `dispatch-commitment.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261026120000.ts`
- `apps/backend/src/modules/marketplace/migrations/Migration20261027120000.ts` (forward function correction)
- `apps/backend/src/lib/recipient-service.ts`, `recipient-http.ts`, `restricted-delivery-document.ts`, `restricted-commerce.ts`, `dispatch-readiness.ts`, `handoff-service.ts`, `pickup-service.ts`, `delivery-tracking.ts`, `dispatch-projection.ts`
- `apps/backend/src/api/middlewares.ts`
- `apps/backend/src/api/driver/deliveries/[id]/recipient/route.ts`, `document/route.ts`, `return/start/route.ts`, `return/arrive/route.ts`
- `apps/backend/src/api/merchant/deliveries/[id]/return/route.ts`
- `apps/backend/src/api/merchant/orders/[id]/restricted-document/route.ts`
- `apps/backend/src/api/store/gospaza/orders/[id]/restricted-handoff/route.ts`
- `apps/backend/src/scripts/verify-recipient.ts`, `verify-payment-reconciliation.ts`, `verify-dispatch.ts`, `verify-pickup.ts` (existing helpers gain explicit optional local fixture injection; default paths and assertions remain)
- `apps/backend/tests/recipient-policy.test.ts`
- `packages/contracts/src/recipient.ts`, `applications.ts`, `dispatch.ts`, `handoff.ts`, `index.ts`
- `packages/api-client/src/recipient.ts`, `index.ts`, `packages/api-client/tests/recipient.test.ts`


### Approved M17-B refinement — Restricted Commerce Foundations

The user approved M17-A and narrowed B to seller registration/evidence/review, platform-authoritative product classification, immutable checkout restriction evidence, trading policy, purchaser eligibility interface, cart/checkout gates and bounded APIs/audit. This supersedes the original unconditional B start gate below. No remote purchaser method is approved: the production adapter must return UNAVAILABLE; there is no environment flag, customer assertion or generic platform override that makes it VERIFIED. Test adapters are injected only by fixture code. Restricted dispatch also remains blocked until an approved Free State documentation implementation exists. Neither gate satisfies M16 recipient compliance.

All product identities require platform review (NONE or ALCOHOL); unknown legacy products are not grandfathered. Variants inherit product classification. Merchant material identity edits invalidate review; merchant alcohol proposals conservatively block sale until review and cannot downgrade an existing ALCOHOL decision. Reviewed ordinary groceries do not require a liquor registration or purchaser verification. Existing test groceries must receive explicit fixture review, never a production auto-approval.

Store-bound registration supports nullable expiry, category-specific capabilities, private evidence, platform-reviewed conditions and versioned Africa/Johannesburg trading windows. Pending evidence is not permission. Separate sale/dispatch/handoff policy applicability remains explicit; unresolved policy blocks restricted activity. Production has no purchaser provider or delivery-document implementation in B. Licence-specific conditions, remote purchaser/learner proof, delivery documents and recipient rules remain legal launch gates.

B excludes recipient verification, driver identity inspection, alternate recipients, compliance satisfaction, return custody, refunds, native Returns, inventory changes and UI. C/D remain separately authorised. Purchaser evidence never authorises a recipient. No commit or verification commands are authorised.

M17-A reconnaissance and proposed durable contract, 25 October 2026. M16 is user-verified, committed and merged. This document changes no production behavior. Recommendations below require milestone approval; outstanding legal decisions are not silently approved by this document.

M17 adds three distinct subjects: **seller/store authorisation**, **purchaser eligibility**, and **actual recipient eligibility**. It extends the existing M16 handoff prerequisite and records a failed restricted handoff and physical return. It does not replace Medusa Orders, Payments, Fulfillments, inventory, Returns or refunds.

**Readiness verdict:** M17-A has produced a usable technical contract. Unconditional M17-B implementation is **not yet safe**: the purchaser verification method, provincial school-learner checks, licence-specific delivery/trading policy, classification moderation policy and evidence retention need the decisions listed in section 18. A separately authorised, disabled-by-default licence/classification foundation could proceed without enabling restricted sales. No such implementation is authorised by M17-A.

## 1. Legal evidence and limits

Research date: 2026-10-25. This is an engineering contract, not a legal opinion or certification of any merchant's licence. Before production restricted commerce, South African liquor-law counsel and the relevant authority must confirm the consolidated rules, current licence conditions and GoSpaza's seller/agent/carrier responsibilities. Publication/upload timestamps are not treated as commencement dates. No proposed national age increase is treated as enacted law.

### Primary-source register

| Ref | Source and inspected provisions | Classification / finding |
| --- | --- | --- |
| L1 | [Liquor Act 59 of 2003, official text](https://www.gov.za/sites/default/files/gcis_document/201409/a59-03.pdf), definitions and ss 9–10; [government status page](https://www.gov.za/documents/liquor-act) | National legislation. Under-18 sale/supply prohibition and reasonable measures to determine age before sale/supply. The limited parental/religious exception is not a marketplace-sales permission. Advertising must not target minors. National rules do not replace provincial retail authorisation. |
| L2 | [National Liquor Norms and Standards, GN R85, Gazette 38459, 13 February 2015](https://www.gov.za/sites/default/files/gcis_document/201502/38459reg10363gon85.pdf), paras 1.3–1.4, 4.2–4.4, 4.13–4.14, 5 | Published norms, not the 2013 draft. They address ID/passport/driving-licence age checks, refusal of identification, secondary supply and apparent intoxication. Their implementation provisions require attention to legislation and licence conditions; do not assert that every paragraph automatically overrides provincial legislation. Off-consumption bottle-store sales above 25 litres entail specified purchaser/sale records retained five years. This is not a universal five-year ID-scan requirement. Trading-hours provisions depend on local rules. |
| L3 | [Authority-hosted Act 6 of 2010 consolidated through 2017](https://www.gla.fs.gov.za/wp-content/uploads/2025/10/FSGLT-Act-6-of-2010-updated-2017-as-amended.pdf), ss 22–30, 46–48, 57–60 | Provincial legislation baseline, **not current on its own**. Premises and registration category matter. Grocer's-wine registration is not permission to sell every alcohol category. Read with L4 and later instruments. |
| L4 | [Free State Amendment Act 3 of 2024, PG12, 10 May 2024](https://www.gla.fs.gov.za/wp-content/uploads/2025/05/PG-12-of-10-May-2024-Free-State-Gambling-Liquor-and-Tourism-Amendment-Act-No.-3-of-2024.pdf), amendment ss 15–16, 32, 35, 43, 98, 101; printed pp 9–11, 24, 26, 29, 43 | Commences on publication. Replaced s26 prohibits supply to under-18s **or school-going learners**; requires viewing ID/driving licence/passport and consideration of school uniform; refusal includes missing ID and school uniform. Added s57(4) requires prior order, invoice retained at the registrant's premises, copy with the delivery vehicle, and delivery matching invoiced liquor/address. Annual renewal and legacy-licence conversion provisions matter. These are binding text, not invented product rules. |
| L5 | [PG78, Provincial Notice 77 of 2024, 29 November 2024](https://www.gla.fs.gov.za/wp-content/uploads/2025/10/Provincial-Gazette-No.78-29-November-2024.pdf), pp 2–5 | Official renewal notice with business-hours schedules. Its liquor-store/grocer-wine table prints 08:00–20:00 Monday–Sunday (with inconsistent am/pm notation). It also contains transitional tables. Do not hardcode this as universal, perpetual permission. Confirm the applicable certificate/category, current notices and municipal provisions. |
| L6 | [Mangaung draft liquor by-law hosted by municipality](https://www.mangaung.co.za/wp-content/uploads/2025/10/Bylaw-Liquor-Trading-Draft-2018.pdf) | Explicitly marked draft; not proof of an operative gazetted by-law. Its 2025 upload does not establish enactment. Obtain the operative municipal instrument or authority confirmation. |
| L7 | [POPIA 4 of 2013](https://www.gov.za/sites/default/files/gcis_document/201409/3706726-11act4of2013popi.pdf), ss 10–14, 18–22, 34–35, 72 | Binding privacy law: minimisation, lawful purpose/basis, notices, security, purpose-limited retention and deletion/restriction. Decision records need a reasonable access opportunity. Children's information has additional restrictions and statutory exceptions; do not assume an ordinary adult consent checkbox resolves them. DOB/document numbers are personal information, not automatically biometrics or every category of special personal information. Cross-border processors need a lawful arrangement. |
| L8 | [Information Regulator guidance on children's information](https://inforegulator.org.za/wp-content/uploads/2020/07/GuidanceNote-Processing-PersonalInformation-Children-20210628-1.pdf) | Official guidance, distinct from legislation. Requires careful treatment of s35 exceptions versus Regulator authorisation. An unsuccessful age check can still process a child's information. |

L4 was inspected visually because the web PDF reader returned no text. The authority's TLS certificate was expired during direct retrieval; a single public-document request exception enabled in-memory inspection. No credentials were sent or persistent TLS settings changed. Obtain an authenticated gazette/licence copy for legal sign-off. The official notice index independently identifies the same Act/date. Research does not certify that no later instrument exists.

Important legal interpretation gates:

- Read amended s47 (premises rule) together with s57(4), the licence and GoSpaza's agency/payment/delivery arrangements. Do not infer that platform collection of payment creates an independent liquor-retailing licence, or that off-consumption permits unrestricted mobile selling.
- Confirm how document **viewing** and school-learner restrictions apply to remote purchase, including an adult learner. An age-only token, self-entered DOB, or checking only the doorstep recipient is not a proven solution.
- Confirm whether an alternate adult may receive the invoiced delivery, whether designation is required, and restrictions on proxy purchase for an ineligible person. No arbitrary purchaser-ID match is invented.
- Confirm electronic versus paper invoice/original/copy requirements, invoice contents, records prescribed by the MEC, and applicability of bulk-sales records. M13 omissions must not make the transported manifest and legal documentation inconsistent.
- Confirm effective trading/supply hours at ordering, payment, pickup and doorstep, holiday/extension rules, document types and acceptable foreign documents. No blanket acceptance of screenshots, photocopies, expired documents or student cards.
- Determine whether visually observed intoxication refusal and its evidence are sufficient for this delivery model. M17 proposes refusal as a safety policy regardless; it does not diagnose intoxication medically.
- Review annual renewal and legacy conversion evidence. Do not assume an old licence scan remains valid indefinitely or infer validity from a future-looking expiry field alone.

## 2. Repository evidence and existing owners

Paths below are relative to the repository root. Findings are static source inspection, not newly executed tests.

| Existing owner | Inspected evidence / implication |
| --- | --- |
| M2/M3 onboarding | `modules/marketplace/models/application.ts`, `models/document.ts`, `validation.ts`, `service.ts`, `workflows/approve-merchant.ts` under `apps/backend/src`. `intends_to_sell_alcohol` is a declaration; `LIQUOR_DOCUMENT` is an application attachment category. Submission completeness does not establish a verified current liquor authorisation. Merchant approval/provisioning is not liquor approval. |
| Physical store | `modules/marketplace/models/merchant-store.ts`: unique merchant/store relationship, premises address and native stock-location/fulfillment references. Bind licence evidence to this exact Store and reviewed premises identity. |
| Private files | Marketplace `service.ts` creates native File records with `access: private`; `lib/application-http.ts` streams authorised bytes with no-store, attachment and sandbox headers. File keys are generated; size/type/signature checks and failed-deletion tombstones exist. Reuse this storage boundary, not application ownership as permanent liquor authority. |
| M4 | `team-policy.ts`, `merchant-authorization.ts`: OWNER/MANAGER can manage catalogue; PICKER cannot. Tenant/member authority is server-derived and revalidated under merchant-first locking. New compliance permissions must be explicit. |
| Platform review | `api/middlewares.ts`, `lib/driver-http.ts`, `driver-service.ts`, `lib/dispatch-service.ts`: native `user` session and native User existence are the present platform trust boundary. A granular alcohol-review capability is **not already implemented**. M17 must add a narrow server-owned grant/policy, not pretend generic user authentication supplies the requested capability or build all of M23. |
| M5 | `catalogue-policy.ts`, `models/product-profile.ts`, `lib/catalogue-service.ts`, `workflows/create-catalogue-product.ts`, `update-catalogue-product.ts`: merchant-controlled boolean writes `product_marketplace_profile.requires_age_verification`. Native Product/Variant/prices/inventory remain commercial owners. |
| M7/M8 | `lib/storefront-service.ts` displays current classification; `lib/cart-service.ts` resolves product/store through Discovery and enforces current-cart, customer and single-store binding. This is not purchaser-age verification. |
| M9 | `lib/delivery-reservation-service.ts`, `scheduling-service.ts`: authoritative location/option/slot and configuration freshness. M17 must compose a restricted-eligibility predicate, not replace serviceability, slot capacity, shipping sync or native fees. |
| M10 | `modules/marketplace/checkout-policy.ts`: frozen snapshot has customer/store/address/reservation/shipping/totals/items but **no immutable restriction/classification or purchaser evidence**. Payment initiation/reconciliation and terminal completion remain authoritative; redirects are not payment evidence. |
| M11 | `lib/order-operations-service.ts`, `order-operation-repository.ts`: successful terminal M10 handoff and native Order are required before operational provisioning; actor-scoped reads and decisions remain intact. |
| M12/M13 | `lib/picking-service.ts::completedForDispatch`: validates picked plus terminal omissions, returns physical manifest and `financial_review_required`. M17 must return only goods actually dispatched, not omitted units, and never clear financial-review evidence. |
| M14/M15 | `driver-service.ts`, `lib/dispatch-readiness.ts`, `dispatch-service.ts`, models `delivery-operation.ts`, `dispatch-commitment.ts`: metadata-free driver binding, current eligibility, one active OFFERED/ASSIGNED commitment per driver/delivery. Redis location is not commitment authority. |
| M16 | `lib/pickup-service.ts`, `handoff-service.ts`, `handoff-native.ts`, `modules/marketplace/handoff-policy.ts`, `Migration20261024100000.ts`: physical pickup, arrival, bounded OTP generations, at-most-one native completion dispatch, terminal readback and fail-closed recovery. Restricted compliance currently always returns REQUIRED. |

### Current restricted-content flow and confirmed gap

`merchant product body.requires_age_verification`
→ M5 strict boolean validation and tenant/capability checks
→ merchant-writable ProductMarketplaceProfile
→ storefront warning; no M10 immutable classification snapshot
→ `dispatchReadiness` resolves native variant/product IDs and current merchant-owned profiles
→ `profiles.some(requires_age_verification)`
→ Delivery flag refreshed at dispatch/offer/assignment stages
→ M16 `handoffCompliance(delivery.restricted_content_present)`.

Missing profiles fail closed in dispatch; that does not protect against a valid profile whose boolean is false. An authorised merchant can currently list/reclassify alcohol as unrestricted. A downgrade before assignment can remove the delivery gate. This is a **confirmed static high-severity alcohol-launch blocker**, not a claimed live exploit or a cross-tenant vulnerability. M16 correctly blocks deliveries already marked restricted; it cannot repair untrusted upstream classification.

No current purchaser-age verification or licence eligibility service was found. No restricted dispatch-invoice gate was found. These are planned M17 capability gaps, not regressions of verified grocery checkout.

## 3. Ownership and proposed records

Keep one Compliance domain owner inside the modular monolith. Use native Customer/User/Product/Variant/Order/Fulfillment references and existing marketplace/delivery identities. Do not add an identity provider, payment ledger, invoice accounting ledger, order store or inventory store.

Proposed bounded records (names are contract concepts, implementation must follow repository conventions):

1. `StoreRestrictedAuthorisation`: Store and merchant binding; verified premises fingerprint; authority, registration number/category, authorised product classes; evidence versions; annual renewal/conversion evidence; applicable dates; review status; platform decision actor/time/reason; reviewed trading-policy revision. Keep regulatory validity separate from platform review status. Optional expiry is evidence-driven, not fabricated.
2. `ProductRestrictionRevision`: native product, reviewed identity/variant scope, NONE/ALCOHOL classification, alcohol class/pack volume where necessary for licence/record rules, reviewer, effective revision and evidence reference. Pending/unknown is not NONE. Existing profile exposes the current projection, not independent authority.
3. `PurchaserEligibilityEvidence`: native customer, method/policy version, verified adult-threshold result and other required provincial eligibility outcome, verified_at, review/reverification deadline, revocation/correction, opaque evidence reference. Never a recipient authorisation.
4. `RestrictedCheckoutEvidence`: immutable classification revisions and native line/variant references, Store authorisation/policy revision, purchaser-evidence reference, policy decision/time, checkout revision. Bind to CheckoutAttempt and its authoritative native Order; no copied commercial totals as a new owner.
5. `RecipientComplianceAttempt`: Delivery, commitment/assigned driver, active handoff generation, policy revision, bounded observations/outcome/reason, actor/time and request identity. Unique terminal decision per attempt/generation.
6. `RestrictedReturnOperation`: unique failed-handoff obligation, immutable origin Store/commitment/SHIP/native fulfillment references, expected physical manifest, driver return-arrival evidence, merchant receipt acknowledgement, actual quantities/condition, terminal receipt/revision. This is custody evidence, not a native Return replacement.

Reuse append-oriented domain-event conventions and transactional audit. Do not create a parallel general audit platform. All new schemas require forward migrations, referential constraints, immutable identity columns and unique business keys in their implementation slices.

## 4. Seller/store eligibility

Merchant OWNER/MANAGER may submit or replace proposed evidence for their own Store. They cannot set reviewed status, validity, authorised classes or approval timestamps. PICKER has no licence submission/review permission. Platform reviewers require an explicit server-owned compliance permission, confirmation and bounded reason.

Proposed review lifecycle: DRAFT → SUBMITTED → APPROVED or CHANGES_REQUIRED/REJECTED; an approved revision can be SUSPENDED/REVOKED or superseded by another reviewed revision. Effective eligibility is derived from current regulatory evidence, approval, renewal, dates, premises, category and trading policy. Expiry does not require a worker to become effective.

Pending replacement evidence must not erase an unexpired valid revision, but cannot extend its validity. Invalid/unknown/expired/suspended/revoked evidence blocks restricted commerce. Ordinary groceries continue through existing policies. Changing physical premises invalidates the reviewed premises match until authorised again; no licence can be reused across Stores.

No self-reported document number, uploaded PDF, merchant approval, or `intends_to_sell_alcohol` grants eligibility. Review must establish the evidence against the issuing authority and relevant conditions. Licence categories restrict the kinds of alcohol, not merely a global yes/no.

Private evidence stays in the existing native File provider, attached through a compliance-specific owner. Referencing an old application attachment requires ownership and integrity validation; never accept an arbitrary storage key. Downloads reauthorise every request. Do not introduce recipient document uploads by reusing this seller-document mechanism.

## 5. Classification authority and immutable order truth

Recommendation requiring product approval: every sellable product identity must have a reviewed NONE or ALCOHOL classification before restricted-commerce launch. Merchant declarations are review proposals. Only authorised platform review can publish/reduce a classification. Otherwise the unreviewed-grocery path remains an alcohol bypass.

Review product identity/material description, variant identity and pack/class evidence together. Merchant identity-changing edits or new variants invalidate the relevant reviewed scope; price/stock edits need not do so. Native status changes must not publish around this gate. Titles/categories alone are not classifiers. Physical misdescription/collusion cannot be eliminated by software: reviewer evidence, merchant controls and spot checks remain necessary.

Variants inherit the reviewed product restriction; mixed product identities require separate products or explicit reviewed variant scope, not an unreviewed per-variant override. Unknown legacy products are not automatically grandfathered as NONE. Migration/backfill must require review or disable restricted launch; do not silently reclassify historical Orders from current titles.

At cart add/increase and restore, re-evaluate sellability. Before prepare/confirm/Pay, load current reviewed restrictions and eligibility. Classification/policy changes require a fresh checkout revision and explicit reconfirmation. Do not change shipping tariffs or weaken M9 freshness to implement this.

Freeze restriction evidence before payment side effects. Later native completion links the exact evidence to its native Order. Dispatch reads that immutable handoff, not mutable product-profile flags. An order marked restricted never becomes unrestricted through reclassification or omission. If every alcohol line is omitted, retain the conservative restricted-order flag for MVP unless a separately approved rule permits a documented release; preserve M13 financial review.

Discovery that a previously unrestricted paid Order actually contains alcohol creates a durable compliance hold/attention and remediation reference. Do not rewrite the original snapshot, silently authorise delivery, or call it compliant retroactively. Post-pickup custody remains protected.

## 6. Purchaser eligibility and checkout timing

Recommend verified purchaser eligibility before restricted add-to-cart/checkout preparation, with mandatory revalidation at confirmation and immediately before Yoco initiation. This intentionally avoids relying on a disputed later contract-formation instant. Browsing/display and advertising policy also need legal review; no claim that an unauthenticated catalogue age banner meets the law.

Self-declaration and self-entered DOB may collect user input but cannot independently establish verified eligibility. Payment-card possession, successful payment, an OTP or account authentication is not age evidence. A legally accepted remote document-viewing/age-verification method must be selected before B's purchaser implementation. Compare an approved external attestation provider with an approved manual verification process; neither is pre-approved here, and no provider is invented.

Reusable evidence is recommended only if the accepted method permits reuse. Bind it to the authenticated native Customer and verified account/person linkage; retain method/version and revocation/reverification policy. Do not let a customer upload a success token or change DOB to reset a failure. Evidence-service uncertainty blocks new restricted payment. Account sharing remains a residual risk requiring proportionate account-security controls, not a claim of personhood from login alone.

The purchaser policy must handle the Free State learner restriction as a separate rule; 18th birthday is not universal eligibility. Exact remote evidence and lawful processing are counsel gates. Do not invent a new school-document database.

Where DOB is legitimately used, parse a calendar date, calculate threshold server-side using the authoritative Africa/Johannesburg date, reject impossible/future dates and avoid floating-point age/year arithmetic. Proposed conservative leap-day rule: 1 March in non-leap threshold years, pending legal approval. Tests must cover both 28 February and 1 March; do not silently inherit JavaScript date rollover. Raw DOB is processed ephemerally where the approved evidence method allows; retain the decision/method, not DOB by default.

Payment races: an immutable eligibility decision authorises only its designated CheckoutAttempt. Revalidate before external initiation; licence revocation after dispatch of payment cannot be undone by replaying or forging a failure. Persist a compliance hold for affected paid Orders and leave financial action to its owner. M10 canonical provider operation, completion identity, capacity and RECOVERY_REQUIRED invariants remain unchanged.

## 7. Trading policy and dispatch documentation

Use a versioned, platform-reviewed Store policy with source/licence references, timezone, permitted product classes, local-day intervals, exceptions and effective dates. No policy/unknown applicability means restricted commerce disabled. Do not import another province's hours or the Mangaung draft as law.

Compose with M9: a restricted delivery window must fit the approved permitted supply interval, not merely begin before closing. Check checkout/Pay, selected slot, actual pickup and actual handoff. These multiple checks are a conservative proposed product control; counsel must define the precise sale/supply permissions. If timing slips outside permission, do not force handoff or invent a grace period. Scheduled checkout outside trading hours remains blocked until a legally supported separate ordering/supply policy is approved.

Required additional boundary from L4: before restricted dispatch/pickup, prove the prior native Order and a compliant invoice/delivery copy associated with its exact licensed origin, destination and transported goods. Generate/read the document from native commercial truth through supported APIs; retain an immutable document/evidence reference, not a second commercial ledger. No client-editable address or items. Freeze and reconcile the M13 physical manifest without inventing a reduced price or refund. The exact document form and treatment of omissions require legal approval and a bounded Medusa-native document capability check in B before implementation. No record of this gate exists today.

If bulk-sale record obligations apply, support the approved required fields/retention or refuse those transactions under an approved quantity policy. Do not silently ignore the threshold, invent a volume cap, or split orders to evade records. Reviewed per-pack volume is necessary if such a cap is chosen; title parsing is not enough.

## 8. Recipient verification and alternate adults

Recipient evidence is freshly established for the actual person at ARRIVED. Purchaser verification never satisfies this subject. The assigned authenticated DRIVER submits bounded observations; the server computes the policy outcome.

Proposed document enumeration: identity document, passport, driving licence, versioned centrally and narrowed by legally approved conditions. Document presented, required details readable, identity/photo comparison where applicable, DOB/threshold, school-uniform/learner and apparent-intoxication observations are evidence, not authority booleans. Reject submitted `compliance_satisfied`, `over_18`, `driver_id`, timestamps, Store IDs or generic status patches. Driver dishonesty is not cryptographically detectable; durable attestation/training/accountability are required.

Recommend visual inspection with minimal structured evidence, **subject to legal sufficiency**. No camera, scan, OCR, selfie, biometric match or document-number storage by default. Document viewing and recording a copy are different actions. Do not claim a driver's attestation proves document authenticity.

Alternate eligible adult remains the approved product direction **conditional on legal confirmation**. Model a bounded recipient role, not a required purchaser identity match. If predesignation is required, bind it server-side before the attempt; a name supplied by the driver is not customer designation. Until the policy is approved, no alternate-recipient route may authorise supply. Reject known proxy supply to an ineligible purchaser; an adult at the door does not cure invalid purchaser evidence.

Recommended failure policy for approval: a **submitted substantive refusal** (ineligible age/learner, ID unavailable/refused/unacceptable, apparent intoxication, or recipient-policy failure) is terminal for this handoff and creates the whole-order return obligation. Correct a form before submission; network errors are not substantive refusals. No second adult can reset a terminal failed delivery. Allowing a later adult after failure would require a separately approved, bounded new-attempt policy; it is not part of the recommended MVP.

## 9. Compliance evidence and M16 integration

Proposed attempt lifecycle: PENDING → SATISFIED or FAILED. Terminal attempt evidence is immutable. Same request identity and identical canonical payload returns its original receipt; changed payload conflicts. A unique delivery/commitment/handoff-generation tuple and row locking prevent opposing outcomes. No PENDING row is necessary merely because a page was opened.

`evaluateHandoffCompliance(delivery, commitment, handoff_generation, transaction)` is the single backend policy boundary:

- Proven unrestricted snapshot → SATISFIED_BY_POLICY.
- Restricted snapshot → requires current eligible Store/policy, legally valid purchaser linkage, exact active assignment/generation, terminal SATISFIED evidence and no hold/return/native-completion ambiguity.
- Missing or inconsistent evidence → REQUIRED/UNAVAILABLE, never a default success.

Integrate inside `HandoffService.verify` under the existing lock before OTP comparison, counters, consumption or native completion claim. Ordinary compliance failure does not spend OTP guess attempts. The existing one-dispatch native completion path remains unchanged after authorisation.

Regenerating OTP supersedes the old generation; its compliance evidence remains historical and cannot authorise the new generation. Require a fresh verification. Do not copy SATISFIED forward. Duplicate verification after a successful decision returns the original receipt; an opposing submission conflicts rather than rewriting evidence.

Success/failure race: first valid terminal decision under the shared locks wins. SATISFIED is not later edited into FAILED. A separately observed safety/eligibility change can place a delivery hold before completion is claimed; it does not falsify the old evidence. Once a completion operation exists, do not open a return or contradictory failure while native delivery may advance. Resolve through existing authoritative readback/RECOVERY_REQUIRED. This is at-most-one dispatch, not automatic exactly-once native recovery.

## 10. Failed handoff, return and driver capacity

Recommended minimal physical branch:

`ARRIVED → RETURN_REQUIRED → RETURNED_TO_STORE`

Use events/timestamps for failed handoff and driver return arrival, not redundant RESTRICTED_HANDOFF_FAILED/RETURNING states with identical permissions. ATTENTION_REQUIRED/RECOVERY_REQUIRED expresses unresolved custody or conflicting completion evidence. A terminal failed compliance attempt atomically creates one return obligation and prevents OTP completion/regeneration and new delivery assignment.

Return the entire **physically dispatched manifest**, including groceries. M13 omitted units were never in custody and are excluded. No partial doorstep grocery handoff. No `DELIVERED`, native-delivered call, refund, adjusted total, store credit or financial-resolution claim.

Origin Store derives from immutable Delivery/native SHIP evidence. It cannot be chosen by the driver or customer. Return completion requires two authenticated observations: assigned driver records arrival at origin; active origin-store OWNER/MANAGER acknowledges actual received quantities/condition. Recommend OWNER/MANAGER only for MVP; PICKER acknowledgement requires an explicit narrow permission approval, not automatic inheritance from picking. GPS is not physical receipt proof.

Both observations may arrive in either order, but only matching complete manifest receipt may make return terminal. Quantity mismatch, damage requiring custody clarification, unavailable merchant, closed store, revoked driver access or conflicting evidence leaves attention with capacity retained. Do not let participants edit manifest quantities to manufacture agreement. Append discrepancy evidence; no generic admin force-complete is included.

Keep the existing `ASSIGNED` commitment occupied while returning. On proven physical return, atomically produce the terminal return receipt/event and change commitment to a distinct proposed `RETURNED` terminal status. Do **not** reuse M16 `COMPLETED`, which currently proves successful delivery. Forward migrations must extend status constraints and precise deferred consistency checks for this mutually exclusive terminal branch. The unique active-commitment indexes continue to protect capacity.

An offline/suspended/revoked driver does not lose custody automatically. They cannot authorise new handoff under stale eligibility; preserve assignment and operational attention. Provide only approved narrowly scoped return-report capability for the bound custodian, or require explicit operational intervention; this exceptional capability needs approval before C. No new dispatch until return receipt or a later approved safe recovery establishes release.

Redis loss, failed audit, missing native history, guessed location, ID failure or a claimed return arrival cannot release capacity. PostgreSQL decides return/capacity atomically. Same return receipt replay is idempotent; competing acknowledgement is conflict. Native completion ambiguity always blocks this branch until delivery can no longer advance.

## 11. Pinned Medusa 2.18.0 return boundary

Inspected installed package:
`node_modules/.pnpm/@medusajs+core-flows@2.18.0_6818f4adc6c9c57dc8e4f7d26a6cf835/node_modules/@medusajs/core-flows/dist/`.

| Native source | Observed effects |
| --- | --- |
| `order/workflows/return/begin-return.js` | `beginReturnOrderWorkflow` queries native Order, creates Return and order-change request. This already creates commercial return state. |
| `order/workflows/return/confirm-return-request.js` | Creates return items; may create a return Fulfillment and remote link when return shipping exists; confirms order changes; emits RETURN_REQUESTED; invokes `createOrUpdateOrderPaymentCollectionWorkflow`. |
| `order/workflows/return/confirm-receive-return-request.js` | Computes received/damaged quantities, updates Return/items, confirms changes, adjusts inventory levels for appropriate returned goods, updates order payment collection, emits return/inventory events. Not merely a custody acknowledgement. |
| `order/workflows/return/receive-complete-return.js`, `order/steps/return/receive-return.js` | Another supported path delegates to native Order `receiveReturn`; compensation calls `revertLastVersion`. Its shorter orchestration does not make it an operational-only state store. |

The inspected confirmation workflows do not themselves show a Yoco refund invocation. Do not claim every native return automatically refunds. Nevertheless, their Order/payment-collection/inventory effects make them inappropriate merely to prove M17 physical receipt.

Decision: **M17 does not create/receive a native Return, mark the outbound Fulfillment delivered/returned, restock inventory or alter native commercial records.** M18 consumes the bounded physical evidence and chooses the supported native return/financial workflow. M17 stores native references and custody quantities only. Before M18 commercial integration, re-inspect its chosen full workflow/service path and bypass protections. No direct writes to Medusa-owned tables are permitted.

## 12. Licence/classification change and recovery matrix

| Moment/problem | Required result |
| --- | --- |
| Before checkout / purchaser service unavailable | Restricted path unavailable; groceries remain available; no provider operation created. |
| Prepared cart then policy/classification change | Invalidate eligibility revision; reprepare/reconfirm; no silent new total/terms. |
| Payment already initiated/captured | Preserve M10 evidence/freeze; compliance hold prevents unapproved picking/dispatch; M18 owns financial resolution. Never interpret this as failed payment or retry permission. |
| After picking, before physical pickup | Stop restricted pickup; preserve committed evidence and capacity until an authorised operational resolution. |
| After pickup/transit | Stop handoff; retain custody/assignment; safe origin return when legally/operationally possible, otherwise attention. No automatic reassignment/refund. |
| Misclassified paid order discovered | Append remediation/hold linked to original evidence; no downgrade/rewrite; no automatic successful handoff. |
| Verification/return request response lost | Read exact durable receipt; same idempotent request only where no conflicting outcome; do not manufacture a new attempt. |
| Audit insert failure | Business mutation rolls back in the same transaction. |
| Native completion may still advance | Existing RECOVERY_REQUIRED; no return terminality, refund or capacity release. |
| Physical return complete, finance unresolved | Return proven, M18 review pending; never say refunded or delivered. |

## 13. Locking, uniqueness and concurrency contract

Preserve the actual M15/M16 lock prefix: sorted relevant merchants → DriverProfile → current affiliation → availability → OrderOperation → pick session → Delivery → DispatchCommitment. `PickupService.locked` delegates the prefix to `DriverService.withEligibility`. Do not introduce a delivery-first path or start merchant acknowledgement holding a return row then acquire merchant locks.

Append pickup-operation rows in stable order → handoff generations in generation order → recipient attempt → delivery completion → return operation/receipt. All affected M16/M17 mutations must use the same documented order. Driver and merchant principals enter a common domain transaction after actor-specific authentication; revalidate membership/ownership after locking. Retain exact driver/commitment identity even when eligibility is lost.

Store authorisation/classification mutations lock the owning merchant before their own rows and append audit; they do not synchronously scan/lock every delivery. Consumers revalidate under the merchant prefix. Customer checkout preserves existing customer/cart locks and calls the compliance owner in the established order. No admin path may lock a customer after holding the merchant lock; purchaser evidence updates are short independent transactions, with consumers taking a consistent locked version before committing their authorisation.

Implementation gates: inspect and document any additional concrete row/advisory locks before edits. Never hold a PostgreSQL transaction while awaiting external identity verification. Persist an operation identity first, call externally, then validate correlation/current authority before accepting evidence. Evidence availability is not permission to bypass fresh validation.

Required structural protections: one immutable checkout evidence record per attempt; one current approved authorisation revision per Store scope; immutable reviewed classification revisions; one terminal compliance outcome per bound generation; one return obligation per failed delivery; unique receipt identity; no simultaneous delivery-completion and return authorisation; terminal return/capacity transition plus matching audit enforced transactionally and by appropriate constraints. No process-local locks or client timers provide correctness.

## 14. API / RBAC / projection boundary

Proposed route families; exact names must follow implementation conventions. No generic status mutation.

| Actor | Minimum actions / authority | Projection limits |
| --- | --- | --- |
| Platform | `/admin/gospaza/stores/:id/restricted-authorisation` review/approve/changes/suspend/revoke; reviewed product-classification commands; exact compliance-review grant plus reason/audit | Licence evidence available only to assigned authorised review roles; no default access for every native user. |
| Merchant | `/merchant/restricted-authorisation` own submission/status; own order restricted outcome; `/merchant/orders/:id/return-receipt` for approved receipt roles | Own Store, bounded status, physical quantities. No recipient DOB/ID/learner detail or purchaser verification payload. |
| Customer | `/store/gospaza/eligibility` own verification flow/status; owned order requirements/return outcome; alternate designation only if approved | No reviewer/provider diagnostics, other customers or valid driver-side OTP disclosure. |
| Driver | `/driver/deliveries/:id/compliance` requirements/decision; `/driver/deliveries/:id/return-arrival` | Bound current assignment only; accepted document types and necessary observations; no purchaser ID record, unrelated licence file or valid OTP. |

Strict schema, bounded identifiers/body/query, origin/session controls, no-store responses, actor-derived identity and non-enumerating not-found for foreign resources. Location stays under M16 policy; compliance does not expand tracking access. Reject client-supplied compliance result, driver/customer/merchant/store bindings, policy revisions used as authority, financial flags and native fulfillment IDs.

Existing native payment/completion/fulfillment bypass protections remain. Review native product/Order-edit/return entry points affecting GoSpaza-owned resources during implementation; a privileged native write must not silently invalidate reviewed classification, commercial linkage or custody. Do not broadly claim current middleware already blocks every native return/edit route.

## 15. Privacy, retention and audit

Separate seller business-licence files from purchaser/recipient identity evidence. Collect only the approved fields. No raw document number, photo, scan, selfie or raw DOB persisted by default; no sensitive input in browser storage, analytics, request logs, workflow execution history, exception messages or audit JSON. Perform ephemeral DOB evaluation outside persisted workflow input and pass only its bounded result/provenance into the transaction.

Recommended durable evidence: subject reference, delivery/commitment/generation where applicable, method/policy version, threshold/eligibility result, document type, bounded observation/failure category, authenticated actor, authoritative timestamp and original receipt identity. Do not store an identifying hash of a predictable ID number as a supposed anonymisation shortcut.

Retention is a purpose-specific, approved schedule, not an invented universal duration. Define separately licence validity/history, purchaser reusable evidence, rejected checks, recipient decisions, physical returns, legal sales records and audit. Include expiry, legal hold, access/correction/deletion workflow, operator contracts, backup expiry and restoration deletion replay. Prevent deleted personal evidence from being revived by backup restore. Retain non-personal integrity references where required without claiming that append-only means retain all identity data forever. Launch blocked until a lawful schedule and operational deletion mechanism exist for collected data.

The >25-litre records issue from L2 and invoices from L4 need their own approved obligations. Do not delete legally required records merely to satisfy a shorter generic setting. Conversely, do not use invoice retention to justify ID photography. Provide notices to actual recipients as well as purchasers; an alternate recipient has not necessarily accepted customer-account terms.

Use existing domain audit patterns for licence proposals/decisions, classification changes, purchaser decisions, recipient terminal outcomes, holds, return required and physical receipt. Record who/target/store/previous-result/new-result/time/reason/version. No raw DOB, number, intoxication narrative or school name. Bounded reason codes minimise disclosure. Sensitive evidence reads should be access-audited; ordinary merchant/customer projections receive neutral outcomes.

## 16. Security review and executable acceptance requirements

**Critical:** none established by this reconnaissance.

**High — confirmed static alcohol-launch blocker:** merchant-controlled classification can remove restricted handling. SOURCE merchant body → TRANSFORMATION valid M5 boolean/native product ownership → TRUST BOUNDARY merchant declaration treated as compliance truth → SINK dispatch flag/unrestricted OTP path. Require reviewed classification, controlled reclassification and immutable checkout handoff; test merchant false/new-product/material-edit variants and pre-assignment downgrades.

**Design concerns, not claimed existing exploits:** no purchaser/licence authority yet; no approved remote method; current platform trust is broader than a compliance-review capability; application attachments alone do not verify licences. These prevent enabling alcohol but do not justify asserting a broken current grocery flow.

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Required proof in implementation |
| --- | --- |
| Merchant licence/Store IDs → evidence submission → tenant + platform review → sale eligibility | Foreign Store/licence reuse, forged approval, expired/revoked/pending evidence denied; grocery unaffected. |
| Customer DOB/token → verification adapter → authenticated customer + verified issuer/policy → Pay | Forged age flags, another customer's evidence, revoked/expired evidence, service outage, learner restriction, exact birthday/leap-day and replay tests. |
| Product edits → reviewed revision → immutable checkout evidence → pickup/handoff | Unknown products fail closed, material edit cannot retain stale NONE approval, paid restriction never downgraded, classification/Pay race. |
| Driver ID/delivery/observations → server evaluation → current assignment/generation → SATISFIED | Wrong driver, foreign delivery, client success booleans, altered role, old generation, replayed evidence, mass assignment denied. |
| Compliance decision + OTP → locked policy evaluation → terminal authorisation → native delivered | Failure/success race; regeneration/success race; failure/OTP race; invalidation/claim race; failed gate leaves OTP counters untouched; duplicate cannot dispatch native completion twice. |
| Driver return + merchant receipt → manifest comparison → both authorised actors and origin → capacity release | Wrong Store/member, removed membership, fake foreign receipt, duplicate/racing receipt, short manifest, offline/Redis loss and recovery ambiguity never release early. |
| Documents/DOB/observations → DTO/log/workflow serialisation → least privilege → UI/storage/logs | Test no ID/DOB/photos/secrets in merchant/customer/driver projections, audit, traces and workflow history; authorised file stream only. |

Real PostgreSQL tests are required for opposing recipient outcomes, terminal return versus completion, two receipt workers, licence revocation versus checkout/pickup, stale generations and capacity. Unit tests alone cannot prove these. Add policy tests for typed documents, exact age/local dates, trading boundaries, category permissions, volume and invoice correlation if applicable.

Bound request rates/body size and verification-service operations; never allow caller-selected outbound verification URLs. Duplicate request IDs with incompatible payloads conflict. Neutral errors must not expose unrelated record existence. Browser tests must prove real actor-specific flows, refresh/reopen, alternate policy, neutral refusal/return wording, no compliance bypass through query parameters and no premature delivered/refund claims. Preserve all M9–M16 suites; do not remove prerequisite assertions or use arbitrary sleeps/state clearing.

## 17. Future UX, M18 and M21 handoffs

Future UX only: customer sees eligibility requirements and neutral progress; merchant sees licence review and physical receipt work; driver sees the current document/observation task before OTP and an explicit return obligation after refusal. Uncertainty disables duplicate mutation and refetches server state. Never show valid OTP to the driver or place identity details in URLs/storage. No humiliating labels in broad dashboards.

M18 may trust an immutable receipt containing Delivery/native Order, originating Store, restricted evidence reference, bounded failure category/time, return-required time, native SHIP/Fulfillment reference, expected/received physical line quantities and condition, driver return-arrival, merchant receipt actor/time and terminal return identity. `financial_review_required` remains true for this unresolved financial consequence and any M13 omission; M17 cannot clear it. M18 decides refund entitlement, destination, inventory and native commercial return processing idempotently. A physical return alone is not refund success.

M21 may distinguish delivered, failed restricted handoff and proven return-to-store using durable event/receipt IDs. No fee, payout or driver compensation is calculated here. M22 notifications and M23 broad operational recovery remain outside scope.

## 18. Exact slices and unresolved approvals

Retain the requested four top-level slices, with explicit stop gates inside B/C. Do not combine them into one implementation turn.

| Slice | Included | Excluded / start gate |
| --- | --- | --- |
| M17-A | This reconnaissance, source-backed legal distinctions, proposed state/API/privacy/return contract | No production/schema/UI changes; no tests run. |
| M17-B | Approved narrowed foundations: Store registration/evidence/review; platform classification; immutable checkout evidence; purchaser interface with UNAVAILABLE production adapter; M9/M10 gates; unresolved restricted-dispatch documentation block; policy/DB/API/concurrency tests | No recipient/return domain, UX, remote provider or guessed delivery documents. Restricted production sales remain disabled. The approval at the top of this contract supersedes the original requirement to choose a purchaser provider before implementing these foundations. |
| M17-C | Assigned-driver recipient verification; approved alternate policy; M16 prerequisite integration; whole-order physical return/receipt; distinct terminal capacity branch; concurrency/audit/privacy tests | No native Returns/refunds/restocking/earnings. Approve terminal failure policy, merchant receipt roles, custodian exception, and lock/constraint extension first. |
| M17-D | Customer/merchant/driver/platform UX; final privacy/security/concurrency/acceptance and full regression | No M18 commercial finance, OCR/biometrics, new push system or broad M23 override tools. |

Required decisions before unrestricted M17-B scope is safe:

1. **Counsel/authority:** current licence/category/premises/renewal/conversion evidence; GoSpaza agency role; current Mangaung and licence trading rules; delivery documentation and electronic copy acceptance.
2. **Counsel + product:** remote purchaser method satisfying amended s26, school-learner treatment, reuse/reverification, exact birthday convention; actual-recipient document/observation sufficiency; alternate-recipient conditions.
3. **Product approval:** reviewed classification for all sellable identities versus an equivalently effective moderation boundary; treatment of unknown legacy products and material edits. Merchant declaration alone is rejected.
4. **Privacy/legal owner:** lawful bases including unsuccessful/minor checks, processor arrangements, collection notices, retention/deletion/backup policy and bulk-sale record handling. No default ID capture.
5. **Product approval for C:** first substantive failure terminal; OWNER/MANAGER receipt; discrepancy handling; narrow custody-return rights on eligibility loss. No automatic retry with another recipient after terminal failure.
6. **Technical B gate:** source-check the smallest supported invoice/document rendering integration using native Order truth and omission manifest. Do not claim a payment receipt or generic order screen satisfies L4 without confirmation.

A time-limited legal review record must identify the approved source versions and decision owner. A code/config switch is not legal approval. Unknown rules keep restricted commerce disabled; they do not disable lawful grocery commerce.

## 19. Verification and completion record

- M17-A deliverable: this file only. No migration, production API/workflow/UI, dependency, runtime configuration or financial state change.
- Existing M16 verification is accepted as user-supplied history; no new test pass is claimed.
- Inspection used the authorised PowerShell fallback and primary-source research. No lint, typecheck, build, test, migration, seed, server or Docker command was executed.
- **Commands for the user to run for A: none.** Review this contract and resolve the named approval gates; a doc-only reconnaissance does not require rerunning the monorepo.
- Later slice reports must derive exact verification commands from the then-current package scripts and group no-server/static, backend/PostgreSQL/Redis, targeted browser, and full-regression environments. Do not invent an M17 verifier script before implementing it.
- The preceding bullets record M17-A only. M17-B implementation is recorded below. No commit or merge performed.

## 20. M17-B implementation record — pending user verification

### Ownership and authority

Medusa 2.18.0 retains native Product/Variant, Customer, Cart, Order, Payment and File ownership. B adds compliance evidence around their IDs; it does not write native commerce tables, alter money conversion, replace native checkout completion, create Fulfillment/Return, or satisfy M16 recipient compliance. Native File service stores private registration evidence. Native User authentication plus the explicit, server-owned `RESTRICTED_COMMERCE_REVIEWER_IDS` grant controls platform review; its default is empty. Being a native user alone is insufficient.

`RestrictedCommerce` owns classification, registration, purchaser evaluation and trading decisions. Routes authenticate/validate and call that service. OWNER/MANAGER reuse `MERCHANT_CATALOG_MANAGE`; PICKER receives no compliance authority. The tenant Store is resolved from active authenticated membership. Client Store/merchant/customer/reviewer IDs cannot replace those identities.

### Schema and lifecycle

`Migration20261025120000` adds:

- `restricted_registration`: one exact Store, composite Store/merchant FK, immutable binding, revision, current and pending submission, reviewed policy, premises fingerprint, review/approval/suspension/revocation dates.
- `restricted_evidence`: private native File key and bounded file metadata, exact Store/merchant FK.
- `restriction_review`: append-only product-profile classification revisions and identity fingerprint, platform reviewer/reason.
- `purchaser_eligibility`: customer-bound method/version/policy, minimum-age and provincial requirement evidence, verified/expiry times and lifecycle. No raw identity data.
- `restricted_event`: append-oriented bounded audit evidence.

Registration transitions are PENDING_REVIEW → ACTIVE or CHANGES_REQUIRED; changes can be resubmitted; ACTIVE ↔ SUSPENDED; ACTIVE/SUSPENDED → REVOKED. Revoked is terminal in B. A replacement submission against ACTIVE/SUSPENDED stays pending separately and cannot grant authority. Approval replaces the reviewed evidence; requesting changes leaves the current authorisation unchanged. Nullable licence dates are supported; absence of an expiry date is not proof that renewal conditions were reviewed. Platform approval explicitly confirms conditions and supplies the verified policy.

Database constraints protect Store identity, revision progression, classification uniqueness/immutability, purchaser binding and irreversible revoked/expired evidence. Delivery's restricted flag cannot change true → false. Audit/document/review rows reject direct updates/deletes. Existing isolated verifier parent-aggregate cleanup may cascade those rows; no public aggregate-deletion route is added. This is not an approved production retention/deletion policy. Domain transitions and their audit insert share one transaction; tests inject audit failure to require rollback.

### Classification and frozen truth

Every sellable product requires a platform review. Its identity fingerprint covers native product ID/title/description/images, variant ID/title/SKU and the merchant proposal flag. Price, inventory and publication status do not classify alcohol. A material identity change invalidates the review. New variants cannot inherit an old identity approval silently. Variants inherit the reviewed Product decision. A merchant NONE proposal is an audit request only; an ALCOHOL proposal raises the proposal flag and requires review.

The CheckoutAttempt snapshot contains exact product/variant classification revision IDs, restriction/class, Store registration revision, trading-policy version and purchaser evidence reference. Its existing immutable M10 snapshot/revision boundary protects these facts. Native Order completion retains the existing attempt-to-Order relationship. Dispatch consumes this frozen evidence, never today's merchant flag. Later catalogue downgrades or M13 omissions cannot erase a paid restricted requirement.

**Rollout:** there is no automatic NONE approval/backfill. Existing catalogue products must be explicitly reviewed. Historical attempts lacking the new evidence remain readable but cannot initiate payment or newly dispatch on inferred classification. They require a separately approved historical-evidence/recovery decision; do not rewrite paid snapshots or clear commitments. Reviewed groceries need neither a liquor registration nor purchaser verification. Cart reduction/removal remains available under existing M8 freeze rules so a customer can clear ineligible goods; additions/increases and all checkout/Pay paths revalidate purchase eligibility.

The broader A requirement to remediate discovery of previously misclassified, already-paid goods remains a C operational-policy gate. B does not invent a retroactive financial or custody-resolution workflow or claim software can identify physical misdescription. Platform reviewers remain trusted decision makers; a later correction is not retroactive proof of lawful sale.

### Time, purchaser and dispatch gates

Sale policy is versioned, source-attributed and explicitly `Africa/Johannesburg`. Regulatory, licence-specific and Store sale windows intersect. Start is inclusive, end exclusive; effective dates and permitted alcohol classes are enforced. GROCER_WINE does not admit spirits/beer. No scattered 08:00/20:00 checks or all-day production default is installed. `dispatch_windows` and `handoff_windows` are separate nullable concepts, not legal permission inferred from sale windows.

The purchaser provider interface returns VERIFIED, NOT_VERIFIED, EXPIRED or UNAVAILABLE. Production always uses UNAVAILABLE in B. A stored VERIFIED row, an environment flag, DOB, query parameter, merchant approval or customer checkbox cannot enable the missing provider. Injected fixture providers are rejected outside explicit development/test environments and are not reachable through routing. Verified fixture evidence requires both age 18 threshold and provincial requirements; the latter represents the learner-policy requirement, without inventing its remote proof method. Internal ingestion/revocation uses the customer operation lock; no public evidence setter exists.

Restricted dispatch always returns `RESTRICTED_DELIVERY_DOCUMENTATION_UNAVAILABLE` until an approved Free State documentation integration exists. Purchaser evidence never satisfies recipient compliance. No driver/recipient/return implementation was added.

### Checkout and concurrency

Cart add/increase/switch use the existing merchant commerce advisory lock across compliance evaluation and native mutation. Checkout prepare/confirm freezes current evidence under the same lock. Payment initiation rechecks it before HELD → PAYMENT_PENDING and ProviderOperation persistence, then again before native collection/session establishment can initiate Yoco. The existing customer cart lock serializes purchaser revocation; registration/classification writes share the merchant commerce lock and merchant row lock. Platform review uses expected revision/fingerprint. Database time is evaluated inside the protected operation, with sale-window boundary unit coverage. No process-local lock is authority.

Uncertain pre-existing provider operations retain M10 recovery semantics; an eligibility failure does not assert an unknown payment never happened, refund it, or generate another key. The native completion/reconciliation and M9 shipping-freshness rules remain unchanged.

### APIs and privacy

Implemented route families:

- `GET/POST /merchant/restricted-commerce`: own registration/read/submission.
- `POST /merchant/restricted-commerce/documents`; `GET /merchant/restricted-commerce/documents/:documentId`: private evidence, with signature/size/type validation and audited access.
- `GET/POST /merchant/restricted-commerce/products/:productId`: own reviewed classification/proposal.
- `GET/POST /admin/gospaza/restricted-commerce/stores/:id`: read/explicit review action.
- `GET/POST /admin/gospaza/restricted-commerce/stores/:id/products/:productId`: reviewed classification.
- `GET /admin/gospaza/restricted-commerce/stores/:id/documents/:documentId`: scoped review evidence.
- `GET /store/gospaza/purchaser-eligibility`: authenticated customer's bounded provider state; no caller-selected customer/evidence.

Strict schemas reject extra authority fields. Foreign evidence/product references return inaccessible outcomes before native reads. File responses are uncached attachments with nosniff/sandbox headers. No evidence keys, purchaser proof details, raw provider errors, ID/DOB/photos or document bytes enter customer DTOs or audit. Existing request logging excludes bodies/query strings. Registration files are limited to 10 MiB each, 20 per Store, with at most 10 referenced per submission. No UI was added.

### Security review and test additions

SOURCE merchant proposal → reviewed native identity → platform authority → cart/Pay: unreviewed/materially changed identities fail closed; merchant downgrade cannot publish NONE. SOURCE evidence ID → exact tenant lookup → membership/platform grant → private file/seller authority: foreign access and licence reuse are denied. SOURCE purchaser result → strict customer/method/policy/expiry validation → trusted adapter + stored evidence → Pay: default UNAVAILABLE and wrong/revoked evidence deny. SOURCE frozen checkout → M10 Order linkage → immutable evidence → dispatch/M16: no mutable catalogue downgrade.

Added backend unit policy tests, API-client payload/no-replay tests, and `test:restricted-commerce`, composing existing M10/M11 real-database setup. Coverage includes role/tenant rejection, evidence isolation, competing review revisions, immutable bindings/snapshots, stale catalogue identity, category denial, default purchaser unavailability, fixture-only successful restricted confirmation, wrong/revoked evidence, concurrent classification/confirmation and suspension/confirmation, pre-provider suspension denial, audit rollback and grocery independence. These are implemented assertions, **not executed proof**.

Existing cart fixtures now explicitly approve their isolated groceries. The M15 test that previously changed a paid grocery's merchant flag now proves its frozen grocery classification stays unchanged. M16's restricted OTP denial remains exercised using an explicit already-shipped synthetic safety fixture; it does not pretend a production restricted checkout/dispatch is approved. Earlier assertions unrelated to that obsolete mutable-classification assumption are retained.

### Files materially changed

- New domain: `apps/backend/src/lib/restricted-commerce.ts`, `restricted-http.ts`; `src/modules/marketplace/restricted-policy.ts`; models `restricted-registration.ts`, `restricted-evidence.ts`, `restriction-review.ts`, `restricted-event.ts`, `purchaser-eligibility.ts`; migration `Migration20261025120000.ts`.
- Integration: `apps/backend/src/modules/marketplace/service.ts`, `checkout-policy.ts`; `src/lib/cart-service.ts`, `checkout-service.ts`, `checkout-http.ts`, `payment-initiation-service.ts`, `payment-initiation-http.ts`, `dispatch-readiness.ts`, `dispatch-service.ts`; `src/api/middlewares.ts`; the eight `route.ts` files under the route families above.
- Contracts/client: `packages/contracts/src/restricted-commerce.ts`, `packages/contracts/src/index.ts`, `packages/api-client/src/restricted-commerce.ts`, `packages/api-client/src/index.ts`.
- Coverage: `apps/backend/tests/restricted-commerce.test.ts`, `src/scripts/verify-restricted-commerce.ts`, `src/scripts/fixtures/restricted-commerce.ts`, `verify-cart-foundation.ts`, `verify-dispatch.ts`, `verify-pickup.ts`, `verify-handoff.ts`; `packages/api-client/tests/restricted-commerce.test.ts`.
- Configuration/report: `apps/backend/package.json`, `apps/backend/.env.example`, this milestone contract.

### User verification order

All commands below run from repository root. Stop on every failure and return the innermost error. No lint/typecheck/build/test/migration has been run by Codex.

**A — no dev servers:** stop Next processes before type generation/build to avoid concurrent `.next` writes.

1. `pnpm run lint` — zero errors/warnings.
2. `pnpm run typecheck` — all workspaces typecheck.
3. `pnpm --filter @gospaza/backend run test` — existing and new unit/policy suites pass.
4. `pnpm --filter @gospaza/api-client run test` — existing and new client suites pass.
5. `pnpm --filter @gospaza/backend run build` — backend compiles successfully.

**B — PostgreSQL/Redis available, backend stopped for migration:**

6. `pnpm --filter @gospaza/backend run db:migrate` — applies the new compliance migration successfully. No database hand edits.

**C — backend only on its configured HTTP origin plus PostgreSQL/Redis:** start the backend with the existing local verification configuration (development/test, Yoco test configuration, workers disabled as required by the existing verifier contracts, and the existing handoff secret). No Next apps needed. Do not install live purchaser credentials or enable live payment as a test workaround.

7. `pnpm --filter @gospaza/backend run test:restricted-commerce` — M17-B success plus prerequisite verifier success.
8. `pnpm --filter @gospaza/backend run test:cart-mutations` — M8 mutation/freeze/isolation assertions retained.
9. `pnpm --filter @gospaza/backend run test:payment-initiation` — M10-D provider/session/idempotency regression passes.
10. `pnpm --filter @gospaza/backend run test:dispatch-orchestration` — M15 search/offer/readiness regression passes.
11. `pnpm --filter @gospaza/backend run test:dispatch-acceptance` — M15 acceptance/concurrency/security regression passes.
12. `pnpm --filter @gospaza/backend run test:handoff` — composed M10/M11/M15/M16 pickup/handoff regression passes, including restricted OTP denial. The composed verifiers retain their prerequisite assertions; no additional duplicate standalone runs are prescribed here.

No new M17 browser suite exists: B adds no UI. M17-D owns its browser acceptance work. A full browser run is not a substitute for these real-database gates.

### Remaining launch and next-slice gates

Restricted commerce remains unavailable in production. Outstanding approvals include remote purchaser/learner proof, Free State registration/renewal and Store-specific conditions, legal sale/dispatch/handoff applicability, exact delivery invoice requirements, retention/notices/processors, and the reviewed catalogue rollout/historical-order policy. There is no recipient verification, alternate adult, OTP satisfaction, physical return, refund, stock adjustment, earnings or UI in B.

After user verification, the foundations can support a separately approved C. C is **not automatically cleared to implement**: recipient/refusal/custody/return and misclassification-remediation policies from A still need explicit approval. No commit or next slice has been started.
