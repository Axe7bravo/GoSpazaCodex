# M23 Operations — architecture and scope audit

Date: 2026-11-06 (Africa/Johannesburg). Branch inspected through `.git/HEAD`: `milestone/m23-operations`.

**Audit only. Not an M23-A contract or implementation approval.** M22 is complete and verified according to the current user instruction. Older handoff prose saying that M22 verification is pending is historical, not authority to reopen it. No production code, migration, dependency or configuration is changed by this audit. No verification command was executed and no commit was made.

## Recommendation

M23 should make existing operational problems discoverable and inspectable, close the explicitly deferred platform-capability gap, and link to existing domain tools. Use bounded, federated **domain-owned diagnostic projections**, not a new incident/order/financial state machine. Keep financial authority and private evidence behind their existing grants. Do not introduce generic resolve, retry-all, repair-all, worker-toggle or force-status controls.

Recommend four small slices: A contract; B capability enforcement and bounded domain projections; C admin overview/detail/navigation; D targeted security/API/browser acceptance. A separate rescue slice is justified **only if** the product approves a precise delivery rescue policy. The earlier M15 promise of controlled rescue cannot be considered implemented by an inspection screen. That policy decision must be explicit before A closes.

The largest technical risk is confusing observation with mutation: several existing detail/read methods materialize or reconcile records. An overview must not call those methods indiscriminately or impersonate customer/merchant/driver actors to gain access.

Medusa ownership decision: backend dependencies pin Medusa framework/commerce/CLI and loyalty plugin to 2.18.0. Native Order/Customer/User/Payment/Fulfillment/Store Credit remain authoritative; no native replacement, custom operations entity, new module or package is proposed. Marketplace owns its linked operational/finance evidence; M23 adds permissioned read contracts and presentation only in the baseline. This decision is based on installed repository ownership and types/services, not assumptions about a newer Medusa release.

## 1. Roadmap evidence and authority

| Repository evidence | What it actually establishes |
|---|---|
| `docs/product/PRD.md`, Cancellation and marketplace economics | Support/request concept after merchant acceptance; manual merchant transfer recording; financial distinction. Does not authorize CRM, arbitrary cancellation/refund, or automated banking |
| `docs/ux/UX_SPEC.md`, Admin routes/principles | Intended `/admin/orders`, `/admin/dispatch`, `/admin/merchants`, `/admin/settings`, `/admin/audit`, `/admin/reports`; controlled workflows, dense operational queues. A route on this list is not proof of an implementation or an approved BI product |
| `docs/architecture/ARCHITECTURE.md`, ownership/API/workflow sections | Modular monolith, native Medusa ownership, custom domain boundaries, actor DTOs, essential background processing |
| `milestones/M11_E_ACCEPTANCE.md`, Residual risks | Explicit M23 broader operational recovery/support tooling; no new admin override in M11 |
| `milestones/M14_D_ACCEPTANCE.md`, Security and deferrals; `M14_B_IMPLEMENTATION.md`; `M14_C_IMPLEMENTATION.md` | Existing native User trust is deliberate earlier policy; M23 narrower review capabilities/admin governance. MFA is mentioned with governance/hardening, but no approved MFA product/integration contract exists here |
| `milestones/M15_B_IMPLEMENTATION.md`, final handoff; `M15_C_IMPLEMENTATION.md`; `M15_D_ACCEPTANCE.md`, Residual limitations | M23 controlled attention/rescue/re-dispatch; no automatic generation restart. Assigned invalidation retains commitment/capacity. Cannot silently substitute manual status edits |
| `milestones/M16_D_ACCEPTANCE.md`, Deferred | M23 operational recovery UX, separate from OTP/physical completion authority |
| `docs/M10_G_ACCEPTANCE_SECURITY.md`, Deferred M23/M25 | Restricted handling of durable checkout `RECOVERY_REQUIRED`; retain capacity/frozen checkout when completion is uncertain. Missing workflow history is not retry permission |
| M18–M22 milestone contracts and implementations | Domain-specific financial/verification/notification tools already exist. M23 general operational UI was excluded from those slices; exclusion is not approval to override them |
| `CURRENT_STATUS.md` | Stale M3/M4 status, not a current roadmap. Do not use it to undo user-verified M18–M22 |
| `README.md` | Environment/process/platform guidance and earlier milestone links, not a detailed M23/M24/M25 product contract |

The checked-in Markdown does not contain a complete approved M23 implementation contract or a detailed M24 scope. M25 ownership is evidenced by explicit accumulated deferrals below. The archived original PRD PDF is not treated as authority over current PRD/milestone decisions. This audit does not claim PDF-only requirements were independently extracted. Current prompt plus the specific deferred obligations above define the audit; A must freeze the resulting scope.

## 2. Existing platform surface inventory

All API paths below are relative to `/admin/gospaza` unless stated otherwise. Existing admin home is `/`, a link hub, not an operational dashboard. Native Medusa admin routes are separate privileged commerce interfaces, not a ready-made safe GoSpaza operations API.

