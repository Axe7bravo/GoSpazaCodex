# M23 — Operations

## 1. Status, authority and slice boundary

**M23 COMPLETE AND USER-VERIFIED — 2026-11-07 (Africa/Johannesburg).** M23-A through M23-D are approved and complete. The user confirmed every final D verification command passed: lint, workspace typecheck, focused backend acceptance tests, admin operations tests, backend/admin builds, targeted C rescue regression, fixture generation, direct API acceptance and exactly three Playwright journeys. Codex did not execute verification. See [B implementation record](M23_B_IMPLEMENTATION.md), [C implementation and verification record](M23_C_IMPLEMENTATION.md), and [D acceptance/security record and unchanged commands](M23_D_ACCEPTANCE.md). The approved [architecture audit](M23_OPERATIONS_ARCHITECTURE_AUDIT.md) and scope decisions below remain authoritative. Branch inspected: `milestone/m23-operations`.

This contract supersedes the audit's recommendation to defer rescue and its alternative slice proposals. M23 includes exactly one narrowly controlled Delivery/Dispatch-owned rescue, implemented in C, with the four A/B/C/D slices in section 24. D is authorized solely for final acceptance, security review, diagnostic cleanup and closure; no additional operations behavior is authorized.

Only this document changed in A. B adds capability enforcement and read-only projections, contracts, clients and verification infrastructure. No B schema migration is required. Verification commands and commits have not been executed by Codex. Later slices need explicit authorization and user-run verification.

## 2. Purpose, ownership and exclusions

M23 provides bounded operational visibility, narrower platform authorization, navigation into existing domain tools, and the approved Delivery rescue. It is not a second exception system, generic admin mutation/repair layer, CRM, ticketing or workflow engine.

Medusa 2.18 remains owner of native Order/Customer/User/Auth/Payment/Fulfillment/Inventory/Store Credit. Existing GoSpaza owners remain authoritative for Marketplace identity/tenancy, order operations, scheduling, picking/substitution, Delivery/Dispatch/custody/compliance and each finance domain. M23 projects, composes, links or invokes an explicitly approved owner primitive. It must not impersonate a customer/merchant/driver or read native commerce tables directly to bypass module contracts.

Every adapter, timeline source and action must name its owner. Unclear mutation ownership means no implementation. No rewritten financial/delivery history, generic status edits, new economic source or duplicated balance/exception/audit authority.

No persistent operational work-item model, acknowledgement, assignment, investigating/closed/resolved workflow, SLA or unrestricted notes. Existing bounded domain action reasons remain domain-owned; they do not authorize a general notes field. Attention ceases to be current only when the owning domain's eligibility predicate changes; source history remains.

## 3. Pure diagnostic-read invariant

All new M23 GET/diagnostic/detail/lookup/timeline/health reads are side-effect free:

```text
authorize current actor and section
→ bounded read of persisted truth / native read contract
→ allowlisted diagnostic projection
→ no domain write, audit write, provisioning, repair or workflow advance
```

They do not publish events, dispatch provider calls, issue native writes, restore credit, create a missing OrderOperation/document/snapshot, expire an offer, advance a worker cursor, update last-viewed/read state or create an exception. Authentication/session infrastructure does not authorize domain writes.

Concrete prohibited shortcuts, confirmed by source inspection:

- `FinancialService.adminOrder` calls `ensureLocked` and can materialize adjustments.
- `CommissionService.preparePlatformRead` can call `ensure` for a missing snapshot.
- `DispatchService.current/reconcile`, `PickupService.presentation/observe` and `HandoffService.read/observe` can mutate authoritative state.
- `dispatchReadiness` invokes `RestrictedDeliveryDocument.ensure` for restricted orders, which may insert a document and restricted audit event. Its name does not make it a diagnostic read.
- Domain helpers named repair/ensure/provision/observe and direct job/route-handler invocation are not accepted read ports.

B adds explicit owner diagnostic contracts where existing projections are not pure. Shared pure validation may be extracted from its current owner when needed, preserving earlier command behavior. Do not copy policy into an operations adapter or component. Missing state is reported as absent/unproven, not repaired. SQL reads should avoid business row/advisory locks and unrelated transactions; bounded native read calls remain allowed. A diagnostic action hint is never admission authority.

GET purity must be executable: capture relevant persisted domain/event/cursor counts and fingerprints before/after reads, including missing-state/attention/error cases; assert no events/workflows/provider/native mutations. Use read-only DB transactions where applicable, but also detect cross-connection/native writes rather than assuming one connection's READ ONLY setting proves everything. No read creates rescue journal/audit/work rows.

## 4. Capability matrix and current grants

Native platform authentication plus current explicit server-owned grants is the boundary. New grants follow the existing exact-user allowlist convention, default deny, with no automatic grant to existing Users and no mutable client/JWT permission authority. No generic OPERATIONS_MANAGE or super-admin grant. New names are frozen here; B implements them.

