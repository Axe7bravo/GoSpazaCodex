# M17-D — UX and acceptance record

## Verdict and evidence limits

Implementation and static acceptance review are complete, subject to user-run verification below. M17-A/B/C and the `Migration20261027120000` corrective migration are user-verified. D adds tests but has not executed them. No runtime pass is claimed for these changes. No confirmed unresolved CRITICAL, HIGH or MEDIUM finding was identified in the reviewed paths; this is not a claim that static inspection proves runtime security.

After all verification passes, M17 is ready for the milestone commit/merge review. Production restricted-commerce launch remains blocked by the explicit gates below. No commit or merge was performed. M18 was not implemented.

## Architecture and authority

- Medusa retains commercial Order, Product/variant, payment, inventory and native fulfillment authority. D does not write Medusa commerce tables or introduce commercial entities.
- `RestrictedCommerce` owns store registration, private evidence, platform classification review, trading policies and purchaser eligibility. Merchant proposals are requests, never approval. Latest proposal readback comes from append-oriented evidence without rewriting the authoritative review.
- `RecipientService` owns bounded actual-recipient evidence and whole-order physical return custody. `HandoffService` remains the owner of OTP and native completion designation. UI observations cannot designate successful compliance or completion.
- Store approval is visibly scoped to one Store and its premises. Admin actions require the existing native platform actor, explicit reviewer allowlist, strict request shapes, current revision/fingerprint, confirmation, reason and audit. Merchant registration/proposals require existing catalogue capability; PICKER lacks it.
- Purchaser eligibility is independent of recipient eligibility. The production provider remains unavailable until an approved mechanism exists. The customer panel collects no identity data and cannot set VERIFIED. Ordinary grocery evaluation does not acquire an alcohol eligibility requirement.
- Current assigned DRIVER, ARRIVED, current occupied commitment and current handoff generation are prerequisites for recipient evaluation. Purchaser and alternate adult use the same server policy. The browser does not calculate authoritative age.

## User surfaces

Admin: bounded Store queue; private evidence review; request changes, approve, suspend, reactivate and revoke; explicit stage windows and licence conditions; Store-scoped product review using native product identity and current fingerprint. Product reference lookup is intentionally minimal, not a new catalogue search system.

Merchant OWNER/MANAGER: registration status, review note, evidence upload/submission and proposal versus reviewed product classification, including invalidation after material edits. OWNER/MANAGER/PICKER: bounded own-store return queue, immutable physical quantities, explicit physical receipt acknowledgement. No recipient diagnosis, compliance override, refund, inventory or commercial Return controls.

Customer: bounded required/verified/expired/unavailable purchaser state, safe checkout error copy, whole-order return status and financial review pending. Return views contain no code or courier coordinates and do not claim a refund.

Driver: bounded transport copy, explicit recipient/document choice and six yes/no observations, transient observed DOB, backend result, then existing M16 OTP only when its authoritative gate permits. Failure requires the entire physical order to return to the server-derived origin. Arrival waits for merchant receipt; attention exposes no completion escape.

## Security review: source → transformation → trust boundary → sink