| Domain / page | API and read functions | Mutation functions / authority | Attention, repair and UI status |
|---|---|---|---|
| Merchant application review: `/admin/merchant-applications`, `/[id]` | `/merchant-applications`, detail, `/review-history`, private `/documents/[documentId]/access`; submitted application/name/status search | start-review, request-information, reject, approve through Marketplace and `approveMerchantWorkflow`; currently native platform-user boundary | SUBMITTED/UNDER_REVIEW/INFORMATION_REQUIRED; native provisioning readback/replay, not generic repair. Full review UI exists |
| Driver review: `/admin/drivers`, `/[id]` | `/drivers`, detail; lifecycle/affiliations/history via `DriverService` | approve, require-changes, suspend, reactivate, deactivate; affiliation activate/decline/revoke; native User existence currently sufficient | PENDING_REVIEW/CHANGES_REQUIRED/SUSPENDED; no earning rewrite. UI exists; no separate platform document-verification subsystem should be invented |
| Zones: `/admin/service-zones` | `/service-zones`, zone detail/store assignments through `LocationService` | create/update zones and assign/unassign stores, authenticated User | Native shipping/location references plus GoSpaza service-zone/fee ownership; UI exists |
| Scheduling: no dedicated admin page | `/scheduling/[storeId]`, `/slots`, policy/assignment reads | policy, slot, assignment configuration and `/synchronize` through `SchedulingService` | Native shipping compatibility/revision drift; reason/confirmation inputs. API exists, coherent navigation/UI incomplete |
| Dispatch configuration: no dedicated admin page | `/stores/[id]/dispatch-configuration` | configure mode through `DispatchService.configure`, native User | Existing configuration/audit, not assignment override. No platform delivery queue/detail/re-dispatch endpoint |
| Order operations: no admin order page | Existing merchant/customer APIs use `OrderOperationsService`; admin finance endpoints are not an operational Order DTO | Merchant acceptance/rejection stays merchant-owned; repairBatch materializes verified completed handoffs | Completed checkout → OrderOperation → picking. No platform consolidated operational projection or safe platform search |
| Delivery/pickup/handoff/return: no platform detail page | Existing merchant/customer/driver projections and commands, `DispatchProjection`, `PickupService`, `HandoffService`, `RecipientService` | Driver offer/arrival/pickup/OTP, recipient assessment and merchant return receipt remain actor-specific | Delivery/commitment/custody attention, native execution recovery. No admin force deliver/release/OTP retrieval route |
| Restricted commerce: `/admin/restricted-commerce` | `/restricted-commerce/stores`, `/stores/[id]`, product classification and private document endpoints | registration review/approval/request-changes/suspend/revoke and classification review through `RestrictedCommerce`; explicit reviewer IDs | Registration/classification queue and UI already exist. Purchaser provider is a distinct integration gate, not an ops approval shortcut |
| Adjustments: `/admin/financial-adjustments` | `/financial-adjustments`; `/orders/[id]/financial-resolution`; existing approved amounts/components, funding, history, optional dispositions | `/orders/[id]/goodwill`, adjustment `/approve`, `/refund`, `/store-credit`; `FinancialService`, `RefundService`, `StoreCreditSettlement` with separate grants | REVIEW_REQUIRED/refund UNKNOWN/FAILED/ATTENTION_REQUIRED/credit attention. Existing UI includes bounded existing actions; no blanket resolve |
| Commission: `/admin/commissions` | `/commission-rules`; `/orders/[id]/finance-snapshot` | effective-dated publication through `CommissionService`; explicit configure grant | Missing terms/recognition exceptions visible per Order, no global exception queue. Existing history/publication UI and exact order lookup |
| Settlements: `/admin/settlements`, `/[id]` | `/merchant-payouts` safe list/detail; `/merchant-settlements` domain reads; restricted payout `/evidence` | generation/prepare/DRAFT supersede; approve/record payout/failed attempt/retry/reconcile/discrepancy through M20 owners | OPEN discrepancy, failure and holds; mature UI. Existing repair is explicit generation for one merchant/period, not clearing discrepancy |
| Driver finance: `/admin/driver-finance` | `/driver-finance/{capabilities,earnings,payments,reviews}`, individual earning/payment, `/driver-payments/attention`, driver-specific and restricted evidence reads | `/driver-compensation` publish/activation; record/uncertain/confirm-paid/confirm-not-paid/reconcile/discrepancy through M21 owners | Recognition reviews, reserved uncertain payment, discrepancy; existing finance console. Some raw attention endpoints have no dedicated UI |
| Notifications: `/admin/notifications` | `/notification-operations`, `/health`; safe D/E projection | No operations mutation; ordinary `/notifications` is an individual inbox, not a platform shared-message API | Accepted/uncertain/failed/suppressed plus bounded health. Complete UI exists; repair stays internal |
| System: no combined admin health page | `/health/live`, `/health/ready` (outside admin family), notification health, persisted work/cursors | Jobs/CLI only, not browser controls | Dependency readiness is not proof of scheduler or provider health |

Source anchors: `apps/admin/app/page.tsx`; route tree `apps/backend/src/api/admin/gospaza`; `packages/contracts/src/{orders,dispatch,pickup,handoff,recipient,financial,commission,merchant-settlements,driver-finance,notifications}.ts`; matching `packages/api-client/src` modules. No existing admin Order/dispatch page was found in the inspected route tree.

## 3. Current capability inventory

| Authority | Current server-owned policy | Boundary / important non-implication |
|---|---|---|
| Native platform user session | `requireActor("user")` middleware; native User retrieval in several services | Authentication is the only bespoke platform grant for merchant review, driver lifecycle, zones/scheduling and dispatch mode today; not a finance/notification grant |
| Financial read, disposition read, approval, goodwill, refund, credit | `FINANCIAL_{VIEW,VIEW_DISPOSITION,APPROVE,GOODWILL_CREATE,EXECUTE_REFUND,ISSUE_STORE_CREDIT}_USER_IDS`; `financial-policy.ts` | Independent capabilities; visibility does not imply any settlement mutation. Disposition view alone does not replace financial VIEW |
| Commission configuration | `COMMISSION_CONFIGURE_USER_IDS`; `commission-policy.ts` | Commission history allows financial VIEW or configure; order economics requires financial VIEW |
| Settlement operations | `SETTLEMENT_{VIEW,PREPARE,APPROVE,PAYOUT_RECORD,RECONCILE}_USER_IDS`; settlement/payout policies | PREPARE owns generation/DRAFT supersede; APPROVE also retry authorization; PAYOUT_RECORD owns transfer/failure record; evidence/discrepancy limited to applicable action grants. Read UI still needs VIEW |
| Driver compensation | `DRIVER_COMPENSATION_MANAGE_USER_IDS`, `DRIVER_EARNINGS_VIEW_USER_IDS` | Manage publishes/activates; history permits manage or view; no authorizing financial amount from a delivery fee |
| Driver payments | `DRIVER_PAYMENT_RECORD_USER_IDS`, `DRIVER_PAYMENT_RECONCILE_USER_IDS`, `DRIVER_EARNINGS_VIEW_USER_IDS`; `driver-payment-policy.ts` | Evidence/discrepancy requires record or reconcile; view is not evidence. No merchant access to platform liabilities |
| Restricted review | `RESTRICTED_COMMERCE_REVIEWER_IDS`; `RestrictedCommerce.platform` | Current native User plus grant, including registration/classification/evidence. Does not authorize recipient compliance override |
| Notification ops | `NOTIFICATION_OPERATIONS_VIEW_USER_IDS`; runtime policy and native identity recheck | No manage/send grant, no unrelated finance grant inheritance |
| Notification audiences | Four explicitly configured platform audience lists in `.env.example`/M22 recipient adapters | Audience selection is not a domain capability or a shared ops role |
| Merchant roles | `team-policy.ts`, authenticated active membership, owner/manager/picker matrix | These are not platform roles. Receipt does not imply inventory sellability, compliance or financial authority |

There is no general current `OPERATIONS_MANAGE`, super-admin role, editable platform role-management UI or new M23 grant store. Existing grants are deployment configuration read by policy, not trusted browser claims.

## 4. Durable attention / exception inventory

The following distinguishes persisted obligations from derived presentation. A non-success state is not automatically an incident: preactivation history, recipient rejection, ordinary review and suppression can be expected outcomes.

