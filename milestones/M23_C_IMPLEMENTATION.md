# M23-C — controlled dispatch rescue and operational UX

**M23-C complete and user-verified.** The user also confirmed the targeted C rescue regression passed during final M23-D verification on **2026-11-07 (Africa/Johannesburg)**. Final direct API and exactly three browser journeys passed in D; see [M23_D_ACCEPTANCE.md](M23_D_ACCEPTANCE.md). M23 is complete and verified. Codex did not run verification, commit or merge; M24/M25 work remains untouched.

## Ownership, admission and locking

Medusa 2.18 native Order/Cart/User/Auth and native fulfillment readback remain authoritative. Rescue is a DispatchService command, not a native commercial mutation or second offer engine. `rescueDeliveryWorkflow` has one owner-transaction step; no compensation erases a committed search after a lost response.

Strict input follows frozen A: request_id (existing resource-ID validation, at most 100 characters), expected_revision, expected_generation, expected_status=ATTENTION_REQUIRED, reason_code=RETRY_DISPATCH_SEARCH, confirmed=true. Positive int32-safe revision/generation tokens only. Unknown fields, driver/mode/status/timing/capacity overrides and notes are rejected. Both DELIVERY_OPERATIONS_VIEW and DELIVERY_RESCUE are required independently, before target work and again at mutation admission, with real native User readback. No session/browser authority cache.

The shared B owner precheck now additionally requires immutable closure audit evidence for historical commitments. Only previously started, never-assigned ATTENTION_REQUIRED searches with POOL_EXHAUSTED, SEARCH_ENDED or SEARCH_UNAVAILABLE are candidates. Missing bindings/history, any active or previously assigned commitment, compensation snapshot, pickup/native-operation designation, handoff, recipient-compliance evidence, completion or return evidence denies. Expired-but-still-OFFERED is active; rescue does not expire it.

Within admission, `dispatchReadiness` revalidates the actual Picking/M10/native commercial relationships, current serviceability/configuration/scheduling, no native fulfillment and immutable restricted truth. Rescue uses an existing-document-only branch: absent retained restricted invoice evidence rejects before native services; retained evidence still undergoes the original supply/document validation. Normal callers retain their existing ensure behavior by default. Missing/inconsistent/unavailable readback never grants admission. No doorstep recipient verification is added before dispatch.

Exact lock order: request-identity advisory lock (rescue commands only) → dispatch_work insertion/fence → merchant → OrderOperation → picking session → Delivery → stable history/readiness/configuration share reads. No driver/profile/availability lock is acquired by rescue. The work fence matches `DispatchOrchestrator.runBatch`; work is never locked late while holding merchant/Delivery. Request identity is globally fenced to serialize changed-target reuse as well. Existing normal driver paths take merchant before driver/availability and Delivery, so merchant serialization prevents a reverse driver-lock cycle. `ensure` finishes its merchant transaction before its separate work insertion.

Eligible attention and an actionable active offer cannot coexist under existing deferred consistency. If a valid offer/assignment is authoritative first, rescue rejects. If rescue reopens first, a historical offer's generation/closed state cannot satisfy normal acceptance. A normal candidate operation that revalidates after reopening may create a new-generation offer; it is not allowed to revive the old offer.

## Migration and atomic evidence

Forward migration: `Migration20261114120000.ts`. Earlier migrations are unchanged.

Previous bounds found in Migration20261019000000: generation in (0,1), generation/status coupling, and frozen generation-1 fields. Migration20261020000000 permits generation-0 attention through `delivery_generation_state`. M16/M17 extend `gospaza_dispatch_guard` terminal and commitment protection. C keeps those extensions and replaces only verified source anchors, failing if the installed guard differs unexpectedly.

Changes:

- Replace the old generation 0/1 bound and `delivery_generation_state` with generation 0's existing unstarted states and positive started generations.
- Freeze fields against the current generation rather than literal 1. Only a matching safe rescue receipt permits attention→SEARCHING and exactly g+1.
- New `delivery_rescue_command`: immutable request/actor/target fingerprint, prior generation/revision/reason, resulting generation/revision/configuration/mode, structured reason and database timestamp. Request identity unique globally; Delivery/prior-generation, Delivery/new-generation and Delivery/prior-revision unique.
- Deferred audit FK uses existing `(target_type,target_id,revision)` identity; deferred work FK binds the Delivery's existing scheduling obligation.
- Immediate guard rejects unsupported generation changes and initial inserts above generation 1, preserves receipt immutability, validates source state and rejects naked SQL generation changes.
- Pure SQL transition predicate binds current mode/configuration/initial path, unchanged restricted truth, no custody/assignment/native-operation evidence and historical closure audit. Nullable predicates fail closed.
- Deferred receipt/transition checks require the exact user `SEARCH_REOPENED` audit and due work at the result revision. SQL functions and triggers each have their own top-level addSql call, named dollar quotes and terminated PL/pgSQL blocks.

Unchanged: `dispatch_one_driver_commitment`, `dispatch_one_delivery_commitment`, `unique(delivery_id,generation,driver_profile_id)`, immutable commitment identity, existing capacity/affiliation/assignment/terminal constraints. Existing generation-1 rows remain valid. No destructive down migration; historical command evidence cannot be erased.

Service admission computes the maximum of current Delivery generation and persisted commitment generations while locked; future/inconsistent history denies. Existing receipt/transition guards prevent the current generation falling behind committed receipt history. Every subsequent independently stranded generation can be explicitly rescued again; there is no lifetime-one cap or automatic rescue loop.

Receipt, Delivery revision/generation, `SEARCH_REOPENED` audit and dispatch_work's due time/revision/scan reset commit together. Failure rolls them all back. Rescue neither reserves nor releases driver capacity, writes compensation, chooses a driver, creates a commitment, mutates finance/inventory, nor performs a native fulfillment workflow.

## Replay and normal dispatch

Exact authorized replay reads the original receipt before checking current eligibility; it works after offers, assignment or later generation progress. Changed actor/target/input under the same request identity conflicts. Different identities racing the same source revision yield one transition and a stale loser. No arbitrary rejected promise counts as a safe loser in the verifier.

`beginSearch` is shared by ordinary initial start and rescue. It uses the existing policy's timing and current mode: MERCHANT_ONLY/HYBRID initially MERCHANT, PLATFORM_ONLY initially PLATFORM. Rescue atomically makes normal work due. Existing candidate selection, merchant-first fallback, offer/accept, capacity and M21 compensation admission remain owners of subsequent work. Exhaustion remains attention; it never triggers another rescue automatically.

No M22 changes or direct notification intent creation. Normal generation/offer identities continue to feed existing discovery.

## API, projections and UX

One new POST: `/admin/gospaza/operations/deliveries/:id/rescue`. B's diagnostic GETs remain pure. Strict input is validated before workflow history can retain unknown fields, and revalidated by the owner. No-store and bounded domain/conflict/unavailable responses; no raw SQL error escapes the HTTP response. Receipt result explicitly describes recorded SEARCHING state at that command, not a claim of current assignment.

Small B projection extensions are necessary for presentation: overview navigation flags for authorized Orders/Deliveries, and direct Delivery `can_rescue`. They convey current permission, not admission or financial state. Existing B exact-key verifier was updated for this intentional safe field.

Admin home links to Operations Overview. New routes inside existing shell:

- `/admin/operations`: bounded attention sections, partial unavailable vs empty, authorized existing domain-tool links and exact-ID lookup.
- `/admin/operations/attention`: authorized source selector, independent source pages/cursors and current state/reason/time/reference/context.
- `/admin/orders` and `/admin/orders/:id`: exact lookup and safe Order/store/checkout/picking sections, separately authorized Delivery/finance context, independent timelines.
- `/admin/dispatch/:id`: generation/revision/state/mode/path, driver-safe commitment reference, timing, pickup/completion/return state, attention, timeline and persisted rescue preview.
- `/admin/operations/health`: bounded due/pending observations, enabled/unknown flags, NOT_INSTRUMENTED execution health and persisted M22 observations. No invented heartbeat or green health badge.

Rescue control requires backend can_rescue and eligible precheck. Review shows the source generation, attention reason and structured action; explains that it opens the next search, selects no driver and completes no delivery. POST success and conflict always refetch authoritative diagnostics. No optimistic generation/assignment is fabricated. Uncertain response keeps the original command identity; only an explicit original-request check can resubmit it, never an automatic or new-identity retry. Denial removes the draft. Loading/empty/error/partial/stale states use existing admin/session/resource patterns, responsive tables and exact shared money formatting.

No acknowledge/assign/resolve/close/note controls, financial mutations, generic repair, driver assignment or worker control. Raw evidence, bank/provider details, documents, OTPs, GPS, recipient observations and customer PII remain excluded. React text rendering, finite exact-ID selectors and backend-produced internal links avoid new HTML/URL injection paths.

## Verification added and its limits

- `delivery-rescue.test.ts`: strict command/authority, approved reasons, narrow safety and sequential generation/overflow policy.
- `dispatch-rescue-document.test.ts`: missing retained evidence rejects before native services/writes in existing-only mode.
- `dispatch-rescue-http.test.ts`: unknown/private request fields are rejected before workflow or domain dependencies, with sanitized response.
- Admin `operations.test.ts`: overview/attention empty/unavailable, Order/Delivery authorization-sensitive sections, rescue review, timeline and truthful health.
- Admin `operations-rescue.test.ts`: success/conflict readback and uncertain-result behavior without automatic resubmission.
- API-client operations test: preserved GETs plus the one explicit typed POST.
- `verify-dispatch-rescue.ts`: real PostgreSQL, independent scopes/connections, copied installed M15/rescue checks/unique indexes/FKs/guards and real native User/Auth identity checks. Tests generations 1→2→3, historical preservation, same/different request races, replay after offers, changed replay/target, native-read unavailability, current grants, deferred audit failure at COMMIT/rollback, naked SQL denial, partial custody/terminal denials, worker/configuration/acceptance races, no rescue capacity mutation, normal generation offers and stale accept denial.
- `verify-dispatch-generation.ts`: smallest targeted normal M15 regression, using the same private fixture infrastructure and normal offer/decide methods: stale historical offer, current-generation offer identity, competing Deliveries for one driver, one active commitment and idempotent concurrent acceptance. Existing `dispatch-policy.test.ts` covers all mode/path/timing branches.

Important boundary: the PG verifier's native Order/Cart/graph and location read ports are controlled fixtures. Upstream M8–M13 tables are private input shapes, including deliberately incomplete fail-closed cases; full upstream lifecycle constraints and all M16/M17 triggers are not re-proven here. Dispatch/rescue core constraints and installed guard functions are real and enforced. It is not a live paid-checkout/native integration proof. No public financial/Delivery history changes; only its own native synthetic User/Auth identities and generated schema are removed. Final full API/native/browser/privacy acceptance belongs to D.

M16/M17 shared readiness/document behavior changed only by the opt-in existing-only branch and preserved guard anchors. Run the focused existing pickup/handoff/recipient policy tests and the new missing-document test. No broad M16/M17 suite is required for this pre-fulfillment slice.