| Source | Transformation and authoritative boundary | Sink / evidence |
| --- | --- | --- |
| Merchant session, registration/proposal body | Merchant actor and active capability; tenant/store derived under existing merchant lock; strict schema | Own-store submission/audit only. `verify-restricted-commerce`, team policy and D browser tests retain PICKER rejection and proposal distinction. |
| Native platform actor, Store/product reference | Reviewer allowlist; Store ownership and native product identity; revision/fingerprint validation; explicit confirmed reason | Store registration or reviewed classification, never merchant-global approval. D review queue is bounded and protected by the same platform policy. |
| Evidence upload/download reference | Existing type/size validation and tenant/reviewer authorization; private File storage | Authenticated attachment response, not a public storage URL. No private licence evidence is included in the driver invoice. |
| Browser checkout data | Native cart and immutable restricted snapshot; server trading policy and customer-bound current purchaser evidence | Backend checkout gate. Safe client messages omit licence, policy and provider diagnostics. Existing ordinary grocery assertions remain. |
| DRIVER observations / hostile Delivery ID | Driver binding; assigned Delivery lock; ARRIVED/current generation; strict observation schema; server DOB evaluation | Immutable bounded outcome and audit. Foreign/pre-arrival/unsupported/forged inputs are covered in recipient DB/API verification. |
| Failed recipient outcome / receipt request | Whole-order manifest; original Store; merchant capability and current revision; same transaction as audit and commitment terminality | Physical custody only. Foreign merchant receipt and forged fields rejected; duplicate receipt releases capacity once. |
| OTP / repair worker / licence mutation | Existing M16 designation and merchant-first lock prefix; current recipient and supply validation before designation | One native completion path; no return reinterpretation after designation. Licence invalidation before designation fails closed. |
| Invoice/read response | Parse retained immutable original, explicitly project transport-only fields | Driver/merchant copy omits internal IDs, customer name/phone, review metadata and private files. Native order reference and required seller/address/goods remain. |

The new merchant queue rejects extra query filters and derives both merchant and Store scope from authentication. It returns at most 20 rows with a bounded offset; the admin queue uses the same bound. IDs identify resources, not authorization. Neither queue accepts operational state mutation.

## Findings and fixes

### LOW — unnecessary transport-copy disclosure, fixed

Source: retained restricted document snapshot. Transformation: returning the full snapshot. Boundary: internal immutable evidence to driver/merchant API. Sink: public invoice DTO. Impact: unnecessary internal policy/relationship identifiers and customer name/phone in a transport view. Fix: explicit parsed transport projection; immutable original unchanged. Coverage: real-database projection exclusions and browser invoice presentation.

### LOW — proposal presentation could imply authority, fixed

Source: merchant catalogue checkbox and classification proposal. Transformation: generic restricted-product wording and legacy proposal readback. Boundary: merchant request versus platform decision. Sink: catalogue UI. Impact: misleading apparent downgrade/approval, not a proven backend authorization bypass. Fix: label proposal explicitly, display platform review separately, expose latest proposal from audit, retain reviewed ALCOHOL until platform review. Coverage: NONE proposal cannot downgrade the authoritative review in DB and browser tests.

### INFORMATIONAL — deployment and recovery gates remain

Provider/policy unavailability and post-SATISFIED attention are intentional fail-closed limitations, not claims of completed compliance or financial resolution. No severity is assigned to hypothetical abuse without a credible path.

## Privacy and audit

DOB is held transiently in the observation form/request and cleared at submission, hidden-page transition and form remount. It is not placed in URLs, browser storage, analytics or console logs. No identity number/image field is offered. Backend policy reduces DOB to bounded outcome evidence; recipient verification scans persisted rows for prohibited values. Existing request logging is allowlisted and excludes request bodies, query strings and raw error serialization.

OTP remains in the M16 flow; driver APIs do not return the valid code. Customer return views stop code and coordinate access. M17 adds no GPS history. Private licence evidence stays behind authenticated actor/tenant checks. Audit retains actor, target, transition and bounded reasons, not raw DOB, identity documents or coordinates. The public transport copy is a projection, not a replacement for the immutable original.

## Concurrency, capacity and deferred checks

Existing deterministic lock prefix is merchant → DriverProfile → affiliation → availability → OrderOperation → picking → Delivery → commitment, followed by handoff generation and recipient/return rows as required. Current authority is re-read inside the transaction. D does not replace this with browser state or process-local locking.

`verify-recipient.ts` retains success-versus-failure uniqueness, failed-compliance versus OTP exclusion, current-generation binding, immutable custody and audit rollback. D extends coverage with duplicate return arrival versus stale receipt, duplicate merchant receipts alongside native completion observation, and licence suspension versus OTP designation. Outcomes depend on the lock winner, never on sleeps.