| Domain / authoritative records | States / reason families | Current readers / actors | Resolution and repair boundary |
|---|---|---|---|
| M8 cart binding, M9 reservation/configuration | Stale/superseded binding, invalid configuration, expired hold; conflicts are often request results, not durable exception rows | Own customer; native/config admins | Existing canonical-cart and reservation logic. Do not manufacture an incident from every 409 |
| M10 `checkout_attempt`, `checkout_completion`, `provider_operation`, `yoco_inbox` | RECOVERY_REQUIRED; missing/conflicting execution history, failed terminal native readback; pending/uncertain provider result, rejected/applied inbox. FAILED is not proof of refund | Own customer bounded payment status; internal reconciliation. No general admin diagnostic projection | Existing workflow/readback/technical compensation only. Frozen uncertain completion retains capacity; no safe generic resume/release/cancel primitive |
| M11 `order_operation`, `order_decision_event`, repair cursor | PENDING_ACCEPTANCE/ACCEPTED/REJECTED; missing materialized operation after proven completion, repair deferred | Merchant capability/current customer; no platform operational queue | `ensure`/`repairBatch` reconstruct only valid M10 handoff. Merchant decision is not an admin override |
| M12/M13 `pick_session`, `pick_line`, `shortage_resolution` | CUSTOMER_DECISION_REQUIRED, RESOLVED_OMITTED, financial_review_required, invalidated shortage | Assigned picker, customer for decision, merchant policy | Existing shortage/expiry/read repair; omission is an authoritative source, not automatically a failure. No post-delivery shortage adjudication source |
| M15 `delivery_operation`, `dispatch_commitment`, `dispatch_work`, `dispatch_event` | ATTENTION_REQUIRED: DISPATCH_CONFIGURATION_DISABLED, DELIVERY_NO_LONGER_DISPATCHABLE, ASSIGNMENT_REVIEW, SEARCH_UNAVAILABLE, SEARCH_ENDED, POOL_EXHAUSTED; OBSERVATION_DEFERRED work marker | Driver own commitment; customer/merchant bounded projections; internal orchestrator | Same-generation reconciliation/expiry/discovery exists. Exhausted/attention generation does not restart. Assigned invalidation retains assignment/capacity. No current rescue command |
| M16 `pickup_operation`, `pickup_work`, delivery state/event | DISPATCHED/RECOVERY_REQUIRED; PICKUP_DRIVER_REVIEW, PICKUP_NATIVE_REVIEW, PICKUP_READINESS_LOST | Assigned driver, merchant/customer safe state; internal pickup worker | Native workflow identity and exact receipt readback. No re-run native shipping merely because evidence is missing |
| M16 `handoff_generation`, `delivery_completion`, delivery state/event | Expired/closed generation; HANDOFF_LIMIT_EXHAUSTED; delivery completion RECOVERY_REQUIRED | Assigned driver/customer stage-safe DTO; internal handoff observation | Exact native terminal evidence may converge completion/release. No OTP disclosure or forced success |
| M17 registration, classification, recipient assessment, `restricted_return` | Review/changes/suspend/revoke; classification stale/missing; return-required/returning/returned; COMPLIANCE_RECOVERY_REQUIRED | Compliance reviewer owns store evidence; actual driver assessment, merchant custody receipt; customers receive bounded state | Existing reviewer/recipient/custody commands only. No ops waiver of actual recipient compliance. Return custody is not financial completion |
| M18 `financial_adjustment`, allocation/events, `financial_settlement` | REVIEW_REQUIRED/APPROVED/ATTENTION_REQUIRED; source reasons ITEM_OMITTED, MERCHANT_REJECTED, FULL_UNFULFILLABLE, RESTRICTED_HANDOFF_FAILED, GOODWILL | Financial VIEW, distinct approve/goodwill grants; own role projections | Existing authoritative source calculation + explicit approval; exactly one eligible/default method. No client-selected split or synthetic shortage source |
| M18 `refund_operation`, `provider_refund_attempt`, `refund_event` | UNKNOWN/FAILED_NOT_CREATED/FAILED/PROVIDER_SUCCEEDED/ATTENTION_REQUIRED; PROVIDER_EVENT_MISSING, SAFE_REPLAY_WINDOW_EXHAUSTED, PROVIDER_EVIDENCE_CONFLICT, PROVIDER_REFUND_ID_MISMATCH, SUPERSEDED_ATTEMPT_EVENT, NOT_CREATED_EVENT_CONFLICT, CONTRADICTORY_TERMINAL_EVENTS, NATIVE_REFUND_MISMATCH/RESULT_MISSING, NATIVE_ORDER_MISMATCH/RESULT_MISSING | Financial VIEW projection; EXECUTE_REFUND command actor; internal recovery | EXECUTE/RECONCILE/RETRY_NOT_CREATED have exact distinct proofs. Readback recovery exists for specific missing native results; no mark-refunded or ambiguous resend |
| M18 `store_credit_operation`, operation events + native Store Credit | CREATED/ISSUING/FAILED/ATTENTION_REQUIRED/SETTLED; ACCOUNT_EVIDENCE_UNAVAILABLE, NATIVE_CREDIT_UNCONFIRMED | Financial VIEW, ISSUE_STORE_CREDIT; customer bounded balance | Stable operation identity/native transaction readback through issue primitive; entitlement remains reserved under uncertainty. No top-up, new wallet or balance editing |
| M18 `returned_inventory_disposition` | UNDECIDED is a projection; persisted DISPATCHED/COMPLETED/ATTENTION_REQUIRED | Merchant INVENTORY_MANAGE (owner/manager), optional financial disposition view | RESTOCK/NON_SELLABLE based on frozen received physical manifest. Unknown native adjustment cannot simply be issued again. No platform disposition override exists |
| M18 `omission_reservation_release`, checkout credit-redemption records | DISPATCHED/ATTENTION_REQUIRED reservation release; spent credit restoration pending after safely closed unpaid checkout | Internal workers; currently incomplete platform diagnostic surface | Exact native reservation IDs/readback; restoreClosedCheckout only proven failed/expired/abandoned/superseded unpaid attempt without completion. Omitted units never get a stock increment |
| M19 `order_finance_snapshot`, `order_finance_exception`, immutable posting | UNRESOLVED, MISSING_COMMISSION_TERMS, UNKNOWN_PROMOTION_SPONSORSHIP, ECONOMIC_EVIDENCE_MISMATCH, RECOGNITION_EVIDENCE_MISMATCH, UNRESOLVED_ADJUSTMENT_ATTRIBUTION, POSTING_SOURCE_CONFLICT | Financial VIEW per-order economics; internal provisioning/recognition | Bounded immutable-source repair, no manual resolve/backdating/posting edit. New prospective terms do not retroactively repair missing historical terms |
| M20 statements/exclusions/payables | Holds HISTORICAL_CATCH_UP/UNRESOLVED_FINANCE → HISTORICAL_REVIEW/FINANCIAL_REVIEW DTO; FAILED; OPEN discrepancy | SETTLEMENT_VIEW; distinct prepare/approve/record/reconcile | Generation/preparation/supersession/retry only with M20 guards. Historic paid statements immutable; no general discrepancy deletion/closure command |
| M20 failure/discrepancy records | BANK_REJECTED, RETURNED_BEFORE_RECEIPT, RAIL_CONFIRMED_FAILURE; UNKNOWN_OUTCOME, RETURNED_TRANSFER, BENEFICIARY_MISMATCH, AMOUNT_MISMATCH, TRANSFER_DISPUTE, DUPLICATE_EXTERNAL_RECORD, RECONCILIATION_MISMATCH | Restricted evidence/action grants | Failure proof/nonreceipt and external-transfer identity required. Recorded transfer is not a bank send. OPEN discrepancy blocks applicable advancement |
| M21 `driver_compensation_exception` / snapshots | MISSING_COMPENSATION_TERMS, HISTORICAL_PREACTIVATION, SNAPSHOT_MISSING, SNAPSHOT_CONFLICT | Compensation manage or earnings view via resolution; internal repair | Missing terms rejects ACCEPT while offer is retained, deduplicated exception. Later applicable terms do not authorize rewriting an existing frozen assignment |
| M21 `driver_earning_exception`, recognition/earning | COMPLETION_EVIDENCE_MISMATCH, SNAPSHOT_MISSING, SNAPSHOT_IDENTITY_MISMATCH, PAYER_CLASSIFICATION_CONFLICT, SOURCE_CONFLICT; derived HISTORICAL_REVIEW | DRIVER_EARNINGS_VIEW + bounded reviews; own driver only safe under-review | Recognition repair from M16/M17/compensation evidence. Existing exception remains blocking; no earning edit/delete or arbitrary financial adjudication |
| M21 payment/hold/allocation/resolution/reconciliation/discrepancy | UNDER_REVIEW/UNKNOWN_OUTCOME, DISCREPANCY, AWAITING_RECONCILIATION; integrity REVIEW_REQUIRED in attention diagnostic | Safe earnings viewer; restricted evidence requires RECORD/RECONCILE | Existing confirm-paid, confirmed-not-paid and reconcile require evidence. Discrepancies remain append-only and do not get a generic resolution button |
| M22 intent/delivery/attempt/evidence/checkpoints | ATTENTION_REQUIRED, TERMINAL_FAILURE, RETRYABLE_FAILURE, SUPPRESSED; NO_RECIPIENT/STALE/POLICY/AUTHORIZATION_CHANGED; configuration/envelope change, lost/ambiguous result, replay/attempt limit; repair failure/retrieval mismatch/webhook conflict | NOTIFICATION_OPERATIONS_VIEW; actor owns only IN_APP notice | Bounded automatic repair/replay within frozen horizon; outside-window ambiguity stays attention. No resend/clear/reset controls |

