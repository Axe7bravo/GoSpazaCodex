# M13-D — Shortage Resolution Acceptance, Security & Regression

## Verdict and verification boundary

Acceptance implementation and static review are complete. Runtime acceptance is pending user verification of the additional assertions. M13-A through revised M13-C were reported user-verified. No commands, tests, builds, migrations, commits or merges were executed for this slice.

No confirmed production vulnerability or correctness defect was identified in the reviewed executable omission-only paths. Critical, high and medium findings: none identified. The changes strengthen acceptance evidence; they do not change production behavior, schema, routes, UI or dependencies.

The applicable contract is sections 19–21 of MILESTONE_M13_SUBSTITUTIONS.md. Sections 1–18 and their deferred replacement/inventory research remain unchanged.

## Security data flows

| Source | Transformation | Trust boundary | Sink / result |
|---|---|---|---|
| Customer cookie, native Order ID, preference and revision | Customer actor authentication; strict preference schema | Native customer ownership and immutable M10 customer binding, revalidated under merchant/operation lock | Owned preference only; default CONTACT_ME is not explicit consent; freeze prevents a different choice |
| Customer case ID, revision and confirmed flag | Strict omission schema requires literal true; case resolved through owned Order | Current session/line/generation and frozen preference re-read inside transaction | Server-derived missing quantity becomes terminal omission with authenticated customer audit |
| Merchant cookie, Order/line IDs and physical quantity | Membership-derived tenant and M4 capability; strict picking input | Merchant lock then membership revalidation, tenant-scoped operation, authoritative native readback, session/line locks and assignee check | Original physical picking only; terminal omission blocks picking into omitted units |
| Client-supplied merchant/customer/store, quantity, financial or provenance fields | Strict allowlists reject overposting | No browser claim replaces server relationships | HTTP 400 before a decision; foreign/unknown resources remain inaccessible |
| Browser reads and refreshes | DTO projection and client rendering | Backend remains authoritative for preference, shortage, revision and completion | No payment/workflow/inventory evidence in shortage DTO; no financial resolution claim |

Native customer ownership drift is tested through the supported Order module API on a fixture, then restored in finally. Both the former customer and the newly assigned customer are denied when native ownership and immutable M10 linkage disagree, including terminal replay.

## Coverage matrix

Paths below are repository-relative. Integration rows refer to apps/backend/src/scripts/verify-shortages.ts unless otherwise stated. Browser fixtures are UX evidence, not backend authorization evidence.