| Capability / server binding | Permitted use | Does not grant |
|---|---|---|
| ORDER_OPERATIONS_VIEW / `ORDER_OPERATIONS_VIEW_USER_IDS` | Safe Order/checkout/merchant-decision/picking diagnostics and operational merchant/store references | Delivery detail, rescue, finance, customer PII search or documents |
| DELIVERY_OPERATIONS_VIEW / `DELIVERY_OPERATIONS_VIEW_USER_IDS` | Safe delivery/commitment/pickup/completion/return and linked driver operational context | Rescue, private compliance, GPS/OTP or driver finance |
| DELIVERY_RESCUE / `DELIVERY_RESCUE_USER_IDS` | Dedicated rescue command; DELIVERY_OPERATIONS_VIEW is an explicit additional prerequisite | General delivery edits, chosen driver, capacity release or other mutations |
| MERCHANT_REVIEW_VIEW / `MERCHANT_REVIEW_VIEW_USER_IDS` | Existing submitted application/detail/history and review backlog | Private bytes, provisioning/decisions or finance |
| MERCHANT_REVIEW_MANAGE / `MERCHANT_REVIEW_MANAGE_USER_IDS` | Existing start-review/request-information/reject/approve-provision commands, with explicit REVIEW_VIEW prerequisite | Document bytes or unrelated merchant management |
| MERCHANT_DOCUMENT_VIEW / `MERCHANT_DOCUMENT_VIEW_USER_IDS` | Existing application document access, with explicit MERCHANT_REVIEW_VIEW prerequisite | Any review decision or broad document URL/key exposure |
| DRIVER_REVIEW_VIEW / `DRIVER_REVIEW_VIEW_USER_IDS` | Existing driver review/detail/lifecycle/affiliation read and backlog | Lifecycle changes, raw location or finance |
| DRIVER_REVIEW_MANAGE / `DRIVER_REVIEW_MANAGE_USER_IDS` | Existing platform lifecycle/affiliation decisions, with explicit DRIVER_REVIEW_VIEW prerequisite | Rescue, assignment, driver earnings/payment or merchant membership mutation |
| SERVICE_CONFIGURATION_VIEW / `SERVICE_CONFIGURATION_VIEW_USER_IDS` | Existing zones/store assignments, scheduling and dispatch-mode read | Changes to configuration or finance |
| SERVICE_CONFIGURATION_MANAGE / `SERVICE_CONFIGURATION_MANAGE_USER_IDS` | Existing zone/fee/assignment/scheduling/synchronization/dispatch-mode writes, with explicit CONFIGURATION_VIEW prerequisite | Rescue, arbitrary settings or other domain mutations |

Requiring both a listed view and manage/action grant is a conjunction, not implicit inheritance. Empty grants deny. A native User with only financial or notification grants has none of the new permissions. Merchant/customer/driver actors cannot use platform grants by supplying a known User ID.

Retain existing grants and their established action combinations unchanged:

| Domain | Existing authority retained |
|---|---|
| M17 compliance review/documents | `RESTRICTED_COMMERCE_REVIEWER_IDS`, current native User and existing secure evidence path. No new recipient-compliance override |
| M18 adjustments/refunds/credit | `FINANCIAL_{VIEW,VIEW_DISPOSITION,APPROVE,GOODWILL_CREATE,EXECUTE_REFUND,ISSUE_STORE_CREDIT}_USER_IDS` |
| M19 commission | `COMMISSION_CONFIGURE_USER_IDS`; financial VIEW remains required for Order financial economics |
| M20 settlements | `SETTLEMENT_{VIEW,PREPARE,APPROVE,PAYOUT_RECORD,RECONCILE}_USER_IDS`; existing evidence/discrepancy/retry combinations |
| M21 driver compensation/finance | `DRIVER_COMPENSATION_MANAGE_USER_IDS`, `DRIVER_EARNINGS_VIEW_USER_IDS`, `DRIVER_PAYMENT_RECORD_USER_IDS`, `DRIVER_PAYMENT_RECONCILE_USER_IDS` |
| M22 notification ops | `NOTIFICATION_OPERATIONS_VIEW_USER_IDS`; audience membership does not imply operations/domain authority |

Do not change previous financial command prerequisites merely to make the new matrix uniform. Existing owner APIs remain independently usable with their own grants; an operations overview grant is not a new prerequisite for those APIs.

## 5. Exact legacy hardening inventory

All paths in this table are under `/admin/gospaza`. Harden both HTTP and the authoritative platform-service/workflow entry boundary. Keep applicant/merchant/driver self-service paths on their existing identity/tenancy rules. No broad rewrite of M18–M22 auth.

| Existing route and method | Required new grants |
|---|---|
| GET `/merchant-applications` | MERCHANT_REVIEW_VIEW |
| GET `/merchant-applications/[id]`, `/merchant-applications/[id]/review-history` | MERCHANT_REVIEW_VIEW |
| GET `/merchant-applications/[id]/documents/[documentId]/access` | MERCHANT_REVIEW_VIEW + MERCHANT_DOCUMENT_VIEW |
| POST `/merchant-applications/[id]/{start-review,request-information,reject,approve}` | MERCHANT_REVIEW_VIEW + MERCHANT_REVIEW_MANAGE |
| GET `/drivers`, `/drivers/[id]` | DRIVER_REVIEW_VIEW |
| POST `/drivers/[id]/{approve,require-changes,suspend,reactivate,deactivate}` | DRIVER_REVIEW_VIEW + DRIVER_REVIEW_MANAGE |
| POST `/drivers/[id]/affiliations/[affiliationId]/{activate,decline,revoke}` | DRIVER_REVIEW_VIEW + DRIVER_REVIEW_MANAGE |
| GET `/service-zones`, `/service-zones/[id]` | SERVICE_CONFIGURATION_VIEW |
| POST `/service-zones`; PATCH `/service-zones/[id]` | SERVICE_CONFIGURATION_VIEW + SERVICE_CONFIGURATION_MANAGE |
| POST `/service-zones/[id]/stores`; DELETE `/service-zones/[id]/stores/[storeId]` | SERVICE_CONFIGURATION_VIEW + SERVICE_CONFIGURATION_MANAGE |
| GET `/scheduling/[storeId]`, `/scheduling/[storeId]/slots` | SERVICE_CONFIGURATION_VIEW |
| PUT `/scheduling/[storeId]/policy`; PUT `/scheduling/[storeId]/assignments/[assignmentId]` | SERVICE_CONFIGURATION_VIEW + SERVICE_CONFIGURATION_MANAGE |
| POST `/scheduling/[storeId]/slots`; PUT `/scheduling/[storeId]/slots/[slotId]`; POST `/scheduling/[storeId]/synchronize` | SERVICE_CONFIGURATION_VIEW + SERVICE_CONFIGURATION_MANAGE |
| GET `/stores/[id]/dispatch-configuration` | SERVICE_CONFIGURATION_VIEW |
| PUT `/stores/[id]/dispatch-configuration` | SERVICE_CONFIGURATION_VIEW + SERVICE_CONFIGURATION_MANAGE |