Reason lists are source families, not a new shared enum. API conflict strings such as CHECKOUT_ALREADY_PROCESSING and CART_STATE_CONFLICT are not persisted exception states. The overview must not imply historical/preactivation rows are newly payable, or count every suppressed notification as a failed business transaction.

## 5. Existing repair/recovery inventory

| Function / entry | Inputs and bound | Mutation / authoritative primitive | Recommended operator exposure |
|---|---|---|---|
| `PaymentReconciliationService.applyInbox`, `reconcile`; job `reconcile-yoco.ts` | IDs; up to 100 received inbox + 100 pending provider operations per scheduled pass | Correlation, same cart locks, exact workflow/native receipt, M10 technical compensation | Diagnostic status only in M23; no bulk reconcile/retry API. Cannot override RECOVERY_REQUIRED |
| `OrderOperationsService.ensure`, `repairBatch`; `repair-order-operations.ts` job | Exact Order; persisted cursor page 50 | Verified completed-handoff materialization, merchant locks, original decisions retained | Automatic internal repair; surface deferred/missing materialization without doing repair on overview reads |
| `DispatchOrchestrator.ensure/repair/runBatch` | Source discovery 25; 25 due work records; bounded candidate pages | Existing dispatch service + durable work/cursor/fence | Internal. No auto generation reset, no candidate selection from UI |
| `DispatchService.current/reconcile` | Own/exact delivery, current revision | Lazy expiry/read revalidation, retained commitment | Do not reuse own-driver HTTP as platform diagnostics or offer a release button |
| `PickupService.prepare/observe/runBatch` | Exact delivery; discovery 25, due batch bounded | One designated native PREPARE/SHIP execution; exact history/receipt readback | Internal, not UI replay. Expose safe attention/context only |
| `HandoffService.observe/runBatch` | Exact delivery; due page 25 | Existing native completion observation, then authoritative terminal receipt/release | Internal, no forced completion |
| M13 shortage reads/expiry | Own order/line and original server expiry | Existing shortage decision/fallback primitive | Existing customer/picker UI; no admin substitute-decision shortcut |
| `RefundService.repair`; refund-recovery job | Default20, validated max100, current attempts/leases | `advance` with frozen request/key and exact provider/native readback | Keep internal scheduler; existing single-adjustment commands stay on M18 UI with EXECUTE_REFUND |
| `StoreCreditSettlement.issue` | Exact approved adjustment, full entitlement | Native account/transaction reconciliation + same settlement reservation | Existing M18 command only. No new generic retry or alternate settlement method |
| `OmissionReservations.reconcile`; reconcile-omissions job | Resolution ID; scheduled page20 | Exact reservation deletion/readback, no artificial restock | Internal. Attention after uncertain native result is not permission to delete unrelated reservations |
| `SafeStoreCreditService.restoreClosedCheckout`; restore-checkout-credit job | Proven closed unpaid attempt; page20 | Native credit restoration, checks no completion | Internal, no cash/refund shortcut |
| `CommissionService.provisionPage`; `finance:provision-snapshots` | `M19_PROVISION_AFTER`; page25 | ensure frozen order economics, DB constraints | Internal controlled command; no dashboard read materialization |
| `MarketplaceRecognition.repair`; `finance:repair-earned-sales` | M19_RECOGNITION_AFTER/THROUGH; page25 | Original source recognition; deferred results preserved | Internal. No historical re-pricing or fabricated post-delivery adjustment |
| `MerchantSettlements.repair`; `settlements:repair` | Explicit preparer, merchant/store, policy, period | Exact same `generate`, existing PREPARE grant | Existing generate UI already provides the safe operation; do not expose CLI as another HTTP command |
| `DriverCompensation.repair`; `drivers:repair-compensation` | Explicit manage actor, AFTER; page25 | Records deduplicated missing/conflict/history exceptions; does not fill missing frozen snapshots by guessing | Internal diagnostic/repair command; no backdate button |
| `DriverEarnings.repair`; `drivers:repair-earnings` | AFTER/THROUGH; limit25 | Same authoritative recognition and exceptions | Internal, no financial management authority from ops |
| `NotificationRepair.cycle/discoverPage`, `NotificationRuntime.recoverStuck/retrieveKnown` | One 20-row source page/cycle, 1h windows, fenced10min lease; recovery/retrieval page20 | C/B discovery/admission, known provider identities, original replay window/key | Internal. Existing ops page is read-only; no resend/force-send |
| Existing commerce/fulfillment backfills and catalogue orphan cleanup scripts | Explicit setup/maintenance commands | Native infrastructure/config repair, potentially changes live commerce/files | Maintenance/runbook only. Not operational attention commands |

No separate verification-repair worker was found. Merchant provisioning replay and reviewer transitions exist; a draft/submitted application is not repaired by bypassing review. No settlement cron generation or driver earning scheduled repair job was found; event/CLI operation must not be shown as a healthy periodic worker that does not exist.

## 6. Worker/system health

