# M9-E acceptance and security audit

Status: final M9-E follow-up review completed on 2026-10-03; the focused test additions below require user verification. The user reports all existing tests and production builds pass before this review. No commands were executed by Codex.

## Scope and result

Static review covered the scheduling service, input policy, HTTP boundaries, PostgreSQL reservation repository, scheduling configuration, native bypass middleware, M8 cart lock/mutation/switch integration, customer scheduling UI, and the existing real-database/client/browser suites.

The earlier M9-E pass found and corrected one bounded UI expiry defect: a held response arriving after its displayed deadline previously skipped revalidation and could retain the valid reserved-window presentation. The panel now requests one immediate authoritative read for that elapsed deadline and labels the prior window as requiring refresh while checking. The immediate check is bounded per deadline to avoid a browser-clock-skew polling loop. Browser time does not release/renew a hold or change server authority, and release still uses server-returned revision data. That correction is already present and was preserved. This follow-up found no additional confirmed production defect and changes only acceptance tests and this report. No application/backend logic, schema, dependencies, lock topology or native commerce ownership changed in this pass.

Medusa 2.18.0 remains pinned. Medusa owns Cart, line items, native Shipping Options and pricing; Marketplace owns operational capacity and reservations. No new custom entity or Medusa workflow was introduced.

## Acceptance coverage matrix

B = apps/backend/src/scripts/verify-scheduling-foundation.ts
C = apps/backend/src/scripts/verify-delivery-reservations.ts
U = apps/backend/tests/scheduling.test.ts and delivery-selection.test.ts
P = tests/browser/scheduling.spec.ts
K = tests/browser/cart.spec.ts
A = packages/api-client/tests/delivery.test.ts