B must check exact exported methods against source before editing, preserving URL/method/DTO behavior other than narrowed authorization. This finite list is the scope; not a new generic native Admin permission framework. Merchant detail documents remain inaccessible without the byte-access grant; operations projections must not include their storage keys/URLs. Review-only lists may retain existing bounded document summary on the actual review page, not copy it to operations.

Current native User identity must be verified by the owning boundary, including direct workflow calls. Internal trusted automation/fixtures must use explicit legitimate authority contracts, not APP_ENV/test grant bypasses. Update only affected actor fixtures to grant their intended actions explicitly; no default allow-all for tests.

## 6. Same-session revocation and MFA

Every protected request rechecks current native identity and applicable server grants. Current grants are not snapshotted into JWTs/browser storage or cached as positive authority. After effective revocation, the same authenticated session loses that capability on its next request. Existing environment allowlists require configuration to become effective in the serving process (including a controlled restart); changing an external shell alone does not update a running process. Acceptance must preserve the cookie across that change and distinguish identity loss from one grant's loss.

For mutations, recheck inside the established owner serialization boundary before mutation admission. UI action hints do not authorize commands. Revoked sections are cleared on refresh/denial; no silent fallback to a privileged cached payload. Preserve unrelated granted sections and established native session rules.

**MFA is excluded from M23.** Native platform authentication plus explicit capabilities is the approved M23 boundary. Stronger MFA/governance is platform/security hardening, not a blocking new auth system. Independently unrestricted native Admin/API credentials must remain operationally restricted; custom M23 grants are not claimed to constrain a separate native superuser credential.

## 7. Overview, attention sources and vocabulary

The overview is an attention-first collection of bounded owner projections. Current sources are:

| Source lane / owner | Qualifying authoritative condition | Read grant |
|---|---|---|
| Order attention / Order Operations | Proven checkout handoff awaiting merchant action or absent/unproven linked operational materialization; no guessed Order completion | ORDER_OPERATIONS_VIEW |
| Delivery attention / Delivery | ATTENTION_REQUIRED, pickup/completion recovery or delayed/deferred work indicators justified by existing durable state | DELIVERY_OPERATIONS_VIEW |
| Refund/credit/recovery / payment + M18 Finance | Persisted checkout completion/provider uncertainty; adjustment review, refund/credit nonterminal/failed/attention, omission/restoration/disposition attention where authorized | FINANCIAL_VIEW; disposition additionally VIEW_DISPOSITION |
| Merchant settlements / M20 | Existing holds/FAILED/payable OPEN discrepancies and actual reconciliation obligations | SETTLEMENT_VIEW; private evidence retains action grants |
| Driver-payment attention / M21 | Existing unknown/reserved outcomes, discrepancies and required reconciliation; safe summaries only | DRIVER_EARNINGS_VIEW; restricted evidence/consistency detail keeps existing RECORD/RECONCILE requirement |
| Finance recognition / M19 | Existing unresolved snapshot/posting exceptions | FINANCIAL_VIEW |
| Driver recognition/compensation / M21 | Existing recognition/assignment exceptions and historical review, distinguished from payable earnings | DRIVER_EARNINGS_VIEW; compensation-only diagnostics may also use the owner's existing manage read policy |
| Notification attention / M22 | Existing failed/uncertain/retrying/suppressed states, rendered with their distinct semantics | NOTIFICATION_OPERATIONS_VIEW |
| Merchant review / Marketplace | Existing submitted/under-review/information-required review backlog | MERCHANT_REVIEW_VIEW |
| Driver review / Driver | Existing PENDING_REVIEW/CHANGES_REQUIRED states | DRIVER_REVIEW_VIEW |
| Restricted review / Compliance | Existing registration/classification review and blocked/stale authorization | Existing restricted reviewer grant |

Sub-lanes remain independently authorized/bounded, not fetched through a broad finance/operations super-role. Ordinary pending, suppression, rejection, return, omission or historical state is not automatically a malfunction. Preserve the safe source status/reason. Do not count HTTP 409 admission/mutation conflicts as durable incidents.

Common presentation labels are Needs attention, Under review, Retrying, Failed, Blocked, Unresolved and Historical review. Failed requires known failure; UNKNOWN/AMBIGUOUS cannot be renamed failed. Retrying requires an actual owner-scheduled eligible retry. Historical review does not create payable liability. Notification provider acceptance is not customer receipt; custody return is not refund. No common editable status, severity or generic RESOLVED transition.

## 8. Federation, DTOs and boundedness

The queue is derived/federated; no operations_work_item table or copied exception truth. Per-source adapters expose only their own approved diagnostic contract. Cross-domain composition invokes those contracts; no giant cross-domain transactional SQL join, controller invocation or raw ORM serialization.

Freeze the safe attention item fields: `domain`, `record_type`, `record_id`, `reference`, `category`, `status`, `reason_code` (nullable allowlisted category), `created_at` (nullable if absent), `economic_at` (nullable and only where relevant/authorized), bounded `summary`, `link` (nullable trusted internal destination). Response metadata: `observed_at`, `items`, per-source `next_cursor`, `has_more`, `truncated` and bounded count/sample metadata where provided. Identity is domain + record type + stable source ID, not Order ID alone.

Separate source pages/cursors. A unified UI may merge only bounded samples and must not claim a global ordering, total, transaction snapshot or exhaustive source coverage. No shared global cursor or full-table global scan. Source history is separate from current attention; an append-only exception is not deleted to remove a current row.