| Invariant | Existing / added executable evidence |
|---|---|
| Only ACCEPTED, IN_PROGRESS, short original lines | Existing pending/rejected/non-short/full-picked/completed admission checks; M12 verifier retains state/assignment checks |
| Effective default is CONTACT_ME, not consent | Existing exact default DTO and materialized frozen default with null chosen_at |
| Both preferences before freeze; immutable after freeze | Existing change/replay/freeze checks; added stale different-value revision rejection and unchanged preference readback |
| CONTACT_ME requires explicit consent | Added missing/false confirmation HTTP 400; wrong actor/anonymous HTTP 401; existing successful explicit consent |
| NO_SUBSTITUTION has prior authenticated provenance | Existing preference choice, automatic omission and frozen replay; strict forged provenance rejection; database freeze/provenance guards |
| Server quantity and stale generation protection | Existing P2→P3 generation change, stale consent409; forged quantity400; Q5/P3/O2 terminal evidence assertions |
| BOLA / known IDs / enumeration | Existing real foreign Order/line/case checks; added real OrderOperation, PickSession and PickLine IDs in wrong selectors, foreign/unknown merchant equality and ownership-drift checks |
| DTO minimization | Added strict customer shortage/preference DTO allowlists matching the shared production resolution projection |
| Atomic shortage creation/freeze | Added scoped audit-write fault: physical edit, preference, resolution and audit all roll back |
| Atomic omission/audit | Existing scoped CUSTOMER_OMITTED audit fault and unchanged pending readback |
| Atomic completion/audit | Added scoped COMPLETE audit fault: session stays IN_PROGRESS and terminal omission remains intact; normal retry succeeds |
| Duplicate admission / omission | Existing actual concurrent HTTP requests, identical results, one case and one customer decision event; database duplicate insertion rejected |
| Original-found wins | Existing original update first then stale omission409; no active case; ordinary completion succeeds |
| Omission wins | Existing terminal omission then original quantity increase409; added post-completion line mutation409 |
| Original update vs omission | Existing Promise.all HTTP race exactly one200/one409 and final P+O=Q |
| Preference vs freeze | Existing concurrent HTTP requests; resulting frozen preference and terminal/pending case must agree |
| Omission vs completion | Existing concurrent HTTP requests; unresolved completion cannot win; subsequent authoritative completion allowed |
| Reassignment and revocation | Existing concurrent reassignment/update, old assignee denied, new assignee preserves case; actual merchant-lock barrier with membership revoked before mutation acquires lock |
| Truthful completion | Existing physical P retained, shortage flag retained, O separate, unresolved blocks; exact P+O=Q; policy tests in apps/backend/tests/shortages.test.ts |
| Terminal state / audit integrity | Existing forbidden terminal state and audit rewrites; added financial_review_required cannot be cleared and exactly one completion event |
| No native commercial mutation | Existing before/after native Order, reservation, inventory level, Payment/Capture/Refund and fulfillment evidence for both consent paths |
| M18 evidence | Existing native order/line/completion reference and actor audit; added Q/P/missing, preference/fingerprint and completion-event assertions |
| Customer UX | Existing tests/browser/shortages.spec.ts: default/change/freeze, explicit consent, prior consent, stale state, focus/reload, outage/retry, foreign Order, out-of-order reads |
| Merchant/PICKER UX | Same suite: three roles, separate picked/omitted values, completion and reload immutability, reassignment and membership loss; existing picking/orders suites retained |
| Client boundaries | Existing packages/api-client/tests/shortages.test.ts: actor route contracts and allowed request bodies |

Fault injection uses scoped query listeners tied to fixture operation/session/case IDs. It tests real transaction rollback; concurrency cases still use concurrent requests or a real database lock barrier. No arbitrary waits, retries, assertion relaxation or broader cleanup were added.

## Locking and completion assessment

Merchant-facing mutations enter the existing merchant lock, revalidate membership/capability, lock tenant-scoped OrderOperation, then PickSession, ordered PickLine rows and active resolutions. Customer decisions use the same merchant/operation boundary after customer ownership resolution and revalidation. Shortage revisions and physical quantities are re-read before mutation.

Preference updates before a picking session exists lock operation then preference; there are no session/line rows to lock. First-shortage creation can insert the new resolution after freezing preference. The shared merchant/operation boundary excludes competing same-order M12/M13 transactions, so this does not introduce an incompatible reachable lock order.

The completion predicate requires safe integer Q/P/O and exactly O=Q-P for every original line. Only current terminal omission contributes O. It does not rewrite P, clear shortage to invent completion, or count unresolved consent. Database guards independently enforce terminal integrity and audited completion.

## Native ownership and financial handoff

Executable production shortage paths only read Medusa for authority/evidence. They contain no native inventory, reservation, Order-line/total, Payment, Capture, Refund, Store Credit or Fulfillment mutation. GoSpaza writes are operational preference/resolution/picking/audit records. The verifier's supported inventory setup and native customer-drift manipulation are fixture-only and outside native-immutability comparisons.

The runtime native baseline covers Order, inventory/reservations, payment/captures/refunds and fulfillment. Store Credit non-mutation is supported by static call-path inspection, not a separately seeded Store Credit runtime scenario; do not describe it as such.

M18 receives durable native Order/line IDs, Q/P/missing evidence, source-line fingerprint, immutable checkout-completion reference to the original commercial snapshot, frozen preference/provenance, explicit CONTACT_ME decision actor/time where applicable, resolution timestamps, linked picking completion event and financial_review_required. This is the approved reference-based handoff, not a new monetary allocation or refund entitlement. M18 must independently establish compensation eligibility, allocation and idempotency.