| Invariant / acceptance case | Executable evidence | Boundary |
|---|---|---|
| Authenticated option resolution | B actor-isolation checks; C anonymous option/slot/select/restore/release rejection | Actual HTTP + real auth sessions |
| Customer/cart isolation | C foreign cart PUT/GET/DELETE and both option/slot discovery POSTs | Actual customer cookies and native carts |
| Foreign reservation isolation | C losing customer tries to release winner's actual reservation | Actual HTTP + real hold |
| Owned address isolation | C creates a real foreign customer's M6 address; owner discovery succeeds; another customer's option/slot/selection calls fail | Actual HTTP + native address + location record |
| Store/zone/option authority | C foreign native/custom options and actual foreign slot rejected; forged authority fields rejected on selection and availability | Actual HTTP + provisioned native topology |
| Polygon serviceability | C outside-polygon coordinates rejected on selection and both discovery routes; B overlap resolution tests | Real M6 serviceability; native ZA compatibility does not authorize |
| Highest priority / ambiguous equal priority | B real overlapping assignments resolve highest priority and reject conflicting ties; U stable equivalent ties and reversed ordering | Database integration + pure policy unit tests |
| Native price and configuration revision agree | B real native price drift and M6 tariff change fail closed; C stale option revision rejected and refreshed revision accepted; U conversion/revision tests | Supported native workflows + database integration |
| Last capacity unit cannot be oversold | C concurrent HTTP PUTs from two customers: exactly one 200, one 409 | Real concurrent requests + slot locks |
| Capacity shared across modes | C ASAP skips the window already full from a SCHEDULED hold; full-slot count remains one | Real DB/API + native options |
| One effective hold per current cart | C same-cart concurrent selection with same revision: one success, one stale conflict; active-row count assertion | Real customer lock + DB unique constraint |
| Atomic replacement | C occupied target preserves original hold; free target replaces it; injected publication failure rolls back old release | Real DB/API + scoped failure trigger |
| Replacement versus expiry | C expired hold replacement and GET restoration run concurrently; final state matches winning operation | Real concurrent HTTP + fresh database time |
| Expired holds consume no capacity before cleanup | C changes only its synthetic hold deadline under customer/slot locks; confirms row remains HELD while another customer acquires same slot | Real DB/API |
| Repeated selection / restoration never renew expiry | C repeats identical selection and compares complete restored DTO; P reload/navigation/focus preserves expiry without extra PUT | Real DB/API + browser contract tests |
| Capacity reduction versus booking | C rejects capacity below occupancy, preserves existing holds on safe reduction, races reduction and reservation | Real DB/API and concurrent configuration mutation |
| Stale revisions / stale availability | C old selection and option revisions rejected; DELETE with a replaced reservation ID/current revision and DELETE with current reservation ID/old revision each reject without altering the replacement; disabled/cutoff windows rejected from old discovery; P stale/slot/config conflict reconfirmation | Real DB/API + browser |
| Held slot disabled | C disables an existing held slot, GET becomes unavailable, reservation is released and slot can be reused after reenablement | Real DB/API |
| Store switch versus selection | C actual concurrent switch POST and selection PUT; old context has no HELD row; new cart has no inherited selection | Real concurrent HTTP + native carts |
| Switch failure preserves cart and hold | C failed Marketplace publication leaves original hold unchanged | Real native candidate workflow + database rollback |
| Superseded cart unusable | C old cart PUT/GET/DELETE reject after switch | Actual stale known-ID HTTP calls |
| Final-item removal releases capacity | C native final removal without location/active-store eligibility clears hold; subsequent booking reuses capacity | Real native line-item workflow + DB/API |
| Final-item cleanup failure is recoverable | C scoped trigger makes hold cleanup fail after successful native deletion; HTTP reports CART_MUTATION_UNCERTAIN; GET releases empty-cart hold; another cart reuses capacity | Real native workflow + injected DB failure |
| Decrease/remove/release without location | C decrease/removal while store inactive and location-free idempotent release; P release after location loss/discovery error | Actual HTTP + browser |
| Native shipping bypass | B all actor classes blocked; C anonymous/customer calls against real native option/cart IDs using GET/POST/PUT/PATCH/DELETE on list/detail/calculate/shipping-method paths | Actual middleware/HTTP, not UI hiding |
| Safe DTO exposure / money | C exact strict selection DTO schema disallows internal context/customer/merchant/zone/location fields and asserts integer nonnegative ZAR quotes | Real HTTP responses |
| Fee/config requires reconfirmation | C changes the real M6 tariff while HELD, checks invalidation/release and unchanged historical quote, rejects unsynchronized discovery and the old option revision, then explicitly reconfirms at the new native-synchronized amount; P clears draft and requires confirmation at the changed fee | Real backend/native pricing + browser contract |
| Reload and navigation restoration | P ASAP hold survives reload, navigation and focus with original expiry | Browser contract tests |
| Delayed held response beyond expiry | P delays the initial held response behind an explicit request barrier, advances browser time, returns backend-expired state on revalidation, and asserts no renewal | Deterministic browser clock + response ordering |
| UI invalidated state correctness | P authoritative expired, stale and unavailable responses remove reserved-window presentation while the browser still has time before its displayed deadline; no automatic renewal; no scheduling identifiers persisted | Browser contract tests with controlled clock |
| Store switch UI isolation | K existing explicit conflict/keep/confirm flow starts with a hold and ends with no inherited reservation | Browser M8 regression journey |
| Safe client mutation behavior | A exact credentialed request shapes, revision tokens, no location on DELETE, safe errors and no automatic write replay | API-client tests |
| No Shipping Method / checkout/payment/order/dispatch | C explicitly loads native cart shipping_methods after quote reconfirmation and asserts an empty array; native shipping-method bypass checks; browser absence of checkout control; static scope review | Real native Cart read + static/API/browser assertions |

Existing equivalent tests were retained rather than duplicated. B and C invoke real services/database/native workflows and C issues genuinely concurrent HTTP requests. P/K use deterministic mocks to exercise UI contracts; they do not prove database capacity enforcement.

## Security review

Critical: None identified.
High: None identified.
Medium: None identified in the reviewed M9 paths.
Low / production hardening: See M25 items below.

Authorization is derived from authenticated customer and current CartMarketplaceContext. Browser cart IDs are stale hints. Location address ownership is checked by the native Customer Module; scheduling uses M6 polygons and server-resolved assignment/native configuration. Routes validate shape; services decide.

Mutation and restoration enter the existing customer-scoped advisory lock. Configuration/capacity mutations use database-backed locks. Affected slot rows are ordered by ID and database time is read after acquisition. Replacement secures target capacity before ending the old hold in the same transaction.