New pages default20/max25 items; fetch at most one extra sentinel. Preserve lower existing owner limits. Timeline uses the same per-source cap. Overview summaries use at most5 items per authorized source. Fan-out concurrency at most4 owner calls, no transaction/lock held across unrelated calls. No native detail hydration for every queue row; enrich only bounded references needed for the projection.

Optional counts read at most1,001 qualifying source rows: expose exact count up to1,000 and a truncation/lower-bound indicator beyond that, not a fictional exact total. Existing M22 health retains its own24h/10,000 sample and metadata; do not relabel it as a lifetime queue total. Do not hide old unresolved obligations behind an arbitrary recent-time filter. Indexed first-row oldest-pending observation may be used; no historical BI/counts per page load.

Authorize before selecting/counting domain data. Unavailable is not empty/zero. Return independent section availability, and omit ungranted sections/data/counts; a requested forbidden category gives bounded403 without fetching it. An authorized failed source yields an unavailable result without raw dependency errors, while other sections remain usable. No all-or-nothing fan-out failure. Existing resource-specific not-found semantics remain non-disclosing. Responses private/no-store; no shared protected-data cache.

## 9. Typed exact-ID lookup and API shape

Lookup takes one finite `type` and one validated exact `id`; no fuzzy text, customer email/phone, provider reference, bank evidence, recipient or cross-type discovery. It delegates to the type's owner **after** current capability checks. It returns a safe diagnostic reference/contextual link, not a universal joined record. Knowing an ID grants nothing.

| Allowed type | Minimum authority / target |
|---|---|
| order | ORDER_OPERATIONS_VIEW → operational Order detail; delivery/finance sections independently gated |
| delivery | DELIVERY_OPERATIONS_VIEW → Delivery detail |
| merchant | ORDER_OPERATIONS_VIEW → safe merchant/store operational reference and scoped Order navigation, or MERCHANT_REVIEW_VIEW → authorized review context; no automatic document/financial data |
| driver | DRIVER_REVIEW_VIEW → existing review detail; a driver linked inside authorized Delivery detail may have a safe operational reference under DELIVERY_OPERATIONS_VIEW, not a standalone private profile |
| financial_adjustment | FINANCIAL_VIEW → existing adjustment console with safe exact record/Order locator, using a pure read |
| merchant_settlement | SETTLEMENT_VIEW → existing statement detail; resolve payable/statement identity through M20, not a browser guess |
| driver_payment | DRIVER_EARNINGS_VIEW → existing safe payment detail; no evidence fields from lookup |
| notification | NOTIFICATION_OPERATIONS_VIEW → safe operations locator/status only; never actor message title/body/destination or shared inbox detail |

Checkout recovery with no completed Order appears in the separately authorized Finance recovery lane/context; do not fabricate an Order result or silently interpret a checkout ID as an Order ID. No general Customer search type. If a record has no valid existing/new approved destination, return its bounded reference without inventing a link.

Planned M23-only route family: `/admin/gospaza/operations` overview/capability-safe metadata, `/operations/attention/[source]`, `/operations/lookup`, `/operations/orders/[id]`, `/operations/deliveries/[id]`, contextual `/timeline` on those details, and bounded `/operations/health`. All GETs obey section3. Exact DTO/transport naming may be mechanically aligned during B, without new data, authority or query semantics. Existing owner APIs/routes remain unchanged except section5 hardening.

The single new business command is C's `POST /admin/gospaza/operations/deliveries/[id]/rescue`, delegated to Delivery/Dispatch. B must not expose a placeholder successful/no-op rescue endpoint. A capability-safe action hint is permitted, not a mutating admission call.

## 10. Order diagnostic projection

Owner: Order Operations composes pure owner contracts. Base requires ORDER_OPERATIONS_VIEW. Fields are explicit safe native Order reference/commercial status/currency, merchant/store ID and safe name, proven M10 completion/OrderOperation presence/state/revision, merchant decision status/time, and M12/M13 picking session state/progress/omission indicators from persisted evidence. No source creation when any part is missing. Native Order existence alone is not successful GoSpaza checkout or fulfillment.

Linked sections require independent authority: delivery/dispatch/return details require DELIVERY_OPERATIONS_VIEW; bounded refund/credit/funding/recognition requires FINANCIAL_VIEW; disposition additionally VIEW_DISPOSITION; settlement/driver finance/notification/verification use their own grants. Without these, no section counts, hidden identifiers, reasons or evidence are fetched/returned. An ordinary base Order reference does not reveal restricted financial attention through a generic badge.

Do not include customer email/phone/address, OTP/hash, recipient assessment, native payment/provider IDs, balance/account internals, raw financial evidence, actor metadata, private documents or workflow input/output blobs. Use existing exact money representation/formatter, never client-side entitlement calculations. UI source labels explain absent/unavailable context without resolving it.

## 11. Delivery, merchant and driver diagnostics

Owner: Delivery/Dispatch; base DELIVERY_OPERATIONS_VIEW. Safe fields: Delivery/Order/merchant/store references, existing delivery status/revision/generation/mode/path, safe attention reason, commitment state/current generation and driver-profile reference, dispatch_not_before/search/offer timestamps, pickup/completion operation state, handoff phase, return custody phase and terminal times. Safe driver display name/reference and persisted ONLINE/OFFLINE/status/affiliation classification may be projected only where operationally linked and necessary; no contact or location sample. Absence of a valid current sample must not be called live availability.

No OTP/plaintext/hash/nonce, recipient ID/age observations/rejection details, compliance payloads, raw GPS, customer private contact/address, private invoice/document bytes, native workflow receipt blobs or driver financial data. Financial and restricted review details are separate existing tools/grants.