| Job | Schedule / gate | Evidence presently available | M23 treatment |
|---|---|---|---|
| Yoco reconciliation | Every minute; valid Yoco config + reconciliation worker flag | Inbox/provider due records and sanitized deferred logs; no persisted last-success heartbeat | Enabled/configured plus bounded pending/oldest observation; execution last-success **unknown**, not green |
| Refund recovery | Every minute; explicit REFUND_RECOVERY_WORKER_ENABLED | Durable operation/attempt/lease/attention evidence | Same; do not derive provider success from worker enablement |
| Order-operation repair | Every minute, no explicit job flag in file | Durable repair cursor and deferred log count | Cursor/backlog observation, not claimed execution health |
| Dispatch | Every5s; DISPATCH_WORKER_ENABLED | dispatch_work due time/revision/last_error and discovery cursor | Bounded due/attention/deferred summary, omit location samples |
| Pickup / handoff | Every10s; separate flags | pickup_work / handoff_work and native operation state | Safe due/attention counts and observed times |
| Omission reservations | Every minute; OMISSION_RESERVATION_WORKER_ENABLED | resolution/release states and safe warnings | Pending/attention bounded projection |
| Closed checkout credit restoration | Every minute; no explicit flag in job file | Eligible closed attempt/redemption records | Bounded restoration backlog, no balance rewrite control |
| Notification delivery / repair | Every minute; explicit flags and APP_ENV != test | Persisted notification_worker_health, checkpoints, bounded24h samples | Reuse existing health DTO; no second health authority or full infrastructure monitor |
| Substitution expiry | Domain-owned lazy reads/operations | M13 authoritative deadline/fallback | Do not invent a standalone job in the health list |

Dependency readiness uses Postgres/Redis probes in `lib/health.ts`; `/health/live` is only liveness. No comprehensive existing cross-job heartbeat/monitoring store was found. Baseline M23 should not add one: show supported metrics, sampled_at, oldest due age and unavailable/unknown distinctly. If A requires reliable per-worker last-success, approve a narrowly telemetry-owned heartbeat design/migration explicitly; a cursor's movement or an enabled flag is insufficient proof. External alert routing/observability stack is M25.

## 7. Search / lookup

Current bespoke searches are segmented: merchant applications by legal/trading name/status/pagination; driver review by status/page; restricted store review queue; financial adjustment list/page plus exact Order lookup; commission history by explicit merchant scope; settlement list/keyset and statement ID; driver finance by driver ID and earning/payment ID/keyset; notification ops time/ID pagination. No general safe platform order/delivery lookup, email/phone/customer search, or universal provider-reference resolver was found.

Recommend **typed exact-ID lookup** first: Order, checkout attempt (including no completed Order), Delivery, merchant/store, DriverProfile, adjustment, settlement statement/payable, driver payment. Resolve only under the target domain's current read grant; no hit counts/labels for forbidden families. Reuse existing finance/review screens for their selectors. Do not add email/phone/name-based customer search, broad provider-reference search, autocomplete across private records or an Elasticsearch dependency. Payment/provider reference lookup, if later needed, belongs to the financial adapter with FINANCIAL_VIEW and a minimal DTO, not general operations.

## 8–14. Domain gaps and recommended handling

| Area | Actual gap | M23 addition / leave unchanged |
|---|---|---|
| Order operations (8) | No platform queue/detail for commercial handoff, merchant decision, picking or failed materialization; finance page cannot explain fulfillment | Domain-owned platform read projection: verified Order reference, merchant/store, operational decision, pick progress, scheduling/dispatch timing, linked Delivery, bounded source events. Include checkout recovery without assuming an Order exists. No new status machine |
| Delivery operations (9) | No platform queue/detail for dispatch search/attention, assigned capacity, pickup/completion uncertainty or return custody | Delivery-owned diagnostics: own state/reason/revision, commitment state/path, safe driver reference, dispatch_not_before/deadlines, pickup/completion operation states, return custody. No OTP/hash/request counters, observations, recipient ID evidence or raw GPS |
| Merchant operations (10) | No active-merchant directory or coherent jump from store to operational order/dispatch/finance scopes | Small paginated safe merchant/store selector and links. Existing application/service-zone/commission/settlement tools stay. Merchant model has SUSPENDED but no generic new suspension route should be inferred |
| Driver operations (11) | Review/lifecycle and finance exist, current dispatch not exposed safely to platform; review authority too broad | Safe references/state links, narrower existing lifecycle/affiliation grants. Driver payment/earning view stays separately gated. No forced online/location injection/earning editing |
| Verification/compliance (12) | Merchant/driver legacy User-only review boundary; review screens themselves already exist | Narrow review/read/document authority as approved in A. Keep M17 explicit reviewer gate. No DOB/document central viewer, no new purchaser-verification provider or manual override |
| Finance (13) | Disconnected exceptions; M10 uncertainty/credit/omission attention incompletely discoverable; aggregate reads risk side effects | Finance-owned bounded diagnostic ports and links; map statuses without resolving. Existing M18–M21 action forms remain. Post-delivery shortage adjudication and mixed-funding refund source allocation remain separately deferred policies |
| Notifications (14) | Safe operations/health already complete; no need for rebuild | Link existing view, optionally authorized bounded summary. No shared user bodies/audience expansion, resend or clearing attention |

## 15–16. Overview and attention federation

Recommend an attention-first `/admin/operations` entry with Orders, Deliveries, Attention and existing tool links. No historical sales/GMV/earnings charts. Optional counts are bounded current observations, not BI or financial totals.

Federate explicit owner adapters (order/checkout; delivery; verification; finance; settlement; driver finance; notifications). Each adapter owns filters, safe reason mapping, read authorization and persistence access. The orchestrator calls public read contracts, **not cross-domain raw SQL or route handlers**, with independent pagination and limited fan-out. No giant join/union across native commerce, recipient assessment and finance evidence.

Suggested row contract for A to freeze: source domain/type + stable source ID, safe public reference, safe category/domain status, bounded reason, relevant timestamp, allowed contextual link, sampled_at. Optional store/driver references only if authorized/necessary. No source fingerprint, provider payload/key, contact details, bank evidence, OTP, assessment observations or hidden cross-domain counts. IDs identify records, never confer authority.

Keep independent category tabs/cursors rather than claiming a globally consistent sorted total across different domains. Stable identity must include domain and source type/ID, so an Order with both refund and delivery attention is not deduplicated into one false incident. Conversely do not duplicate the same source exception merely because it appears through two links. Source history and current actionable state are distinct: append-only historical exceptions do not all disappear or become resolved when a later observation exists.

Common presentation vocabulary must sit above, not replace, source state:

| Label | Meaning / limit |
|---|---|
| Needs attention | Owner has an actionable attention/discrepancy obligation; not authorization to resolve it |
| Under review | Actual reviewer or uncertain-evidence state; not a fabricated assigned operator |
| Retrying | Owner has a scheduled eligible retry; not every pending record |
| Failed | Known failure evidence; never a substitute for UNKNOWN/AMBIGUOUS |
| Blocked | Specific prerequisite prevents progression, with safe source reason |
| Unresolved | Owner cannot prove the required economics/evidence; no amount/status guess |
| Historical review | Preactivation/historical exclusion; no new payment liability inferred |

Keep original domain status/reason visible to authorized readers. Distinguish notification suppression, financial settlement, physical custody and provider acceptance. Do not add a common RESOLVED status or editable severity field.

