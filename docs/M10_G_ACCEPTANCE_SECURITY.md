# M10-G acceptance and security review

Status: static review and focused acceptance additions complete; new M10-G verification is pending. M10-A–F verification was supplied by the user. No verification commands were executed for this slice. This is not an unconditional production-readiness certificate.

## Scope and commercial ownership

Reviewed checkout preparation/confirmation, Yoco provider compatibility, initiation, inbox/reconciliation, native completion, technical compensation, customer status and checkout UI as one system. Medusa 2.18.0 retains Cart, Shipping Method, Payment Collection, PaymentSession, Payment, Capture, Refund, Order and inventory ownership. Marketplace records retain binding, immutable attempt/operation evidence, session correlations, inbox and recovery receipts; they do not compute a second commercial balance or maintain a parallel payment/refund ledger.

Native session creation persists a session before provider initiation and deletes it on initiation failure. Durable provider-session associations therefore outlive that native session. Replacement uses the same immutable external operation/request/key. Native completion remains at-most-one GoSpaza dispatch, not automatic exactly-once recovery across arbitrary native crashes. Direct SQL inspected in these paths targets GoSpaza-owned coordination records; native commerce writes use Medusa services, workflows and links.

## Finding fixed

**Medium, conditional production misconfiguration:** enabled production payments accepted a test Yoco key. SOURCE: configured test key and valid test-provider evidence → TRANSFORMATION: matching test operation/event mode → TRUST BOUNDARY: non-live payment evidence entering production commerce → SINK: captured reconciliation/native Order creation. This requires deployment misconfiguration, not an unauthenticated attacker choosing the environment. `yocoConfiguration` now rejects enabled production payment configuration unless the key is live. Existing secret/URL validation still applies. Disabled payments remain the default. Regression coverage checks disabled production, rejected test credentials, live-format credentials, missing webhook secret and permitted local test configuration. Tests use fake credentials and do not contact Yoco.

No other exploitable defect was established by this static review. This does not claim that all possible operational or provider failures are automatically recoverable.

## Security flow review

| Source → transformation → trust boundary → sink | Enforcement and evidence |
| --- | --- |
| Browser cart/attempt/address identifiers → strict parsing + authenticated current-cart/address lookup → customer ownership → preparation/payment/status | C HTTP foreign IDs, forged authority, snapshot/address validation; D hostile Pay/retry; E foreign attempt and additional forged status-query fields. IDs select resources; they never authorize them. |
| Browser money/merchant/store/channel claims → strict schemas → server commercial authority → native Shipping Method/totals and frozen snapshot | C rejects extra fields and compares native totals; customer lock and CartMarketplaceContext resolve merchant/store. |
| Native major-unit money → existing exact conversion → provider amount boundary → immutable ZAR checkout request | B BigNumber/number/string precision cases; no frontend-derived total; D persists request/fingerprint/key before external I/O. |
| Replacement native session → durable association + canonical claim → financial materialization boundary → Medusa Payment/Capture | B/D replacement, permit and historical-correlation checks; E newly added lost-response/early-webhook case checks one Payment, Capture and Order and no second checkout POST. |
| Public webhook bytes/headers → bounded raw body, HMAC and timestamp validation → verified provider evidence → durable unique inbox | B signature/raw-body tests; E real HTTP invalid signature, stale timestamp, malformed JSON and over-limit body. E concurrent/replayed receipt and conflicting payload tests. |
| Signed but mismatched amount/mode/checkout correlation → operation/snapshot/account correlation → payment authority → accepted captured evidence | E rejects wrong amount, environment and checkout; B covers currency, session and request correlation. Provider evidence alone cannot choose a customer or cart. |
| Verified success vs expiry → customer/slot locking and fresh DB time → eligibility decision → accepted payment or late-payment compensation | E runs receipt application alongside expiry observation, both before and after the deadline; expired attempts cannot revive. |
| Duplicate completion worker → persisted dispatch claim + exact execution identity/readback → native Order side-effect boundary → one dispatch/terminal receipt or RECOVERY_REQUIRED | E concurrent claims/workers and post-native-result/pre-receipt recovery. Missing history after dispatch freezes capacity/cart and disallows retry/refund. |
| Late capture/refund response → approved full compensation + stable key + native financial readback → refund completion boundary → pending/unknown or verified refunded | B/E pending and lost response cases. No new refund key or successful Order inferred from uncertainty. |
| Return URL/query/browser state → read-only authenticated backend status → customer outcome boundary → rendered status/Order | F browser spoofed return, pending polling/reload, success reload, failure/expiry/recovery/refund and outage cases. No native completion call or local-storage authority. |
| Direct native API calls → backend middleware and provider native-hook refusal → GoSpaza policy boundary → 404/not_supported | C/D/E explicit native cart/payment/session/order/hook bypass calls; UI hiding is not relied on. |

