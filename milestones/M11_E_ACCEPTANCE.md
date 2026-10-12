# M11-E acceptance and security review

Status: M11-A–D are user-verified. M11-E static review and coverage additions are complete; new verification has NOT been executed. No production defect was identified in the reviewed M11 paths. No production code, schema, migration, dependency or financial behavior changed.

## Trust-boundary review

| SOURCE | TRANSFORMATION | TRUST BOUNDARY | SINK / evidence |
| --- | --- | --- | --- |
| Merchant session | merchantBoundary + applicantIdentity + resolveTenant | Merchant actor; active membership, active merchant and approved application; capability rechecked after merchant lock | Tenant-scoped operation/native projection or atomic decision. Wrong actor/PICKER/inactive/removed members tested over HTTP. Lock-wait revocation/demotion tested with real transactions. |
| Native Order ID | resourceId + tenant-filtered M10 handoff | SUCCEEDED terminal receipt, COMPLETED attempt, committed capacity; historical audited rejection is a narrowly defined exception | ensure/materialize, native identity readback and allowlisted DTO. Foreign/unknown IDs have matching 404 bodies; operation IDs are not alternate selectors. |
| Customer session/Order ID | native listOrders filtered by customer_id, then snapshot customer check | Native ownership AND durable M10 ownership, independent of current cart | Customer-only DTO; foreign known IDs cannot trigger repair. |
| List filters | strict schema; limit 1–100, offset 0–10000; allowlisted status | Tenant predicate precedes count/page/native reads/repair | Bounded page. Injected tenant/customer/fields filters rejected. No user-controlled repair cursor. |
| Decision payload | strict action schema; confirmed true; expected_revision comparison; bounded normalized reason | Tenant lock → current capability → owned operation lock → state/replay validation | One irreversible operation transition, one audit, and rejection-only capacity release in one PostgreSQL transaction. Actor/time are server-derived. |
| order.placed data | validate ID; ensure rereads durable M10 handoff | Event is only a hint, never authority | Same materialization/admission as repair/read. Duplicate delivery/ensure converges through locks and all-row uniqueness. |
| Browser action/URL | credentialed API client; explicit confirmation; read after conflict/uncertainty | Browser state cannot set operational authority | Terminal controls disappear; failed writes are not replayed; customer rejection copy does not claim refund. |

No credible critical/high/medium security vulnerability was identified. This is a bounded static review with executable tests awaiting user execution, not a claim of exhaustive penetration testing.

## Acceptance coverage matrix

Paths below are relative to repository root. O = apps/backend/src/scripts/verify-order-operations.ts; D = apps/backend/src/scripts/verify-order-decisions.ts; P = apps/backend/tests/order-operations.test.ts and order-decisions.test.ts; B = tests/browser/orders.spec.ts; C = packages/api-client/tests/orders.test.ts.

| Invariant / attack | Evidence | Scope / limitation |
| --- | --- | --- |
| One authoritative native Order → one operation | O concurrent ensure, duplicate events, unique insert rejection, fresh service instance; migration all-row uniqueness | Real DB/native Orders; fresh service proves no instance-local identity, not an OS crash test. |
| Non-M10, partial, RECOVERY_REQUIRED excluded | O synthetic native Order with forged metadata; early event, ambiguous completion reference; P invalid receipts | Real API/DB plus parser tests. |
| Late-payment/expired orders excluded | Composed M10 reconciliation verifier proves late capture makes no Order/completion; candidates require terminal success | No fabricated successful M11 handoff for compensation. |
| Merchant/store authority | O cross-merchant list/count/detail, hostile IDs/filters, immutable identity | Native metadata never authorizes. |
| Foreign read repair cannot provision | O new foreign missing-operation detail/list case; existing foreign customer read-repair case | Real HTTP and DB absence readback. |
| OWNER/MANAGER allowed; PICKER/wrong actor/inactive denied | O/D real sessions; P capabilities | No UI-only authorization claim. |
| Revocation/demotion during wait | D observes actual lock query then commits permission change | Real service/DB concurrency; endpoint role denial separately tested over HTTP. |
| Duplicate accepts/rejects and stale/opposite/reason-modified replay | D simultaneous HTTP and retained operation/audit/time comparison; P | Same payload returns original result, incompatible payload conflicts. |
| Accept vs reject, two authorized employees | D existing OWNER/MANAGER race plus new two-MANAGER HTTP race | Exactly one 200/409 winner, one audit, matching capacity and unchanged native commerce. |
| Atomic decision/audit/capacity | D existing pre-release fault plus new deferred commit fault | Rollback leaves pending, zero audit and byte-equivalent original reservation; successful retry then works. |
| ACCEPTED retains capacity; REJECTED releases once | D occupancy readback, actual denied-then-successful customer slot acquisition, replay unchanged | Existing M9 occupancy owner reused; no counter duplication. |
| Audit identity/time immutable | D forged fields, actor assertions, timestamp equality and rejected audit rewrite | Database administrator deleting history is outside API threat model. |
| Rejected cannot become picking-eligible | D terminal rewrite/opposite action fails; P terminal lifecycle | M12 picking does not exist and was not added. |
| Native commercial ownership retained | D snapshots of native Order, Payment/Capture/Refund and inventory reservations before/after | Pinned cancelOrderWorkflow refunds and deletes reservations; M11 never invokes it. |
| Native bypass | O/D native admin cancellation unauthorized, native store Order read blocked, generic merchant POST absent | Real HTTP. Existing M10 native payment/cart/completion bypass coverage retained. |
| DTO privacy and native totals | O native comparison and excluded fields; D staff reason omitted from customer | No provider/workflow/private storage data projected. |
| Customer isolation/forged state | O native/snapshot mismatch, foreign/unknown matching response, hostile query; B forged URL and foreign lookup | Real API ownership plus mocked UX. |
| Merchant acceptance UX | B list/filter/page/link; role controls; duplicate click; 409 refetch; response loss; terminal reload; focus/membership loss | Browser mocks prove presentation, not DB correctness. |
| Customer states/reload and no refund claim | B pending/accepted/rejected; reload/focus; staff reason and financial claims absent | C checks allowlisted payloads, credentials, safe errors and no retry. |
| Background repair | Static: fixed 50 keyset candidates, durable cursor with SKIP LOCKED, same ensure, wrap/revisit; O concurrent cursor skip | Normal whole-database sweep and actual process termination are not executed by this scoped fixture. Do not claim they were. |