Static security review: SOURCE authenticated User + strict tokens → current dual grants → owner locks/persisted and fresh native admission → atomic receipt/search/audit/work → bounded DTO/refetch. Credible risks addressed: stale admission, changed replay, generation/assignment race, late work lock inversion, invoice creation during rescue, lost-response duplicate rescue, field injection and cross-domain evidence leakage. No confirmed unresolved Critical/High/Medium finding was identified statically. C runtime proof and its final targeted regression are user-verified; completed D final API/browser acceptance is recorded separately in [M23_D_ACCEPTANCE.md](M23_D_ACCEPTANCE.md).

## Material files

Backend production: `lib/dispatch-service.ts`, `lib/dispatch-readiness.ts`, `lib/restricted-delivery-document.ts`, `lib/operations-service.ts`, `modules/marketplace/operations-read.ts`, new `modules/marketplace/delivery-rescue-policy.ts`, new migration, new `workflows/rescue-delivery.ts`, new operations Delivery rescue route.

Frontend: admin `app/page.tsx`; new `operations-console.tsx`, `operations-presentation.tsx`, `operations-rescue.ts`; new Operations overview/attention/health, Orders index/detail and Dispatch detail pages.

Contracts/client: `packages/contracts/src/operations.ts`, `packages/api-client/src/operations.ts` and client test. Verification: backend package scripts, `scripts/operations-environment.ts`, `verify-operations.ts` intentional field assertion, new rescue/generation verifiers, backend rescue/document tests and admin presentation/readback tests. No dependencies added.

## Commands for user to run

Repository root, Windows PowerShell, one line at a time; stop on every failure. Existing isolated database only; no database creation/drop. The operations launcher reuses shared isolation and preserves explicit `_test` selection, Redis /1, NODE_ENV/APP_ENV=test, disabled financial/dispatch/pickup/handoff/notification workers. No verifier dev server or live email.

1. `pnpm run lint` — zero warnings/errors.
2. `pnpm run typecheck` — all workspaces pass.
3. `pnpm --filter @gospaza/backend exec tsx --test tests/delivery-rescue.test.ts tests/dispatch-rescue-document.test.ts tests/dispatch-rescue-http.test.ts tests/dispatch-policy.test.ts tests/operations-policy.test.ts tests/operations-boundary.test.ts` — focused rescue, mode and read-boundary tests pass.
4. `pnpm --filter @gospaza/admin exec tsx --tsconfig tsconfig.test.json --test tests/operations.test.ts tests/operations-rescue.test.ts` — presentation and readback tests pass. The test-only configuration uses the automatic React JSX runtime; the Next.js production configuration continues to preserve JSX for its compiler.
5. `pnpm --filter @gospaza/api-client exec tsx --test tests/operations.test.ts` — typed client GET/POST tests pass.
6. `pnpm --filter @gospaza/backend exec tsx --test tests/pickup-policy.test.ts tests/handoff-policy.test.ts tests/recipient-policy.test.ts` — smallest affected custody/compliance policy regressions pass.
7. `pnpm --filter @gospaza/backend run build` — backend build succeeds.
8. `pnpm --filter @gospaza/admin run build` — admin build succeeds.
9. `pnpm --filter @gospaza/backend run test:operations-environment -- gospaza_m18_c2b_test migrate` — M23-C forward migration applies on the existing isolated database.
10. `pnpm --filter @gospaza/backend run test:operations-environment -- gospaza_m18_c2b_test rescue` — PG rescue verifier completes with its explicit controlled-readback proof message.
11. `pnpm --filter @gospaza/backend run test:operations-environment -- gospaza_m18_c2b_test dispatch-regression` — targeted M15 generation/old-offer/commitment/capacity proof completes.

No command has been executed by Codex. No broad historical verifier or Playwright command is part of this sequence. Runtime syntax/types/query/latency remain unverified until user output returns.

## D handoff

D alone owns final direct API/BOLA/BFLA, same-session revocation, pure-read, rescue capability/race/replay, native integration/privacy, browser/security acceptance and M23 closure. It should use real fixture-owned domain/native state, not mistake C's controlled commerce read ports for a completed checkout proof. C does not implement D or later milestones.