## Acceptance coverage matrix

Paths below are repository-relative. B–F tests are retained; G extends only the named gaps.

| Invariants | Existing executable coverage / G addition |
| --- | --- |
| Native commercial ownership; single merchant/store; lazy current-cart restoration; foreign/stale/superseded cart and line IDs | `verify-cart-foundation.ts`, `verify-cart-mutations.ts`; C uses these authoritative services. |
| Customer-owned complete M6 address, M6 serviceability, current M9 hold, server shipping option, native totals | `verify-checkout-foundation.ts`, `checkout-foundation.test.ts`. |
| Hostile amount/currency/merchant/store/customer/context fields, cross-cart/foreign attempt | C/D HTTP checks; G extends E status-query mass-assignment checks without accepting additional fields. |
| One active attempt, checkout revision, changed-total reconfirmation, immutable snapshot, cart freeze | C real DB/API plus `tests/browser/checkout.spec.ts`. |
| Exact major-unit conversion, ZAR, fixed redirect URLs, signature contract, updatePayment without POST | `yoco-provider.test.ts`. |
| Payments opt-in, deadline bounds, production configuration | `payment-initiation-policy.test.ts`; G adds production test-key rejection. |
| Double Pay, stable one external operation/request/key, initiation loss, replacement session, canonical financial identity, historical session/collection preservation | `verify-payment-initiation.ts`, B provider contract tests. |
| Pay vs cart mutation/store switch | D existing real concurrent Pay/add plus G simultaneous HTTP store-switch assertion; confirmed cart/context remains unchanged. |
| HELD to PAYMENT_PENDING; fresh time after waiting for lock; deadline never silently renewed; later-attempt isolation | D real DB tests, M9 reservation tests. |
| Invalid/stale/malformed/oversized webhook cannot persist evidence | B policy tests; G adds real HTTP ingress cases in E. |
| Duplicate/replayed webhook, tampered signed correlation, no duplicate business effects | E concurrent inbox receive/apply/reconcile and immutable inbox checks. |
| Webhook before lost initiation response; captured recovery without another checkout POST | G E case delivers signed evidence through HTTP while initiation is in flight, then deliberately loses the response; duplicate workers establish one native Payment/Capture/Order with retained old/new session correlations. External Yoco transport is intercepted; database, native modules and HTTP ingress are real. |
| Deadline vs payment, late capture without Order | E before-deadline observation race added in G; existing already-expired race and full technical compensation. |
| At-most-one native completion dispatch; native done before local receipt; successful capacity commit | E real completeCartWorkflow execution/readback, duplicate dispatch claim/workers, one native Order, SUCCEEDED receipt and COMMITTED hold. |
| Invoking/inconsistent/reverted/failed observations not automatic refund permission | `payment-reconciliation.test.ts` state policy; E missing-execution integration and recovery guard tests. Arbitrary process-kill windows are not simulated as proof of native automatic recovery. |
| RECOVERY_REQUIRED cannot Pay/release/refund and survives absent workflow history/deadline | E claimed dispatch without execution; repeated reconciliation, frozen cart, retry refusal, protected capacity after simulated future time, no compensation. Durable receipt/state does not require history retention. |
| Refund pending/unknown not completed; lost response reuses key | B provider contract and E native payment/compensation tests. |
| Native cart/payment/session/hook/completion/order bypass | C/D/E actual HTTP calls plus registered provider hook returns not_supported. |
| Safe DTOs/no provider IDs/secrets; no browser authority | `checkout-status.test.ts`, E serialized status deny-list, shared API-client tests and F browser suite. |
| Prepare/confirm/Pay/redirect/return; reload pending/success; explicit reconfirm; failed/expired/recovery/refund pending; duplicate Pay | `tests/browser/checkout.spec.ts` (existing nine tests), API-client tests. Full browser regression retains M8 cart and M9 scheduling coverage. |

