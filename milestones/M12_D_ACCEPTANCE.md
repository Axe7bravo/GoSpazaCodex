# M12-D — Picking acceptance and security

## Verdict and verification status

M12-D static review and missing acceptance coverage are implemented. No credible production vulnerability or functional defect was established; no production code, schema, API, capability, migration or dependency changed. This is **not a runtime pass**. M12-A/B/C were reported user-verified. The additions below require user verification before M12 commit/merge.

The review used the milestone, medusa-first-architecture and gospaza-security-review skills. No commands, tests, builds, migrations, servers, commits or merges were run by Codex. M13 has not started.

## Authority and security traces

| SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK | Finding / executable evidence |
| --- | --- |
| Session cookie + native Order selector → merchant actor boundary; post-lock active membership/capability resolution → tenant-scoped OrderOperation + successful M10 handoff + ACCEPTED + COMMITTED → safe picking projection/session | No metadata/browser tenant authority. Real HTTP wrong actors, known foreign/unknown IDs, pending/rejected/recovery admission denial. |
| Native Order → supported readOperationalOrder validation + nativeOrderQuantity + complete line fingerprint → authoritative native identity/quantity compared with operational baseline → picking DTO/transition | No parallel commercial Order. Actual native quantity change through Medusa 2.18.0 updateOrderLineItems is rejected; missing operational line blocks completion. |
| Claim/line/reassign/complete body → strict pickingCommand schemas → server assignment/revision/native quantity → atomic custom transaction | Forged tenant, assignee, state, price and timestamps rejected. Target member is a selector revalidated in the locked tenant, never authority. |
| Concurrent employee/device actions → merchant → owned operation → session → ordered lines → revision and append-only event → one accepted effect | Actual concurrent HTTP calls; no mutex, sleeps or retry masking. Exact replay returns current projection without another event. |
| Supervisor target ID → same-tenant ACTIVE membership + picking capability → explicit reassignment → unchanged progress/new assignee/audit | Foreign/inactive/missing target denied; PICKER cannot reassign; previous assignee cannot edit/complete. All three current active roles have picking capability, so a fictitious active capabilityless role is not introduced for testing. |
| UI URL/form/focus → shared API client → backend DTO/error/refetch → controls | Client strips authority fields and never automatically replays mutation. Browser mocks prove UX only, not authorization or database concurrency. |

Severity: Critical, High, Medium and Low vulnerabilities: **none identified**. No claim that static review rules out every vulnerability. Informational and hardening limitations appear below.

Injection: identifiers, quantity and pagination are validated; Knex parameter binding is used. Status filters are allowlisted. No user-controlled outbound request or file path is introduced. Picking DTOs omit customer contact/address, payment, workflow, inventory and commercial price metadata. Errors use safe domain/client messages. No new secret logging was found. Merchant reads use private/no-store responses.

## Acceptance coverage matrix

Backend integration reference **V** = apps/backend/src/scripts/verify-picking.ts, command test:picking. It composes the existing M11-B and M10 fixture/prerequisite lifecycle. Policy **P** = apps/backend/tests/picking.test.ts. Client **C** = packages/api-client/tests/picking.test.ts. Browser **B** = tests/browser/picking.spec.ts.