Use `available`, `forbidden` (or omit ungranted panel consistently), and `unavailable` distinctly. A failed dependency is never zero attention. No all-or-nothing dashboard Promise.all that removes healthy authorized sections on one unavailable domain. Poll/revalidate with bounded requests; correctness does not require realtime or M22 messages.

## 17–19. Persistent work items, acknowledgement and notes

Not recommended for MVP M23. There is no demonstrated assignment/SLA/agent collaboration requirement in the current repository. Acknowledged/assigned/investigating would require its own durable workflow and retention/privacy rules, while `resolved` would dangerously compete with domain truth.

Do not add an operations_work_item table, mirror exception rows, archive/hide incidents, operator assignment, free-form notes or a new audit log. Existing authoritative action reasons/references remain available on their domain forms. If assignment/notes become an approved need later, define separate append-only operational metadata with actor/time/bounded reference/text and explicit privacy policy; acknowledgement must never imply financial/domain resolution. A generic instruction not to put secrets in notes is not sufficient protection for unrestricted free text.

## 20. Audit timeline

Recommend a bounded **read-only contextual timeline**, initially for an exact Order/Delivery, with owner-supplied safe events and per-section grant checks. Reuse `order_decision_event`, `pick_event`, `dispatch_event` (including M16 handoff transitions) and `restricted_event` (including M17 recipient/custody transitions) only through sanitized adapters, plus authorized financial/settlement/driver-payment/notification projections where linkage is proven. There are no separate handoff_event or recipient_event tables to invent. Review events remain in their own reviewer view.

Use domain+event ID identity; occurred_at and recorded_at where the owner distinguishes them; deterministic tie-breaks, not invented causal order. Omit workflow inputs, raw JSON evidence, recipient observations, OTPs, contact, bank/beneficiary proof, provider events and secret material. Do not copy records into a unified audit store, add delete/edit endpoints or expose a universal raw audit browser. Existing history arrays can be unbounded for a large record; new timeline ports require explicit per-owner caps/cursors rather than rendering them all.

## 21. Configuration and activation

Link commission terms, driver compensation terms/activation, service zones/fees, scheduling policy/slots/synchronization, dispatch mode and restricted trading policy to their existing owners. No generic settings key/value engine. No new rate, fee or effective-time authority in admin components.

Activation distinctions: commission is effective-dated rules, **not an invented commission activation switch**; M20 has prospective settlement_period_policy activation; M21 has explicit compensation activation/terms; M22 has one prospective initial notification activation, default-deny injected activation authorizer and no general activation HTTP route. Missing production rates/activation/audience/provider config must be shown as unconfigured where authorized, never seeded automatically. Any activation inspection excludes credentials and recipient audience identifiers. Enabling a worker or rotating a key remains deployment/runbook work, not UI toggles.

## 22. Proposed actions and domain owners

**Recommend no new business mutation or repair action in baseline M23.** New controls are read-only refresh, filters, typed lookup, contextual navigation and safe timeline expansion. Their read contracts must not cause downstream economic/operational writes. Narrowing legacy authorization is a required security-policy change, not a new business transition.

The following **already exist** and should remain available only on their domain screens. New overview links never substitute for their guards:

| Existing action | Owner / required authority | Idempotency/replay and audit | Risk / M23 treatment |
|---|---|---|---|
| Review/request information/reject/provision merchant | Marketplace; proposed explicit review/manage + document separation instead of User-only | Existing review state/replay and approval workflow/provisioning uniqueness; application review history | Sensitive provisioning; reuse, do not rerun based on missing dashboard row |
| Driver approve/changes/suspend/reactivate/deactivate, affiliation decisions | Driver lifecycle; proposed explicit review/manage | Existing expected revision and lifecycle/affiliation checks, driver_event | High operational impact; preserve occupied commitments/history; no force release |
| Zone/scheduling/mode configuration | Location/scheduling/dispatch owners; proposed explicit config grants | Existing owner validation/revisions/reasons/audit; preserve exact replay behavior rather than promise a new request-ID protocol | Marketplace-wide effects; no settings-store rewrite |
| Restricted registration/classification review | RestrictedCommerce + existing reviewer grant | Expected revision/identity, confirmation/reason and restricted_event | Compliance sensitive; no recipient waiver |
| Approve adjustment/create bounded goodwill | FinancialService + APPROVE/GOODWILL_CREATE | Existing source uniqueness/revision/request identity, financial_adjustment_event | Economic obligation; not an ops-view action |
| Refund EXECUTE / RECONCILE / RETRY_NOT_CREATED | RefundService + EXECUTE_REFUND | Exact source eligibility, reservation, attempt number/request/key/evidence, refund_event | Provider effect; reuse M18 UI, never generic retry |
| Issue/reconcile credit via existing issuance command | StoreCreditSettlement + ISSUE_STORE_CREDIT | Unique adjustment operation/native reference, reservation + operation events | Native balance mutation; cannot infer safe repeat from timeout |
| Generate/prepare/DRAFT supersede settlement | MerchantSettlements + PREPARE | Existing merchant-period/source claims, revision/request/fingerprint and transition audit | Liabilities/carry; existing UI only |
| Approve/record actual transfer/failure/retry/reconcile/discrepancy | MerchantPayouts + respective M20 action grants | Expected revision, exact transfer identity, command request/fingerprint/evidence, append-only receipts/audit | Financial evidence; recording is not initiating transfer, no clear discrepancy |
| Publish terms/activate compensation | DriverCompensation + MANAGE | Existing prospective/revision/request identity and compensation_audit | Future economics; no backdating/history editing |
| Record paid/uncertain, confirm paid/not-paid, reconcile/discrepancy | DriverPayments + RECORD/RECONCILE as M21 policy specifies | Whole-earning selection, hold/allocation/transfer identity and request command/audit | Financial evidence; preserve independent roles and no reallocate ambiguous money |
| Merchant return receipt/disposition | RecipientService/ReturnedInventory + active merchant role/ownership | Existing custody/manifest/revision/unique line operation evidence | **Not a platform M23 action**; platform links show read-only bounded disposition when granted |

## 23–25. Prohibited actions and repair exposure

Explicitly prohibit force-complete/force-deliver, OTP retrieval/override, change recipient compliance, generic edit-status, manual assignment/release, restart attention generation, mark-paid/refunded, clear discrepancy, rewrite earning/posting/settlement, arbitrary credit/restock, source/exception deletion, mark all attention resolved, resend notification, reset retry budget, live worker toggles and browser-triggered CLI execution.

UI-safe repair today means **existing owner-approved commands on their current domain screens**, such as explicit M18 readback reconciliation, M20 guarded DRAFT supersession/generation or verified failed-attempt retry. Their eligibility, evidence and audit remain authoritative. This audit does not authorize additional repair endpoints.

Keep M10 completion/provider recovery, M11 handoff materialization, M15 work discovery/reconciliation, native pickup/shipping/completion observation, omission release/restoration, M19 provisioning/recognition, M21 recognition/compensation repair, M22 delivery/discovery/provider retrieval and infrastructure backfills internal. Do not classify them as read-only merely because called repair/observe.