The shared C fixture extension used by D/E is not a replacement for standalone C verification: run `test:checkout-foundation` separately. Browser/provider transport mocks test their boundaries; they do not prove a real Yoco account or production gateway network behavior.

## Residual risks and operational boundaries

- **M25:** real process-kill/connection-loss drills, payment/inbox backlog limits, ingress rate limiting and replay-volume protection, archival/retention and historical lookup scaling, clock/secret rotation operations, and recovery runbooks. Existing bounded webhook bodies do not constitute a full DoS defense.
- **M25:** known global M9 configuration lock serializes stores. Leave unchanged; no correctness defect established. Existing pg concurrent-query deprecation warrants dedicated connection/pool hardening; it was not established as causal to an M10 invariant breach.
- **M23/M25:** restricted operational handling of durable RECOVERY_REQUIRED. It intentionally preserves capacity and freezes checkout indefinitely rather than risk another Order or a refund while completion may advance. Missing native history is not permission to retry.
- **M18:** general refunds, partial refunds, refund destination choices and customer-support refund UX remain out of scope. M10 only implements full technical compensation for approved orderless late-payment cases.
- Real Yoco account/webhook provisioning, gateway outage behavior and live deployment verification still require operational acceptance. These local suites intercept external payment/refund transport and never initiate a real charge.

## Commands for user to run

Run each command from the repository root. Stop on any failure. No migrations or dependency installation are introduced by G.

### A. NO DEV SERVERS RUNNING

Stop Next development processes before typecheck/build so `.next` generation cannot race those commands. Also stop the backend development process for this group.

1. `pnpm run lint` — no errors or warnings.
2. `pnpm run typecheck` — all workspaces pass.
3. `pnpm run test` — unit/policy/API-client suites pass, including the existing M10-B provider contract suite and the new production configuration regression.
4. `pnpm run build` — workspace production builds pass.

### B. BACKEND ONLY

Use the already-established local test environment with PostgreSQL/Redis available. Configure `APP_ENV=development` or `test`, enabled test-mode Yoco, the existing local verification webhook secret and server-controlled return URLs. Set `PAYMENT_RECONCILIATION_WORKER_ENABLED=false` in both backend and verifier environments for deterministic fixtures; restart the backend after changing it. The verifier rejects live credentials. Do not start the monorepo dev supervisor or any Next app for this group.

In a separate terminal: `pnpm --filter @gospaza/backend run dev` — wait until port 9000 is ready; keep it running.

1. `pnpm --filter @gospaza/backend run test:cart-mutations` — M8 mutation/ownership/concurrency assertions pass.
2. `pnpm --filter @gospaza/backend run test:delivery-reservations` — M9 capacity/selection/security assertions pass.
3. `pnpm --filter @gospaza/backend run test:checkout-foundation` — standalone M8/M10-C prerequisites and checkout assertions pass.
4. `pnpm --filter @gospaza/backend run test:payment-initiation` — retained M10-D assertions plus Pay/store-switch race pass.
5. `pnpm --filter @gospaza/backend run test:payment-reconciliation` — native financial/completion/recovery assertions and new HTTP/early-webhook cases pass.

Restore `PAYMENT_RECONCILIATION_WORKER_ENABLED=true` for normal operation and restart when returning to normal backend use. Production rejects a disabled worker.

### C. FULL REQUIRED BROWSER STACK

Playwright configuration starts/reuses customer, merchant, driver and admin Next applications on ports 3000–3003. These tests mock backend requests; they do not require the real backend. Let Playwright manage the four applications; do not start the entire monorepo merely for browser verification. Keep one worker.

1. `pnpm exec playwright test tests/browser/checkout.spec.ts --workers=1` — all nine checkout journeys pass.
2. `pnpm run test:browser` — full M1–M10 browser regression passes.

Do not commit/merge on this report alone. M10 is ready for milestone commit/merge only after these new acceptance changes pass user verification. M11 was not started.