Native cart and shipping routes are blocked by backend middleware before they can supply an alternate mutation path. The audit did not change that protection.

Operational/uncertain errors require authoritative restoration rather than claiming rollback or replaying a non-idempotent native workflow. Customer responses do not expose server exceptions or internal ownership records.

## Security data-flow review (2026-10-03)

The review follows SOURCE → TRANSFORMATION → TRUST BOUNDARY → SINK. A finding requires a credible abuse path; neither a caller-controlled ID nor a shared lock alone establishes a vulnerability.

| Flow / attempted abuse | Source → transformation → trust boundary → sink | Evidence and assessment |
|---|---|---|
| Foreign or superseded cart | Session + optional cart_id → strict delivery schema → customer-only middleware/handler, CartFoundationService.withCurrent and requireCurrent resolve the native customer's current unsuperseded context → availability/hold read or write | C uses another customer's real cart and a superseded cart in HTTP reads/writes. IDs cannot select another customer's authority. No confirmed BOLA identified. |
| Foreign/replaced hold or stale release | reservation_id + expected_revision → strict release schema → hold must belong to the resolved context, match the current hold and current revision under the customer lock → finishHold | C foreign-hold rejection plus the new independent replaced-ID and stale-revision DELETE checks. No confirmed release/replay bypass identified. |
| Forged merchant/store/zone/customer/channel/fee/context | JSON body/query → strict schemas reject extra keys → server cart binding and resolved assignment remain authoritative → reservation insert/DTO | C hostile over-posting on select/discovery/restore/release. Parameterized Knex filters are used; no browser input is interpolated into production SQL. No confirmed mass assignment/injection identified. |
| Foreign address or claimed geographic eligibility | address_id or coordinate selection → one-source validation and bounded finite coordinates → native address lookup includes authenticated customer_id; M6 polygons and current store assignment resolve eligibility → scheduling options/hold location basis | C real owned-address positive control and foreign-address/outside-polygon rejection. Coordinates are a chosen location, not proof of physical presence or a checkout address. No confirmed geographic authorization bypass identified. |
| Other store's slot/native option | option_id/slot_id + revisions → strict identifiers → options come from the authenticated cart's server-resolved assignment; locked slots are restricted to that store → HELD publication | C real foreign native/custom option and foreign slot IDs. Composite foreign keys back the store/assignment relationship. No confirmed cross-store capacity mutation identified. |
| Capacity and replacement races | Concurrent HTTP selections/release/switch → authenticated current context → customer advisory lock, configuration locks, sorted slot row locks and fresh database time → occupied count and transactional finish/insert/publication | C actual concurrent HTTP calls, capacity-reduction race and scoped rollback faults. Unique HELD-per-context constraint; expired/superseded rows excluded from effective occupancy. No confirmed oversell or lost-old-hold path identified. |
| Fee/config drift | M6 tariff/admin configuration or native price changes → revision invalidation and supported native synchronization → option/native revision, amount, provider/profile/zone/rules agreement → quote/reservation DTO | B native drift checks and C held-tariff reconfirmation test. Browser amounts are rejected. Commercial price remains Medusa-owned. |
| Native HTTP bypass | Public /store/shipping-options and /store/carts paths/methods → root middleware matcher → unconditional backend rejection → no native route handler | B/C actual HTTP method/actor matrix, including real option/cart IDs. No confirmed native alternate path identified within these route families. |
| Stale browser state / expiry | GET/PUT result and browser clock → request-generation/unmount guards and display timer → backend restoration/revision decides state; client never replays uncertain writes → rendered hold and explicit select/release | P delayed/expired/stale/unavailable states and store-switch journey; A exact request/no-replay checks. Browser tests prove presentation contracts, not database capacity. |

Customer scheduling routes also use the existing session actor and write-origin boundaries. Error responses expose fixed public messages; customer DTOs omit internal context/merchant/zone/location authority. React text rendering is used for displayed server values. No user-selected outbound destination, file access, deserialization engine or new dependency was introduced in these flows; no credible SSRF, path traversal or supply-chain abuse path was identified here.