Merchant context is a minimal operational store/name/status/reference plus authorized contextual links to review, Orders, commission and settlements; no new merchant suspension/status mutation. Driver lifecycle/affiliation/operational status uses its owner, not a forced online/assignment control. Financial data remains independent. Document bytes stay behind the exact existing secure review access path and explicit review/document authority; operations never returns storage keys, signed/private URLs or unrestricted document metadata.

## 12. Rescue source inspection and narrow eligible population

This section freezes the approved rescue, not an implementation. Real source evidence:

- `dispatch-rows.ts`, models and M15 migration define Delivery statuses PENDING_DISPATCH, SEARCHING, OFFERED, ASSIGNED, ATTENTION_REQUIRED, DELIVERED and (M17) RETURNED_TO_STORE. Commitment statuses are OFFERED, ASSIGNED, DECLINED, EXPIRED, CANCELLED, COMPLETED, RETURNED.
- M15 `Migration20261019000000` bounds Delivery generation to0/1 and its guard makes search-generation fields immutable and attention non-restartable. The later `Migration20261020000000` defines `delivery_generation_state`: generation0 permits PENDING_DISPATCH or ATTENTION_REQUIRED; generation1 permits non-PENDING_DISPATCH states. M16/M17 extend terminal/custody protection, not rescue. Generation0 attention is real, but deliberately outside this narrow previously-started-search rescue.
- `DispatchService.start` starts only PENDING_DISPATCH and hardcodes generation1; `enabled` denies ATTENTION_REQUIRED; `advance/reconcile` do not restart it. **Rescue cannot be implemented by setting PENDING_DISPATCH or blindly calling start.**
- `dispatch_commitment` has unique active driver and Delivery indexes for OFFERED/ASSIGNED and per-Delivery/generation/driver uniqueness. These must remain enforced for all generations.
- M16 begins irreversible native PREPARE/SHIP designation with pickup_operation and pickup_managed; M17 custody and completion can retain occupied assignment under attention. No assignment release is available to rescue.

Approve only an **existing, previously started, never-assigned, pre-fulfillment stranded search**. All admission conditions must hold under the owner locks at commit:

1. Delivery status exactly ATTENTION_REQUIRED, generation at least1, valid linked OrderOperation/pick session/reservation/store/zone and valid search history. No deleted/superseded/conflicting binding. Never create a missing Delivery/OrderOperation as part of rescue.
2. Source `delivery_operation.reason` is exactly one of `POOL_EXHAUSTED`, `SEARCH_ENDED`, `SEARCH_UNAVAILABLE`. These are current M15 search outcomes; no generic reason allow-all. Other attention, including ASSIGNMENT_REVIEW, PICKUP_* or COMPLIANCE_RECOVERY_REQUIRED, is ineligible.
3. No commitment in OFFERED or ASSIGNED, **even if its wall-clock expiry has passed**. Rescue does not expire/cancel/repair a commitment first. Existing worker/domain must close it authoritatively.
4. No prior assignment/custody: every historical commitment must be DECLINED, EXPIRED or CANCELLED with `assigned_at` null and valid immutable closure evidence. Any assigned_at, COMPLETED, RETURNED, contradictory/missing history or compensation assignment snapshot makes rescue ineligible. Do not treat absence of an active row as proof of no prior custody.
5. `pickup_managed=false`; `native_fulfillment_id`, `picked_up_at`, `arrived_at`, `delivered_at`, `tracking_generation` null; handoff_failures0. No pickup_operation (including PREPARE), delivery_completion, handoff_generation, recipient_compliance or restricted_return for this Delivery. No uncertain native operation is retried or cancelled by rescue.
6. Native authoritative readback proves no linked fulfillment/shipment/delivery and no contradictory commercial cancellation/physical evidence. A missing/unavailable/ambiguous readback is denial/unavailable, not permission. DELIVERED/RETURNED_TO_STORE, any return phase, valid assignment or capacity conflict always denies.
7. Current normal dispatch prerequisites are valid: native/M10 handoff and paid commercial state; accepted merchant decision; completed accounted physical picking with deliverable goods; committed reservation and correct store/zone/shipping link; active store/serviceability; enabled current dispatch configuration; fresh database scheduling time at/after authoritative slot start minus existing lead (30 minutes by established policy); immutable restricted snapshot and applicable existing M17 supply/document gates. No doorstep recipient compliance prerequisite is introduced before ARRIVED.
8. Preserve immutable restricted truth; rescue cannot change a restricted order into unrestricted, invent an invoice/approval, reclassify products, waive a missing registration or replace existing physical evidence. For restricted candidates require existing valid retained document evidence; missing evidence stays blocked for its owner to establish, not created from diagnostic/rescue convenience.

Generation0/PENDING_DISPATCH, normal SEARCHING/OFFERED/ASSIGNED and all other attention populations are outside this narrow command. It intentionally does not rescue in-transit, assigned-driver invalidation, fulfillment uncertainty, failed restricted handoff or returned goods. This meets the approved controlled rescue obligation for one safe population; it is not general rescue coverage.

## 13. Rescue success and normal dispatch

Single atomic owner transition: ATTENTION_REQUIRED → SEARCHING; revision increments once; generation increments exactly once from g to g+1 with no reset/reuse. Current configuration supplies mode/revision; initial path follows the same owner rule (MERCHANT for MERCHANT_ONLY/HYBRID; PLATFORM for PLATFORM_ONLY; DISABLED rejected). Fresh DB time and existing search/offer/merchant-phase policy set the new generation's timing; no extension of a still-active generation.

Preserve Delivery/Order/store/zone/reservation/pick identity, old generation history and all commitment rows. Clear the current search attention reason only with the successful audited transition; keep prior reason in its immutable audit/receipt. Freeze the new generation's configuration/time/path fields under the same protection as the old generation. HYBRID merchant-first fallback, candidate selection, one-active capacity, affiliation, current location/eligibility, offers and acceptance races remain normal M15 policy. Candidate may be offered again only in a new generation through normal policy; no operator-selected driver or commitment creation in rescue.