**Delivery rescue decision:** evidence explicitly reserves controlled rescue/re-dispatch for M23, but the current primitive/constraints deliberately make attention non-restartable and retain assigned capacity. If required now, A must specify pre-pickup/unassigned versus assigned/in-transit cases, old commitment/capacity disposition, fresh readiness, new generation authority, compensation snapshot effects, reason/idempotency/audit and opposing-action races. That is a delivery-owned workflow and forward migration if needed, not an alias for `start()`/`advance()`. Recommend baseline inspect/escalate only, with an explicit accepted deferral or separately approved rescue slice. Do not declare the old obligation satisfied otherwise.

## 26–27. Proposed authorization and revocation

Retain native Medusa User/Auth; no custom identity store, no blanket operations super-role. Preserve all M18–M22 grants verbatim.

For A approval, propose server-owned grants following existing repository convention:

| Proposed capability | Exact responsibility |
|---|---|
| ORDER_OPERATIONS_VIEW | Safe platform Order/checkout/picking context; no customer PII search or payment-provider detail |
| DELIVERY_OPERATIONS_VIEW | Delivery/commitment/pickup/completion/return status diagnostics, safe driver reference; no tracking/recipient secrets or mutations |
| MERCHANT_REVIEW_VIEW / MERCHANT_REVIEW_MANAGE / MERCHANT_DOCUMENT_VIEW | Narrow existing legacy review reads/decisions/private file access independently |
| DRIVER_REVIEW_VIEW / DRIVER_REVIEW_MANAGE | Narrow existing lifecycle/affiliation reads/decisions; no earnings/payment authority |
| SERVICE_CONFIGURATION_VIEW / SERVICE_CONFIGURATION_MANAGE | Existing zone/fee/scheduling/dispatch-mode reads/writes; domains remain authoritative |

Names are recommendations, **not shipped grants**. Keep M17 reviewer policy unless A explicitly approves separating its document reads. A non-sensitive merchant/store directory must be accessible only through an approved scoped view policy; avoid giving document/provisioning access merely for a selector. No generic OPERATIONS_MANAGE. Overview renders only independently authorized categories; finance/notifications/counts/timeline sections keep their own existing grants. Do not implicitly grant these proposed capabilities to all existing Users.

Enforce in owning services as well as routes; test direct calls/native bypass where applicable. Recheck current native identity and server grants each request and at established mutation serialization points; action hints do not authorize commands. Existing deployment env grants change only when server config/process changes; do not claim editing an external environment updates a running process. Same authenticated session must lose authority on its **next request after the changed configuration is effective**, including after a controlled restart; no JWT role snapshots or cached positive grant decisions. Frontend clears inaccessible protected content on failed refresh; backend still denies direct requests.

MFA is a real earlier governance concern, not proven implemented by email/password sessions. A must decide whether trusted ingress/identity MFA is a launch prerequisite or a separately scheduled hardening integration. Do not build a second auth/MFA subsystem inside operations or claim route capabilities solve MFA.

## 28–29. Privacy and static security review

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Assessment and required control/proof |
|---|---|
| Typed selector → ID validation → owning domain current read grant + resource linkage → detail DTO | BOLA/enum risk if new wrapper calls merchant/customer handlers as an impersonated actor. Use explicit platform ports; known foreign IDs and wrong capability tests |
| Cross-domain rows/counts → safe adapter projection → each independent domain grant → overview/timeline | **Primary design risk:** aggregation can leak restricted existence/reasons or finance evidence even when links are hidden. Deny/omit before fetching unauthorized rows/counts; exact DTO allowlists; no raw entities |
| Current native User → legacy review/config service → existing User-only policy → private docs/provision/lifecycle/config mutation | **Confirmed policy granularity gap**, explicitly accepted/deferred in prior milestones; not newly discovered anonymous exploit. M23 must approve scoped grants before expanding these tools. Finance-view-only User currently remains a native User for these legacy tools |
| Cached UI/actions → authoritative service state/revision → actual command grant → mutation | BFLA risk if ops-view becomes manage. Test view-only direct POST, revoked same-cookie session, stale action hints and existing domain guards |
| Domain assessment/workflow/provider JSON → projection → privacy allowlist → HTML/logs | Never include OTP/hash, DOB/ID, raw GPS, recipient observations, contact/email, bank evidence, provider keys/payloads. React text output, bounded safe errors, no raw audit serialization |
| Inspection request → existing ensure/observe methods → financial/operational locks → unintended mutation | **Confirmed side-effecting-read behavior**, not a claim of unauthorized exploit: FinancialService.adminOrder calls ensureLocked; CommissionService.preparePlatformRead can ensure a snapshot; pickup/handoff presentation observes native work. New overview must use pure read ports |
| Repair selector → internal CLI/scheduler → existing source/evidence fencing → native/provider write | Repair abuse if wrapped as generic HTTP. Do not expose it; prove no M23 route sends/refunds/restocks/releases or resets notification attempts |
| Free-text note → store/render/log → broader operator audience → PII leak | Avoid notes entirely; existing bounded owner action reasons do not authorize broad copied text |
| Grant config update/restart → current policy + native lookup → same-session API → protected DTO/command | Test same cookie denied after effective revocation, other independent grants retained; actor identity and operational suspension separate |
| Existing audit records → bounded contextual adapter → current source-specific grants → timeline | No edit/delete/copy authority; prove forbidden event fields absent and unrelated source linkage cannot leak |

No new Critical/High/Medium exploitable vulnerability is established by this documentation-only audit. This is static inspection, not runtime penetration testing or a claim that existing systems have no vulnerabilities. Legacy User-only authority and side-effecting reads are concrete architectural findings requiring scope decisions/controls, not inflated anonymous-bypass findings. Wider native Admin privilege governance must be considered in the role decision: a custom operations grant cannot restrict an independently issued unrestricted native Admin/API credential. Review native admin exposure/identity provisioning without inventing a broad native-admin rewrite in this audit.

Required executable acceptance: ordinary User denial, each proposed grant independently, financial/ops cross-grant denial, known-ID foreign role requests, exact field allowlists, same-cookie revocation, existing financial actions unaltered, destination reauthorization, no mutation from overview GET, and bounded unavailable/empty/forbidden behavior. Any approved rescue requires real DB opposing-operation tests, never mock-only approval.

## 30. Performance/query design

Use bounded owner reads (suggested default20/max50, finalized in A), keysets and exact-ID filters. Independent cursors permit real bound per section. Prefer a few server calls to authorized adapters rather than browser waterfalls or a monolithic join. Cap fan-out and native hydration, use Promise.allSettled-style independent availability where appropriate, no transaction/lock held across unrelated read fan-out. Do not add locks to make a dashboard globally consistent.

Counters must have explicit sampled window/cap/truncation and observed_at; no unconditional full-table counts, all native Orders per refresh, unlimited event arrays or per-row detail hydration. `driver-payments/attention` limits rows but executes per-payment consistency SQL: not a cheap global count. Settlement detail arrays and Order-finance exceptions/history can grow: expose bounded owner summary/timeline ports rather than copy entire detail results into every card. Existing offset lists may remain in their own screens; M23 additions should not amplify their cost.