Classification: no new confirmed or probable vulnerability identified by this static review. The existing global configuration lock is a design/throughput concern. Authenticated request volume and nested connection demand are defence-in-depth/load-hardening work, not a demonstrated authority bypass. These conclusions are scoped to M9; they are not a claim of runtime verification or an audit of future checkout/payment behavior.

## Acceptance additions from the earlier M9-E pass

- Real known-ID isolation for both option and slot discovery routes.
- Read/release anonymous and forged-query/body cases.
- Outside-polygon discovery and selection rejection.
- Native bypass matrix using real native option/cart IDs and five HTTP methods.
- Actual owned-address positive control and foreign-address attacks.
- Shared ASAP/SCHEDULED capacity assertion.
- Disabled existing hold restoration and lifecycle/capacity assertions.
- Failed post-native final-item cleanup: uncertain response, read recovery, and subsequent capacity reuse.
- Exact response DTO/money assertions.
- Browser stale/unavailable restoration checks, no implicit renewal, no persisted scheduling identifiers, and no checkout control.
- Delayed expiry-response regression using a request barrier and Playwright clock; no sleeps or timeout increases.

Unique local fixture prefixes remain. New addresses are removed through their owner's M6 API before parent fixture teardown; cleanup failures are retained in the aggregate error. Failure triggers affect only their unique synthetic hold and are removed in finally blocks.

## Focused additions in this follow-up

- Extended the existing replacement case with actual DELETE attacks using a replaced reservation ID and an old revision independently; both must leave the new hold and expiry unchanged.
- Strengthened the existing option-revision case into a real M6 fee change while held, native synchronization, unchanged historical quote, old-revision rejection and explicit new-fee reconfirmation. No mock substitutes for native pricing.
- Added a native Cart read proving quote/reservation selection did not attach a Shipping Method.
- Extended the existing authoritative-state browser case to include expired while the controlled browser clock remains before the displayed hold deadline.
- No new test framework, fixture family, dependency, migration or production behavior was added. Existing concurrency tests were retained.

## Residual M25 hardening items

- Measure cross-store head-of-line contention from the shared scheduling-configuration advisory lock. Do not reduce its scope without re-proving configuration/race invariants.
- Load-test nested transaction/native query connection demand, pool sizing, lock timeouts and multiple backend instances. Current functional races use real PostgreSQL, but are not production load evidence.
- Measure authenticated scheduling request rates and add appropriately scoped abuse controls alongside pool/lock budgets if production testing requires them; the global lock makes expensive valid requests a shared throughput concern.
- Bound retention/cleanup of expired historical holds and monitor reservation expiry/cleanup failures. Effective occupancy already excludes expired/superseded holds, so correctness does not depend on cleanup timing.
- Exercise network/commit-acknowledgement failures in a production-like environment. Scoped database triggers cover rollback and post-native cleanup failures but do not reproduce every transport failure.
- Check timer throttling and browser clock skew on mobile devices. Display refresh is advisory; PostgreSQL expiry and backend restoration remain authoritative.

## Commands for user to run

Run from repository root, in this order. Stop on every failure. The real HTTP verifiers require the existing local backend, PostgreSQL and Redis to be available; retain the verified ZA/ZAR region setup. Do not reseed or clear workflow state.

1. `pnpm run lint` — no errors or warnings.
2. `pnpm run typecheck` — all workspace checks pass.
3. `pnpm run test` — all unit/client tests pass.
4. `pnpm --filter @gospaza/backend run test:scheduling-foundation` — topology, native prices, priority and actor boundaries pass.
5. `pnpm --filter @gospaza/backend run test:delivery-reservations` — extended real-database/API/concurrency acceptance passes; no fixture cleanup errors.
6. `pnpm exec playwright test tests/browser/scheduling.spec.ts tests/browser/cart.spec.ts --workers=1` — scheduling acceptance and M8 cart journeys pass.
7. `pnpm run test:browser` — complete browser regression suite passes.
8. `pnpm run build` — all workspace production builds pass.

No new migration or installation is required. The user reports the existing tests and production builds pass. The focused follow-up additions above have not been executed.

M10 has not been started. No new product functionality was implemented. This follow-up changes only apps/backend/src/scripts/verify-delivery-reservations.ts, tests/browser/scheduling.spec.ts and this report; the earlier expiry correction remains unchanged.