| Invariant / attack | Evidence | M12-D addition |
| --- | --- | --- |
| ACCEPTED + terminal M10 + COMMITTED admission; pending/rejected/recovery excluded | V admission HTTP checks; service load and DB session guard; M11 prerequisite checks | Existing retained |
| One session per operation; one line per native line | V concurrent first claim + exact retry; DB uniqueness | Exact native/stored line-ID set equality and real 23505 duplicate-session/line insertion checks |
| Tenant-safe bounded queue/detail | V foreign queue, pagination/status filters, foreign detail; P bounded input | Foreign/unknown detail bodies explicitly compared |
| Cross-merchant mutation BOLA / hostile operation, session and line selectors | V known foreign claim/update and actual other-order native line | Foreign/unknown complete/reassign equivalence; internal IDs rejected on both routes |
| Wrong actors, forged identity/state, PICKER decision denial | V wrong-cookie claim, strict bodies; P capability matrix | PICKER M11 reject denial; complete mass assignment; timestamp/actor over-posting |
| Only active assignee edits/completes | V loser line denial; reassignment invalidates prior editor; active membership rechecked under lock | Non-assignee completion denial |
| Whole, bounded absolute quantity | V negative/fraction/string/null/overflow/over-order; P NaN/Infinity (not representable in valid JSON), bounds | Existing retained |
| Shortage/partial quantity blocks completion | V shortage and incomplete finish; B shortage flow | Clearing shortage at zero still returns 409; browser clearing marker at partial quantity leaves Complete disabled |
| Claim race, same-assignee retry | V concurrent different actors then identical claim requests | Stale claim after completion returns unchanged terminal projection/revision with no extra event |
| Same-line conflicting/identical writes, stale revision | V concurrent writes, one winner, exact replay/event count; B stale actions | Existing retained |
| Line vs complete; reassignment vs complete | V actual concurrent requests, authoritative final session and all quantities | Existing retained |
| Reassignment vs line update | V concurrent HTTP handover and old-assignee update | Exactly one success, revision advances once; assert precise final assignee/progress for either ordering |
| Supervisor-only explicit reassignment preserves progress | V OWNER and MANAGER handover, foreign/inactive target denial; B both roles and peer focus | Existing retained |
| Revocation while waiting and while portal open | V merchant-lock revocation barrier; B membership-loss and old-assignee focus tests | Existing retained |
| Completed immutable; no reopen | V line/reassign and DB edits rejected; exact replay is acknowledged without effects; B reload | Existing retained |
| Missing PickLine / changed native quantity fail closed | Service cardinality, fingerprint and native signature validation; P fingerprint cases | Dedicated fixture deletion denies complete; supported Medusa native quantity edit denies complete/update with unchanged session |
| State, revision, timestamp and audit atomic | V deferred audit constraint rejects unaudited writes | Inject audit INSERT failure after real writes for CLAIM, LINE, REASSIGN, COMPLETE; compare all session/line/event rows before/after |
| Native commerce unchanged by picking | V native Order/payment/captures/refunds/inventory levels/reservations/fulfillment snapshots | Additional native snapshot around audit-failure paths |
| Native API bypass | V merchant native admin fulfillment 401 and customer store Order 404; M11 prerequisite admin cancellation 401 | Existing retained; no new native mutation proxy |
| Safe projection / no sensitive metadata | V forbidden DTO keys; C safe errors and payload allowlists | Existing retained |
| UI queue, role visibility, claim, peer read-only, explicit reassign/complete, stale refetch, uncertain write, reload | B existing role journeys, conflicts, membership loss, no automatic second write; C no retry | Strengthened existing partial-quantity browser journey; no duplicated journey |

No added browser test is counted as backend security proof. New audit failure checks call the real service and database; only failure delivery is injected at Knex's query event immediately before the audit INSERT. The actual state writes, transaction rollback, constraints and readback are real. The installed Knex transaction query wrapper catches listener exceptions and rejects the query Promise. A sentinel identity assertion proves that the intended fault fired; the listener is removed in finally. These checks do not emulate a database crash or replace any concurrency test with a mock.

## Locking, rollback and native boundary review

All production reads/mutations enter withMerchantAuthorization, acquiring the merchant row before revalidating membership/capability. load locks the tenant-scoped operation, session and lines sorted by native line ID. Reassignment validates its target inside this boundary. Team revocation follows the same merchant-first discipline. No M12 path acquires native inventory, customer-cart, payment or slot locks. The one-step workflow invokes one custom transaction; it does not replay native commerce workflows.

Session uniqueness, line uniqueness, numeric checks, immutable baselines, terminal guards and deferred audit constraints supplement service validation. Same action replay requires original actor/action/line/payload and previous revision; a stale changed payload cannot win. All four audit-fault cases compare persisted rows, including assignment, revision and timestamps, after rollback.

Production PickingService only reads native commerce through the existing M11 supported boundary. It writes pick_session, pick_line and pick_event. No native Order/price/payment/refund/inventory/reservation/fulfillment mutation was added. The native updateOrderLineItems call added in this slice exists only in a disposable verification fixture to prove native drift fails closed; it is not a picking production capability.