No materialized operations-state table is justified by present evidence. Add a targeted index only if a specific approved M23 query requires it and its plan can be inspected during implementation verification; no blanket index migration or performance overhaul. Safe short-lived caching must not cache positive authorization or reveal stale revoked data; initial MVP can omit shared response caching entirely and use private/no-store.

## 31–32. Admin information architecture and reuse

Keep `/` as a small launchpad or link it to `/admin/operations`; do not replace the working finance consoles. Recommended destinations: Operations overview; Orders (exact lookup/bounded attention); Deliveries/dispatch attention; existing Merchant applications; existing Drivers; Finance links (adjustments, commissions, settlements, driver finance); System link (notification ops plus bounded worker diagnostics). Attention is a view/tab over these sources, not a separate support product.

Reuse existing `application-layout`, operational tables/filters, confirmation/reason forms, actor resource refresh/error patterns and money formatting. Existing UI to keep: merchant review/details/private document downloads; driver review/details; zones; compliance; financial adjustments; commission history/publication; settlement list/detail/action/evidence; driver finance; notifications. Route spec `/admin/refunds` does not require duplicating `/admin/financial-adjustments`. `/admin/reports` does not authorize BI. `/admin/audit` can be contextual rather than universal. No generic nav redesign, public support CRM or cross-role shell rewrite.

## 33. M25 debt explicitly excluded

Evidence: M8-E, M9-C/E, M10-D/E/G, M11-E, M12-D, M13-D, M14-D, M15-D, M16-D and M18 checkout-hardening handoffs.

- pg client.query concurrency deprecation and connection/pool hardening.
- Native checkout workflow profiling; prior measured32.696s prepare, advisory-lock/global scheduling/merchant serialization throughput.
- Windows filesystem/Next HMR and generic Playwright/verifier performance cleanup.
- Broad load/stress tests, backlog/retention/archive scaling, sustained abuse/ingress budgets, clock/secret rotation and real process-kill/lost-commit fault drills.
- GPS authenticity/fairness/large candidate pool and Redis resilience tuning.
- Production metrics/alerts/APM/observability stack and broad DB/index tuning.
- Privileged native mutation coordination beyond the concrete new M23 authority boundary.

M23 must still bound its own queries and preserve fail-closed correctness; M25 is not permission to ship an unbounded overview or an authorization bypass. The earlier role/MFA governance deferral must be explicitly decided in A rather than silently reclassified as performance debt.

## 34. Post-MVP / separately approved scope

No CRM, ticketing, case assignment/SLA engine, generic workflow engine, unrestricted notes, fraud tooling, BI, automated bank/payment rails, marketing, customer PII global search, new notification mappings/channels, source adjudication missing from M18/M19, manual payout rewrite, or generic override framework. Do not treat any of these as prerequisite infrastructure for a read overview.

## 35. Objective closure criteria

1. Operators with explicit grants identify relevant current attention from bounded authoritative projections; inaccessible categories disclose no records/counts and unavailable categories are not shown as empty.
2. Exact Order/checkout/Delivery inspection explains source state, related references, recorded evidence category and permitted destination, including recovery without a completed Order.
3. Existing review/configuration legacy access is narrowed according to the approved A capability matrix, with direct API denial and same-session effective revocation proof.
4. Financial/compliance/document/notification privacy and grants remain independent; no generic resolve/override/repair side effects from inspection.
5. Existing domain pages and their actual commands remain reachable and authoritative. Monitoring reports only supported observations, not invented worker success.
6. Contextual timeline and lookup are bounded and source-linked; no second exception/audit truth.
7. Targeted unit/API/real DB boundary tests, role-specific UI states and small real-API browser journeys are user-verified. Any confirmed Critical/High/Medium issue is fixed before closure.
8. Delivery rescue is either separately implemented/proven under an approved owner contract or explicitly accepted as deferred. Inspection alone cannot satisfy the historical rescue obligation.

## 36. Proposed slices and complexity challenge

| Slice | Deliverable / exit |
|---|---|
| M23-A | Documentation contract only: choose rescue disposition/MFA boundary, capability matrix, exact source categories, lookup fields, diagnostic DTOs, health unknown semantics, no work-item/notes policy and closure |
| M23-B | Narrow existing owner authorization plus new bounded pure-read owner ports/overview federation/exact lookup/contextual timeline/health adapters. No new business transitions. Prove API/direct service boundaries and no GET side effects |
| M23-C | Small admin overview/attention/Order/Delivery UX and contextual links, reuse domain tools. Loading/empty/forbidden/unavailable/refresh, safe statuses and responsive desktop operational layout |
| M23-D | Focused real API/privacy/revocation/role acceptance and at most a few purpose-specific browser journeys; user-run builds/checks, final security review and closure |

Five slices are not intrinsically needed. Three could work if B combines scoped authorization/projections and C combines UX/final acceptance, but the native-User governance surface spans several owners and warrants independent final acceptance. Four is materially smaller than rebuilding finance or dispatch. If rescue is approved, add one focused Delivery-owned slice after A and before UX; do not hide it inside a dashboard implementation.

## 37. Largest implementation risk

An apparently read-only cross-domain console can accidentally become a **new authority** through implicit finance access, raw evidence aggregation, actor impersonation or side-effecting reads. Recovery labels are especially dangerous: unknown is not failed, historical is not payable, physical return is not refund, notification acceptance is not receipt, and a missing native result is not authorization to write again.

## 38. Genuine unresolved decisions for A

1. **Rescue:** approve inspect/escalate-only with explicit deferral, or specify and approve a new narrowly bounded Delivery rescue primitive. The repo explicitly assigns controlled rescue to M23, but provides no safe general command or terminal/capacity policy.
2. **Legacy platform grants:** approve proposed separation and deployment allowlists; identify who receives read/manage/document/config grants. No default grant-all migration.
3. **MFA/governance:** choose launch control/integration owner and prerequisite; not implemented or proven by current native session handling. Current audit does not authorize an auth redesign.
4. **Operational health:** accept truthful enabled/backlog/unknown where heartbeat is absent (recommended), or approve narrowly persisted telemetry rather than require fabricated last-success.

No need to reopen approved commission/refund/credit/settlement/driver earning/notification policies. Assignment, notes, financial adjudication and support CRM are recommended out, not hidden implementation blockers.

## 39–40. Size and recommended M23-A decisions

Yes, M23 can be materially smaller than M18–M22: most action forms, finance projections and notification health already exist. Freeze A around (a) explicit platform authority, (b) bounded diagnostic discovery and exact context, (c) links into existing owner tools, (d) truthful limited health, (e) contextual audit, and (f) focused API/browser acceptance. No new persistent work-item model, generic management grant or new repair API. Approve the four decisions above before implementation.

## Verification and files changed

Only `milestones/M23_OPERATIONS_ARCHITECTURE_AUDIT.md` is added. No production files, tests, schema/migrations, environment or dependencies changed. No verification, infrastructure or database command was run. Short source/document inspection only. No runtime/live database state or queue counts are claimed. No commit.

**Commands for user to run: none for this documentation-only audit.** Review/approve the M23-A scope and unresolved policy decisions first. No M23-A contract or implementation has been started.