Rescue atomically makes the existing dispatch_work obligation due for the new observed revision, resets only that search work's generation-relative scan offset/error and records the source transition. This is not a generic cursor/worker control. No synchronous candidate scan/offer, external event chain or process-local queue is required for correctness; worker outage leaves durable SEARCHING work, not a successful assignment. Response says search reopened, not driver assigned/delivery rescued successfully. Any downstream acceleration occurs only after commit and is optional.

No driver availability/capacity/affiliation row, compensation term/snapshot, payment, financial settlement, native fulfillment, recipient evidence or inventory mutation occurs. Future actual offer acceptance still invokes M21 compensation selection; rescue does not freeze an earning/payable amount or bypass missing-terms rejection.

## 14. Rescue command, replay, audit and rollback

Authenticated current User must hold DELIVERY_OPERATIONS_VIEW **and** DELIVERY_RESCUE. Recheck native identity/grants at mutation admission. Freeze strict input: `request_id` using existing resource-ID validation, `expected_revision`, `expected_generation`, `expected_status` literal ATTENTION_REQUIRED, `reason_code` literal `RETRY_DISPATCH_SEARCH`, and `confirmed=true`. Positive safe bounded revisions/generations; overflow rejects. No driver_id, merchant_id, status destination, amount, timing, mode, capacity, document or arbitrary patch fields. No free-form note/reason text is required; structured code is sufficient for this single action.

Idempotency is durable and Delivery-owned. Use a minimum command/receipt journal (logical name `delivery_rescue_command`) linked to existing dispatch_event and exact Delivery. This is not an operations work-item or duplicate audit store. Freeze request ID, actor, target, canonical input fingerprint, prior status/revision/generation/reason, resulting status/revision/generation/configuration identity, dispatch-work identity and database recorded_at. No sensitive evidence payload. Original search identity is retained by existing events plus this exact source-linked receipt.

- Exact authorized replay returns the **original committed receipt**, even if normal dispatch has advanced, without reopening or offering again. Current grants still apply; revocation denies replay access.
- Same request ID with changed target/actor/input conflicts. Request identity cannot be reused to probe another actor's receipt.
- Different concurrent request IDs against the same prior revision/generation yield at most one transition; loser conflicts. Enforce source-transition uniqueness and expected revision in the DB, not only service checks.
- A stale expected state/revision/generation conflicts. No silent retry, implicit cancellation, timeout inflation or process mutex.
- Denied attempts do not create command rows/domain audit/repairs. Ordinary bounded request/security logging may record a safe denial category without secrets.

Append a Delivery `dispatch_event` with actor_type user, authenticated actor, structured rescue action/reason, request identity and prior/result revisions/generations/configuration. Reuse its append-only authority. Database deferred consistency must bind command receipt, audit, generation transition and due work atomically, preserving all existing commitment/capacity/native/return constraints. Failed/rolled-back audit/receipt/work/transition leaves original Delivery and work state, no orphan generation, no capacity change and no partial commitment mutation. No unsafe compensation after an ambiguous commit: recover by exact command receipt, never a second rescue.

## 15. C implementation obligations: generation guards and concurrency

No schema work in A. C needs a **forward corrective/extension migration** for domain command evidence and existing M15 generation/guard assumptions. Do not edit already-applied migrations as the repair or disable constraints.

Replace hardcoded0/1/old.generation=1 assumptions with monotonic generation semantics:0 retains its existing unstarted PENDING_DISPATCH/ATTENTION_REQUIRED meanings; started states use positive generation; within each generation the existing frozen fields/path progression remain protected. Permit ATTENTION_REQUIRED → SEARCHING and generation+1 only for the one proven command/evidence population above. Keep all other attention/terminal and assigned/custody transitions unchanged. DB triggers/constraints must reject naked SQL status/generation updates lacking matching authoritative command/audit/work evidence; an unprotected session flag is insufficient. Old commitment identity/revision and active uniqueness must remain unchanged. Historical commitments are not updated just to bind to the new current generation.

Rescue must serialize with the real orchestrator, offer/accept/expiry/configuration/pickup paths. Existing `DispatchOrchestrator.runBatch` holds dispatch_work before entering merchant/Delivery owner locks. C must coordinate using that **work fence first**, then merchant → OrderOperation → picking session → Delivery, and stable commitment/history reads, without taking driver/profile/availability locks or inventing a reverse lock order. If work must be created, establish/lock it transactionally before merchant locks and roll it back on denial. Owner tests must prove no cycle with existing ensure/discovery paths; do not acquire dispatch_work late while holding merchant/Delivery locks. Never hold the work/merchant transaction during provider/native workflow mutations; required native reads may fail closed.

Normal worker results must not overwrite a newly rescued generation with stale observed_revision/scan state. Preserve the work row fence and validate current generation/revision on every relevant normal dispatch path. Initial `start()` still owns generation1 for genuinely unstarted work; repeated rescue uses g+1, not a renamed start. No new budget/timing policy.

Real DB acceptance must race rescue/rescue (same and different request IDs), rescue versus stale offer/accept/worker observation/configuration, replay after worker advancement, and opposing transition/rollback boundaries. Ineligible active/assigned/pickup/returned/uncertain cases must reject without economic/custody/availability mutation. New normal-generation search must retain MERCHANT_ONLY/PLATFORM_ONLY/HYBRID behavior and offer/accept uniqueness. Failures may conflict or return bounded unavailable; neither permits duplicate work/assignment or hidden side effects.

## 16. Existing mutations and prohibited overrides