## Changes in this slice

- Extended O with a second real MANAGER identity and a foreign missing-operation repair attack. Existing identity/fixture cleanup owns and removes the extra member/session.
- Extended D with two-MANAGER opposing HTTP decisions and post-release deferred-commit failure injection. Trigger/function names are unique and affect only the invocation's reservation; finally removes only those exact fixtures. No native table fault injection or cleanup expansion.
- Added playwright.m11.config.ts for Orders/checkout acceptance using only customer and merchant servers, inherited one-worker execution and unchanged timeouts. Root full-regression configuration remains unchanged.
- Updated milestone status and linked this report.

## Residual/deferred work

- M18: paid merchant rejection is financially unresolved; native inventory stays reserved. M11 never promises a refund or independent native cancellation.
- M12: picking admission must require ACCEPTED; no picking implementation/test is claimed here.
- M23: broader operational recovery/support tooling remains outside M11; no new admin override.
- M25: real process-kill/restart tests, repair-sweep monitoring/backlog/load tests and per-tenant lock contention. Cursor loop is fixed at 50 candidates but candidate query/total count cost can grow; no claim of constant-time queries or complete resource-exhaustion protection. Merchant lock protects decisions and may serialize slow native reads.
- Existing background repair is global by design and cannot be targeted by browser input. The verifier deliberately avoids scanning/provisioning unrelated local Orders merely to test a full sweep.
- Browser tests are mocked; real HTTP/DB/native evidence comes from O/D and their M10 prerequisites.

## User verification (repository root; stop on any failure)

### A. No development servers

Stop Next development processes before typecheck/build so generated .next output is not concurrently written. Do not delete generated output automatically.

1. pnpm run lint — no warnings/errors.
2. pnpm run typecheck — workspace typecheck passes.
3. pnpm --filter @gospaza/backend run test — policy/unit suite passes.
4. pnpm --filter @gospaza/api-client run test — client suite passes.
5. pnpm --filter @gospaza/backend run build — backend production build succeeds.
6. pnpm --filter @gospaza/merchant run build — merchant production build succeeds.
7. pnpm --filter @gospaza/customer run build — customer production build succeeds.

### B. PostgreSQL/Redis + backend only

No new migration is needed for E. Existing verified B/C migrations remain required. Use existing local test-mode Yoco configuration, with PAYMENT_RECONCILIATION_WORKER_ENABLED=false in both backend and verifier. Never use live payment credentials for fixtures.

1. pnpm --filter @gospaza/backend run dev — separate terminal; wait for port 9000 readiness.
2. pnpm --filter @gospaza/backend run test:order-decisions — includes order-operations, M10 reconciliation/checkout and M8 prerequisite assertions; all must pass. Separate duplicate runs of those nested suites are unnecessary.
3. pnpm --filter @gospaza/backend run test:team — membership/RBAC regression passes.
4. pnpm --filter @gospaza/backend run test:delivery-reservations — scheduling/capacity regression passes.

### C. Playwright-managed browser stack

Do not start pnpm dev separately. The targeted config starts customer and merchant only; the full config starts its four required frontends. Browser backend traffic is mocked.

1. pnpm exec playwright test --config=playwright.m11.config.ts tests/browser/orders.spec.ts — all M11 Order journeys pass.
2. pnpm exec playwright test --config=playwright.m11.config.ts tests/browser/checkout.spec.ts — M10 checkout regression passes.
3. pnpm run test:browser — complete browser regression passes.

Slow-filesystem warnings alone are not failures. Stop and inspect any failing test rather than adding timeouts/retries.

## Verdict

M11-E implementation is ready for user verification. M11 is ready for milestone commit/merge only after the above verification passes; Codex did not execute commands, commit or merge. No M12 functionality was started. Production behavior was unchanged by E.