The two deliberate inconsistency fixtures run after queue assertions. Their cleanup uses only invocation-owned Order/session IDs within the existing prerequisite lifetime. No manual database repair, trigger disabling, Redis clearing, broad deletion or expanded cleanup scope was introduced.

## M13 handoff and residual limitations

- Original native line, ordered quantity, picked quantity, shortage flag and unresolved quantity remain sufficient operational input for M13. No substitute, commercial resolution, refund, repricing, fulfillment or dispatch behavior exists in M12.
- Employee IDs/roles distinguish targets uniquely; names are a presentation limitation, not a demonstrated authority ambiguity. Do not expand the DTO for cosmetics here.
- M25: measure merchant-wide lock throughput, bounded queue native-read cost, rate limits and observability. Pagination caps alone are not a complete sustained-resource-abuse defence.
- M25/future native Order-edit work: Marketplace locks do not serialize arbitrary native Admin mutations. Drift present at validation is rejected; this suite does not prove serializability against an external native edit occurring after validation. No native edit endpoint was added for merchant actors.
- Audit rollback injection proves atomic rollback on an exception, not power-loss/crash durability or every database failure mode. New assertions have not been executed by Codex.
- Shortage intentionally blocks completion until original goods are found or M13 defines a valid resolution. Revoked assignees require explicit supervisor handover; no silent takeover.

## Files materially changed

- apps/backend/src/scripts/verify-picking.ts — additional real HTTP/database/race/rollback acceptance assertions.
- tests/browser/picking.spec.ts — strengthen existing shortage correction journey.
- milestones/MILESTONE_M12_PICKING.md — mark B/C user verification and D implementation pending verification.
- milestones/M12_D_ACCEPTANCE.md — this review, coverage and verification record.

## Commands for user to run

Working directory for every command: D:\Programming_projects\GoSpazaCodex. Run in order. **Stop on every failure.** No new migration is required for D; use the already verified M12-B database/configuration.

### A. NO DEV SERVERS

Stop Next dev processes before typecheck/build so generated .next output is not written concurrently.

| Command | Purpose / expected result |
| --- | --- |
| pnpm run lint | Zero lint errors/warnings. |
| pnpm run typecheck | Workspace typechecks succeed. |
| pnpm --filter @gospaza/backend run test | Backend unit/policy tests pass, including existing M10/M11 and M12 policies. |
| pnpm --filter @gospaza/api-client run test | Shared client tests pass, including picking payload/error/no-retry checks. |
| pnpm --filter @gospaza/backend run build | Backend production build succeeds. |
| pnpm --filter @gospaza/merchant run build | Merchant production build succeeds. |

### B. POSTGRES/REDIS + BACKEND ONLY

Use existing verified local integration configuration. Keep the backend on port 9000; no Next applications are needed. If it is not running, start pnpm --filter @gospaza/backend run dev in a separate terminal and wait for readiness.

| Command | Purpose / expected result |
| --- | --- |
| pnpm --filter @gospaza/backend run test:order-decisions | M11 decision/RBAC/capacity/concurrency regression passes. |
| pnpm --filter @gospaza/backend run test:picking | Existing prerequisite verification plus expanded M12 verifier passes. |

The picking verifier already invokes order-operations prerequisites; do not separately repeat test:order-operations solely for D. Existing M10 verification is preserved, not replaced by browser mocks.

### C. PLAYWRIGHT-MANAGED STACK

Close manually started Next servers before these invocations. First two configurations start only merchant; the final command uses the existing full browser stack/configuration. Run sequentially with one worker; no retries or timeout changes.

| Command | Purpose / expected result |
| --- | --- |
| pnpm exec playwright test --config=playwright.m12-merchant.config.ts | All picking portal journeys pass, including partial quantity after clearing shortage. |
| pnpm exec playwright test --config=playwright.m11-merchant.config.ts --workers=1 | Existing merchant list, stale-decision and membership-loss regressions pass. |
| pnpm exec playwright test --workers=1 | Complete existing browser regression passes, including remaining M11 customer/merchant journeys. |

M12 is ready for user verification, then commit/merge only if these checks pass. No commit/merge was performed and no later milestone was started.