Existing verification decisions, commission publication, M18 adjustment/refund/credit commands, settlement preparation/approval/actual transfer recording/reconciliation, driver terms/payment commands and private evidence remain on existing domain consoles with original grants, inputs, concurrency and audit. M23 links; it does not rebuild them. M22 operations has **no** resend/manage mutation to expose.

Prohibit new force deliver/complete/pickup, manual driver assignment, direct capacity release, commitment deletion/history rewrite, unrestricted attention restart, force refund/credit, mark settlement/driver payment paid without existing owner evidence, discrepancy/exception deletion or generic resolution, arbitrary restock, provider evidence edits, notification recipient/body/shared rendered-message access, retry budget resets, worker start/stop/toggle/cursor resets, generic activation and arbitrary settings mutation. Approved rescue is the sole narrow exception to non-restartable search attention, not a general terminal override.

Finance is read/attention/navigation only in M23. No new adjudication, dual-method/split entitlement, balance engine, source allocation or post-delivery shortage source. Physical return is not financial completion. Historical financial/earning/paid settlement records remain append-oriented and governed by their domains.

## 17. Contextual timeline

Approve read-only Order/Delivery timelines as independent bounded source pages: timestamp, source domain/type + event ID, safe event/status label, authorized actor reference/category where necessary, bounded summary and authorized contextual link. Preserve occurred_at versus recorded_at semantics where available; deterministic tie-break, no invented global causal order or complete-history promise.

Sources include owner adapters over order_decision_event, pick_event, dispatch_event (also M16 handoff/rescue events), restricted_event (sanitized M17 custody only), plus authorized financial/recognition/settlement/driver-payment/notification and review histories where actual linkage is proven. No invented handoff_event/recipient_event tables, copied audit store, raw JSON dump or generic audit editing.

Each source checks its own grants before query; operational access does not inherit recipient observations, document evidence, bank/provider data or private action text. Free-form historical reasons must not be blindly copied; use allowlisted labels/bounded safe summaries. Unproven cross-domain relation is omitted/unavailable, never guessed by equal amounts/names/nearby timestamps. Pagination identity includes source domain/event ID, avoiding duplicate React keys from Order-only keys.

## 18. Worker health and configuration

Reuse M22's persisted notification health under NOTIFICATION_OPERATIONS_VIEW, preserving enabled state, last successful cycle, safe failure category, sample window/truncation and provider-acceptance semantics. No live email is required for acceptance.

For other existing jobs, show only actual configuration and bounded domain work signals under the corresponding owner grant: pending/due count/sample, oldest pending age, last recorded work observation and `Not instrumented`/`Unknown` for execution health. An enabled flag/cursor/pending row/liveness probe is not proof of a successful worker cycle. Dependency `/health/ready` remains Postgres/Redis readiness, not provider/scheduler success. No new heartbeat/monitoring schema is required in M23; do not invent last-success data or expose secrets/credential fingerprints.

No UI worker controls, cursor reset, retry-budget reset or deployment environment editor. Existing owner publication/configuration/activation rules remain authoritative: effective-dated commission, prospective M20 settlement policy, M21 terms/activation, M22 single prospective notification activation. Inspect/link safe state only; no generic activation API, defaults/rates/backfill or generic key/value settings.

## 19. Privacy composition and security acceptance

SOURCE → owner validation/projection → current actor/resource/capability boundary → safe DTO/React text sink applies to every section. Frontend hiding is not authorization. No unauthorized query/count/event fetch followed by client filtering.

Mandatory tests:

- Native ordinary User denied new Order/Delivery views/rescue and every included legacy review/configuration action; existing finance/notification-only grants confer none of them.
- Each new view/manage/document/action combination tested independently, including rescue-only versus rescue+view, view-only POST, forged actor/store/driver/request fields, stale selectors and changed-input replay.
- Customer/merchant/driver sessions cannot enter platform routes using known IDs. Merchant tenant/customer/driver ownership rules in existing APIs remain unchanged.
- Same-cookie revocation of each representative view/action/document grant denies next effective request, preserving unrelated grants; no cached private section survives denial.
- Exact allowlists for overview, lookup, Order/Delivery, timeline and health; no OTP/hash, GPS, contact, recipient observations/ID, document storage/URL, bank/provider evidence or private rendered messages.
- Diagnostic purity across success/missing/attention/error, including no delayed background event/workflow side effect caused by GET.
- Rescue active/terminal/custody/native uncertainty denials, real DB idempotency/races/rollback/deferred constraints, source-bound receipt readback and no normal dispatch bypass.
- React text output, strict input schema/bound cursors, no arbitrary URL or dynamic SQL/resource selector, private/no-store, safe errors; authorized unavailable ≠ zero/empty.

No new severity claim follows solely from a legacy broad User grant. B/C must fix concrete authority/side-effect defects they expose before D closure; no confirmed Critical/High/Medium issue may remain. Native unrestricted Admin governance is not solved by a hidden M23 button or by these custom grants.

## 20. Query and presentation discipline

Use indexed owner filters/keys, finite source list, bounded per-source pages/counts, limited fan-out, exact-ID hydration, source sampled_at and explicit truncation. No global full-table ordered scan, unbounded nested histories or per-card financial/native detail waterfall. Add only M23-required indexes with forward migrations when justified, not broad DB tuning. No materialized operational state or cross-domain mutation transaction for reads.

Desktop-first admin layout, established tables/filters, bounded pagination and responsive overflow; clear amount/status/reason/next destination. Current integer minor units/currency and established formatter only. No browser economic arithmetic or generic dashboard redesign. Loading, empty, partial unavailable, denied, stale hint and error are explicit. Refresh/revalidation is safe for pure reads; mutation uncertainty requires receipt readback, not automatic resubmission. No arbitrary sleep/retry or timeout inflation in acceptance.

## 21. Admin information architecture