Driver commitment stays ASSIGNED through failed verification, return travel, arrival awaiting receipt and attention. Merchant receipt and its audit atomically set return terminality, Delivery RETURNED_TO_STORE and commitment RETURNED. Successful M16 completion instead sets DELIVERED/COMPLETED. Neither path can release twice or coexist with the other.

The corrected `gospaza_recipient_consistency()` remains attached to recipient compliance, restricted return, delivery operation, dispatch commitment and delivery completion through deferred constraint triggers. Regression explicitly reaches COMMIT: valid state commits, missing compliance and custody/completion conflicts reject, and rollback restores generation/completion state. D adds no migration and does not modify the corrective function.

Native Order/payment/inventory/reservation/Return snapshots before and after physical return remain compared by the verifier. Receipt is not an inventory restock or financial event.

## M18 handoff and remaining gates

M18 may consume authoritative Order/Delivery/origin Store references, native fulfillment relationship, immutable restricted classification and purchaser evidence references, recipient outcome/bounded failure, physical manifest, return operation/status, returned timestamp, merchant receipt actor/evidence and `financial_review_required`.

M18 must independently decide refund amount/destination, native commercial Return, inventory disposition and financial adjustment with its own authorization/idempotency. It must not infer physical return from a refund or infer refund success from physical return.

Unresolved production launch gates: approved remote purchaser-verification mechanism; final Free State invoice/electronic original-copy format; alternate-adult counsel confirmation; school-going learner evidence sufficiency; Store-specific licence conditions; privacy retention periods; manual recovery procedure for fail-closed attention states. These have not been solved by adding UI.

## Verification — commands for the user

Working directory for all commands: `D:\Programming_projects\GoSpazaCodex`. Stop on any failure, return its leaf diagnostic, and do not advance to more expensive groups. Codex did not execute verification. PowerShell was used only to create required repository directories when normal file creation was unavailable.

### A. No dev servers: lint/typecheck/unit/build

Stop Next dev processes before type generation/build so `.next` is not concurrently written.

1. `pnpm run lint` — expect no errors or warnings; stop on failure.
2. `pnpm run typecheck` — expect all workspace checks to pass; stop on failure.
3. `pnpm --filter @gospaza/backend run test` — expect backend policy/RBAC/unit suite to pass; stop on failure.
4. `pnpm --filter @gospaza/api-client run test` — expect strict client payload and safe-error tests to pass; stop on failure.
5. `pnpm run build` — expect backend and all four app builds to pass; stop on failure.

### B. Backend / PostgreSQL / Redis

No D migration was added. `Migration20261027120000` is already user-verified. For a fresh or behind database only, run `pnpm --filter @gospaza/backend run db:migrate` before starting the backend; expect all pending migrations to apply, stop on failure. Do not edit migration tables or data manually.

Use the existing dedicated verification environment in both backend and verifier: same `HANDOFF_OTP_SECRET`; `PAYMENT_RECONCILIATION_WORKER_ENABLED=false`, `DISPATCH_WORKER_ENABLED=false`, `PICKUP_WORKER_ENABLED=false`, `HANDOFF_WORKER_ENABLED=false`; local APP_ENV and existing safe test Yoco configuration. M17 verifiers inject and restore their isolated policy/provider fixtures; do not enable a production purchaser bypass.

In a separate terminal, `pnpm --filter @gospaza/backend run dev` — wait for backend port 9000 readiness; stop if startup fails. No Next apps are required for these checks.

1. `pnpm --filter @gospaza/backend run test:restricted-commerce` — expect seller, classification, purchaser and trading policy verification to pass; stop on failure.
2. `pnpm --filter @gospaza/backend run test:recipient` — expect recipient/custody/COMMIT/concurrency/privacy verification and composed prerequisites to pass; stop on failure.
3. `pnpm --filter @gospaza/backend run test:handoff` — expect ordinary and restricted M16 handoff regression to pass; stop on failure.