Customer and merchant copy distinguish operational omission from financial handling. There is no refund-due, credit-due, adjusted-total or reversed-payment claim.

## Deferred scope and residual risks

- Replacement selection/proposals/reservations/physical picking, selling-unit classification runtime, inventory compatibility patch and native Order editing remain excluded. Deferred sections 1–18 are preserved.
- M18 financial resolution, M14 drivers and later dispatch/delivery/compliance/notifications are not implemented.
- M25: merchant-wide serialization and native readback have throughput costs. Measure lock contention before optimization.
- M25 defence in depth: endpoint-specific abuse budgets, lock-wait metrics and operational alerting; no proven exploit is asserted from these recommendations.
- Authorized external native-admin mutations do not join GoSpaza merchant locks. Native/M10 inconsistency fails closed on readback; broader cross-system operational recovery remains future hardening.
- Added assertions have not been executed by Codex. Static review is not a substitute for the real-database and browser verification below.

## Files changed in M13-D

- apps/backend/src/scripts/verify-shortages.ts
- milestones/M13_D_ACCEPTANCE.md

No schema/migration, production API/service/workflow, UI or dependency change.

## Commands for user to run

Working directory for every command: D:/Programming_projects/GoSpazaCodex. Run in the listed order. Stop on every failure and retain the innermost diagnostic. All commands are single lines.

### A. NO DEV SERVERS

Stop Next dev processes before typecheck/build so generated .next state is not concurrently rewritten.

| Command | Purpose / expected result | Stop on failure |
|---|---|---|
| pnpm run lint | No lint errors or warnings | Yes |
| pnpm run typecheck | All workspace typechecks pass | Yes |
| pnpm --filter @gospaza/backend run test | Existing backend unit/policy tests pass | Yes |
| pnpm --filter @gospaza/api-client run test | Client contract tests pass | Yes |
| pnpm --filter @gospaza/backend run build | Backend production build succeeds | Yes |
| pnpm --filter @gospaza/customer run build | Customer production build succeeds | Yes |
| pnpm --filter @gospaza/merchant run build | Merchant production build succeeds | Yes |

### B. POSTGRES/REDIS + BACKEND ONLY

Use the established local verification configuration, never live payment credentials. Keep PAYMENT_RECONCILIATION_WORKER_ENABLED=false in backend and verifier environments as required by the existing fixture harness. Wait for the backend to be ready. No Next apps are required.

| Command | Purpose / expected result | Stop on failure |
|---|---|---|
| pnpm --filter @gospaza/backend run test:picking | M12 real-database/API/concurrency regression succeeds | Yes |
| pnpm --filter @gospaza/backend run test:shortages | Existing and added shortage security/transaction/concurrency assertions succeed | Yes |

These verifiers compose the existing OrderOperations/payment-reconciliation/checkout/cart prerequisites. Do not repeat those expensive prerequisite commands separately. No migration command is needed for this slice; there is no migration change and M13-B was reported verified.

### C. PLAYWRIGHT-MANAGED CUSTOMER + MERCHANT STACK

Use the existing isolated browser fixtures; the M13 config starts only customer and merchant. Avoid competing manually started Next dev processes.

| Command | Purpose / expected result | Stop on failure |
|---|---|---|
| pnpm exec playwright test --config=playwright.m13.config.ts tests/browser/shortages.spec.ts | All shortage UX acceptance cases pass | Yes |
| pnpm exec playwright test --config=playwright.m13.config.ts tests/browser/picking.spec.ts tests/browser/orders.spec.ts | Relevant M12/M11 browser regressions pass | Yes |

An unrelated driver/admin full-browser rerun is not added: this slice changes only backend verification assertions and this report. Existing M10–M13 production and browser coverage is preserved.

M13 is ready for milestone commit/merge only after these user-run checks pass. No commit/merge was performed and M14 was not started.