Freeze Operations Overview, Orders, Deliveries / Attention, with contextual links to existing merchant/driver review, restricted compliance, service-zone/configuration, commissions, adjustments, settlements, driver finance and notification operations. New UI targets: `/admin/operations`, `/admin/orders` with exact Order detail, `/admin/dispatch` with exact Delivery detail. Navigation must derive available destinations from current safe capability results and backend denial remains authoritative.

Do not rebuild existing consoles, add universal customer/provider search, make `/admin/reports` a BI milestone or create a generic support/notes application. Existing admin home may link to the overview with minimal change. Rescue confirmation is only on authorized Delivery detail, displaying exact reference/revision/prior attention reason, structured reason and search-reopen semantics; no driver picker or success-implies-assignment copy. Refresh stale state before a new request identity; exact uncertain replay preserves original identity.

## 22. Exclusions and retained debt

M25: pg client.query deprecation, checkout/native workflow performance, advisory-lock/pool throughput, Windows/Next HMR, generic Playwright/verifier hardening, broad observability/alerts/APM, load/chaos tests, retention/archival/rotation and broad DB/index tuning. M23 must still bound its own queries and prove its own rescue races/authorization; correctness cannot be deferred as performance debt. MFA/stronger platform governance belongs to security hardening, not M23.

Post-MVP/separate approval: CRM/tickets, operator assignment/acknowledgement/SLA/notes, advanced BI, fraud tooling, automated banking, marketing, generic workflows/repair, new financial adjudication and new notification kinds/channels/policy. Existing M18–M22 policies and M8/M10 Pay/cart contention guarantees remain intact.

## 23. Required verification design

Later implementation adds pure policy/DTO tests, real DB purity/authorization/rescue tests, real HTTP same-session and exact-field tests, role UI tests and a small purpose-specific browser suite. No fake API-intercept E2E coverage or broad M8–M22 rerun by default. Run the smallest affected legacy owner authorization and M15–M17/M21 generation/assignment regressions justified by changes; preserve actual assertions, not arbitrary Promise success expectations.

Acceptance uses the established explicit `gospaza_m18_c2b_test`, Redis `/1`, test/test isolation and built-backend methodology, controlled workers/providers, no live email/payment calls and no new database create/drop. Shared selection/manifest/credentials must be explicit and self-consistent if used; mutable rescue records and revocation actors are dedicated, with preflight consumption checks. Do not reuse a financial/source fixture that a prior journey consumed. No verification is run in A.

## 24. Frozen slices

| Slice | Authorized work after separate instruction | Excluded |
|---|---|---|
| M23-A | This contract: ownership, grants, route hardening inventory, pure reads, source federation, lookup/context/timeline/health, exact rescue admission/success/evidence, privacy and closure | All production code/migrations/verification |
| M23-B | Implement current-grant hardening, pure owner diagnostic ports, overview/attention federation, Order/Delivery detail, bounded exact lookup, contextual timeline and truthful health projection; focused unit/DB/API proof | No rescue mutation or admin UX. No B exception for convenience: forward generation/rescue work belongs to C; shared pure readiness extraction may be done without changing command semantics |
| M23-C | Delivery-owned rescue command/journal/audit/idempotency/forward DB guards/work fencing; operations admin overview/Orders/Deliveries/attention/rescue UI; reuse existing consoles; focused implementation tests | No generic repair/override, finance change, work items/notes or future features |
| M23-D | Direct BOLA/BFLA/revocation/privacy/purity/rescue-race and dispatch-policy acceptance; targeted browser journeys; final static security review and user-run verification/closure | No M23-E unless separate evidence and approval justify it; no later milestone |

## 25. Closure and remaining decisions

The following M23 closure criteria are satisfied by the previously verified A/B/C slices and user-confirmed final D acceptance on 2026-11-07:

1. Explicitly authorized operators discover bounded relevant attention and inspect safe authoritative Order/Delivery context, including truthful missing/unavailable state and exact-ID navigation.
2. Every included legacy review/configuration route and authoritative service action has its required explicit grants; same-session effective revocation works and privacy/counts compose independently.
3. New diagnostic GETs cause no domain writes/audits/repair/provisioning/workflow/provider effects.
4. Timelines/health are bounded and truthful; no parallel exception/audit/assignment authority.
5. Exactly the approved unassigned pre-fulfillment rescue reopens a new normal dispatch generation atomically and idempotently; terminal/active/custody/uncertain cases deny, concurrency/rollback preserves capacity and history, and MERCHANT_ONLY/PLATFORM_ONLY/HYBRID/compensation/offer acceptance rules remain authoritative.
6. Existing domain mutations/finance idempotency and evidence boundaries are preserved; no generic override/financial mutation/worker control exists.
7. Targeted code/API/DB/browser acceptance and builds are user-verified, and no confirmed Critical/High/Medium security issue remains.

No unresolved product-policy question blocks A review: rescue is approved for the precise narrow population in sections12–15; MFA is deferred; health without persisted evidence is Unknown/Not instrumented; notes/assignment are excluded. Deployment grant recipients are explicit operator configuration, not an excuse for default grants. B/C must surface any newly proven incompatibility before changing this contract, rather than invent a broader rescue or weakening constraints.

**M23-A/B/C/D are complete and user-verified; M23 is closed as verified on 2026-11-07.** No M24 or M25 work is authorized or begun by this closure update. No commit or merge was performed.

## Historical A command record

A was documentation-only and required no executable verification commands. The final command sequence remains unchanged in [M23_D_ACCEPTANCE.md](M23_D_ACCEPTANCE.md); the user confirmed all commands passed on 2026-11-07. No commands were executed by Codex.

## Files changed by A

- `milestones/MILESTONE_M23_OPERATIONS.md` only. The approved audit remains a historical finding/recommendation record; this contract records the user's approved decisions that supersede its alternatives.