### C. Dedicated M17 browser suite

`pnpm exec playwright test --config=playwright.m17.config.ts --workers=1`

Purpose: all four role surfaces are required by M17; the dedicated config starts those apps and restricts test selection. Browser fixtures mock backend HTTP; no live backend is required. Avoid concurrent builds and conflicting unrelated app servers. Expect every selected test to pass with no skipped failure chain; stop on failure. Mocked UI outcomes do not replace group B authority/concurrency tests.

### D. Full backend/browser regression

With backend/PostgreSQL/Redis ready as in B, run sequentially; each must pass and every failure stops the sequence:

1. `pnpm --filter @gospaza/backend run test:cart-foundation`
2. `pnpm --filter @gospaza/backend run test:cart-mutations`
3. `pnpm --filter @gospaza/backend run test:scheduling-foundation`
4. `pnpm --filter @gospaza/backend run test:delivery-reservations`
5. `pnpm --filter @gospaza/backend run test:checkout-foundation`
6. `pnpm --filter @gospaza/backend run test:payment-initiation`
7. `pnpm --filter @gospaza/backend run test:payment-reconciliation`
8. `pnpm --filter @gospaza/backend run test:order-operations`
9. `pnpm --filter @gospaza/backend run test:order-decisions`
10. `pnpm --filter @gospaza/backend run test:picking`
11. `pnpm --filter @gospaza/backend run test:shortages`
12. `pnpm --filter @gospaza/backend run test:drivers`
13. `pnpm --filter @gospaza/backend run test:dispatch`
14. `pnpm --filter @gospaza/backend run test:dispatch-orchestration`
15. `pnpm --filter @gospaza/backend run test:dispatch-acceptance`
16. `pnpm --filter @gospaza/backend run test:pickup`

These cover unchanged cart, scheduling, checkout/payment, merchant decision, picking/omission, eligibility and dispatch/pickup behavior. Group B covers M17 and handoff; avoid repeating it unless intervening changes require it.

Finally, with the required browser app ports available and no concurrent build: `pnpm exec playwright test --workers=1` — expect the complete browser regression, including ordinary grocery journeys, to pass; stop on failure.

## Materially changed files

- Backend: `src/lib/restricted-commerce.ts`, `src/lib/recipient-service.ts`, `src/lib/handoff-service.ts`; new `src/api/admin/gospaza/restricted-commerce/stores/route.ts`, `src/api/merchant/deliveries/returns/route.ts`; `src/scripts/verify-restricted-commerce.ts`, `src/scripts/verify-recipient.ts` (all under `apps/backend`).
- Contracts: `packages/contracts/src/restricted-commerce.ts`, `recipient.ts`, `handoff.ts`.
- API client: `packages/api-client/src/restricted-commerce.ts`, `recipient.ts`, `checkout.ts`; `tests/restricted-commerce.test.ts`, new `tests/restricted-checkout.test.ts`.
- Driver: new `apps/driver/app/recipient-panel.tsx`, `apps/driver/app/delivery-panel.tsx`.
- Customer: new `apps/customer/app/checkout/purchaser-panel.tsx`, `checkout/checkout-view.tsx`, `orders/delivery-panel.tsx`.
- Merchant: new `apps/merchant/app/merchant/compliance/page.tsx`, `returns/page.tsx`, `products/classification-panel.tsx`; `products/product-editor.tsx`, `shell.tsx`.
- Admin: new `apps/admin/app/admin/restricted-commerce/page.tsx`, `apps/admin/app/page.tsx`.
- Browser: new `tests/browser/restricted.spec.ts`, new `playwright.m17.config.ts`; `tests/browser/m15-readiness.ts`, `tests/browser/catalogue.spec.ts`.
- Documentation: this acceptance record and `MILESTONE_M17_ALCOHOL_COMPLIANCE.md`.
