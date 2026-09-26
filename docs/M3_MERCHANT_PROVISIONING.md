# M3 merchant review and provisioning

Implementation is complete pending user-run verification. Codex has not run installs, migrations, lint, typecheck, tests, builds or servers.

## Ownership decisions

The installed framework and core Medusa packages remain pinned to 2.18.0. Inspected the installed Store model, Stock Location model, createStockLocationsWorkflow, createSalesChannelsWorkflow, createCustomerAccountWorkflow and native authenticate middleware, alongside the official marketplace/vendor recipe.

- Native Store holds commerce defaults (currencies/locales, default channel, region and location). It is retained as platform commerce configuration in GoSpaza, not used as a merchant tenant. Multiple native Store records are possible; they do not themselves enforce marketplace ownership.
- Custom Merchant holds the approved business snapshot and unique source application. MerchantStore is the physical premises, with an independently identified structured address and one-per-merchant constraint. MerchantMember maps the application's native auth identity to its initial active OWNER. These are marketplace concerns, not replacements for native commerce resources.
- Stock Location is deferred to M5 inventory: M3 has no stock, inventory levels, shipping or fulfillment operations requiring it. The nullable medusa_stock_location_id remains null; no native links are persisted in M3. A supported module link and native provisioning workflow must be selected when inventory actually needs it.
- Sales Channel and fulfillment/location associations are also deferred. No products, inventory items, shipping options or other native commerce resources are created.
- Native session authentication is reused. No passwords, tokens, native commerce tables or auth metadata are copied or directly mutated. A Medusa workflow uses createWorkflow/createStep/StepResponse/WorkflowResponse to invoke the complete atomic provisioning transaction.

References: [Store module](https://docs.medusajs.com/resources/commerce-modules/store), [stock locations](https://docs.medusajs.com/resources/commerce-modules/stock-location/concepts), [vendor recipe](https://docs.medusajs.com/resources/recipes/marketplace/examples/vendors). Current documentation may describe versions newer than the installed packages; the installed 2.18.0 source defines the implementation APIs.

## Lifecycle and API

All decisions are POST actions under /admin/gospaza/merchant-applications/:id:

| Action | Required current state | New state | Body |
| --- | --- | --- | --- |
| start-review | SUBMITTED | UNDER_REVIEW | {} |
| request-information | UNDER_REVIEW | MORE_INFORMATION_REQUIRED | reason, 1–2000 trimmed characters |
| reject | UNDER_REVIEW | REJECTED | reason, 1–2000 trimmed characters |
| approve | UNDER_REVIEW | APPROVED | confirmed: true and reason |

Review decisions require a native platform-user session. There is no generic status setter, owner selector or native resource selector. Request-information, rejection and approval reasons are applicant-visible. Approval replay returns the existing tenant without adding another event or reactivating disabled records.

GET /admin/gospaza/merchant-applications/:id/review-history includes platform-user attribution. GET /merchant/applications/:id/review-history enforces authenticated ownership and omits platform-user identifiers. Application detail responses also contain review_history and an approved tenant summary when active. Drafts remain invisible to admin review.

Applicants can edit/upload/remove/submit only in DRAFT or MORE_INFORMATION_REQUIRED. Resubmission records RESUBMITTED and last_submitted_at, preserving submitted_at forever. REJECTED remains read-only and create-draft retries return that same application. Approval, rejection and review actions cannot be set through applicant patches.

## Transaction and retry behavior

The workflow's single business step locks the application and performs all custom-table changes in one PostgreSQL transaction. It validates UNDER_REVIEW, resolves or inserts Merchant, MerchantStore and the OWNER derived from applicant_identity_id, appends the approval event, and finally changes the application to APPROVED. No external resource needs compensation in M3.

Unique constraints enforce one merchant per application, one MVP store per merchant, and one owner membership per merchant and per auth identity. The MVP membership uniqueness is intentionally limited to the initial owner; M4 must explicitly evolve it when team management is introduced. Foreign keys protect custom-domain references. Review records cannot be updated; no review-delete API is exposed. Approval events have an additional one-per-application unique index.

Concurrent approvals serialize on the application row; replay after a lost response resolves the committed tenant. Failed inserts roll back the entire transaction. Consistent pre-existing partial snapshots are completed; mismatched, archived or inactive partial records fail visibly rather than being overwritten or silently reactivated. Failed approval leaves the application non-APPROVED. Review and applicant mutations use the same row lock.

## Tenant resolution

Every non-application /merchant route first uses native merchant session authentication, then resolves:

native auth_identity_id → active MerchantMember → active Merchant → MerchantStore, with a matching approved source application.

GET /merchant/me returns merchant { id, legal_name, trading_name }, store { id, name }, membership { member_type }. It replaces the M1 identity-only probe. A fake merchant_id in native auth metadata is insufficient. Request body, query and header merchant IDs are never used for resolution. No active context returns 401; this preserves the existing rejection behavior for unprovisioned identities.

The reusable middleware stores context on the current request only. Membership is re-read on each request, so stale sessions cannot bypass inactive/deleted membership or merchant status. Existing applicant sessions work after approval without rewriting session actor IDs or requiring a second login. The application's read-only page remains available if operational membership later becomes inactive.

## UI

Admin detail exposes only legal actions, records reasons, confirms decisions, reconciles failed responses with a read, and displays review history. Applicant information requests unlock the existing form and document controls; background session refresh and document changes preserve unsaved fields. Rejected applicants see the reason and no mutation controls. Approved applicants see a restrained merchant/store setup summary. No operational dashboard, team UI or catalogue is introduced.

## Static security review

Critical: None identified in static review.
High: None identified in static review.
Medium: None identified in static review. Runtime verification remains outstanding; no runtime assurances are claimed.
Low / hardening: Role/capability expansion belongs to M4; M3 uses the existing native platform-user boundary as specified. No suspension workflow is exposed.

Reviewed boundaries: native session-only actor checks; browser-origin checks on admin mutations; strict decision schemas and confirmation; owner derived only from the source application; unique constraints and serialized approval; private document access retained; applicant history ownership; safe tenant DTOs; membership status checked on every operational request. Review reasons are plain text and must not contain document contents or credentials.

## Commands for user to run

All commands are one line, from repository root. Stop at any failure and return its output.

1. pnpm run lint — expected no errors or warnings.
2. pnpm run typecheck — expected all workspace typechecks pass.
3. pnpm test — expected unit suites pass, including review transitions and strict input validation.
4. docker compose up -d --wait — only if local PostgreSQL/Redis are not already healthy; expected both healthy.
5. pnpm run db:migrate — expected custom migrations and native link synchronization complete; no new M3 native links.
6. node scripts/dev-supervisor.mjs — run in terminal A and wait for backend and four apps to be ready. Keep it running for the next checks in terminal B.
7. pnpm --filter @gospaza/backend run test:integration — expected native auth regression passes; fake merchant actor IDs now correctly lack tenancy.
8. pnpm --filter @gospaza/backend run test:applications — expected M2 ownership/private-file/submission coverage passes, with M3 actions rejecting invalid transitions.
9. pnpm --filter @gospaza/backend run test:provisioning — expected M3 real-DB/API tests pass and all tracked fixtures are cleaned up.
10. pnpm run test:browser — expected all existing and M3 browser journeys pass. Browser mocks do not replace database tests.
11. After Ctrl+C and confirmed app shutdown, pnpm run build — expected all applications build successfully.

Do not reset the database. The integration fixtures use unique m3- prefixes and tracked identities. Cleanup reports failures. Migrations add custom-domain foreign keys, so fixture cleanup removes members/stores/merchants before applications. No dependency changes or installation are needed for M3.

## Not implemented

M4 team/roles/invitations, suspension workflows, catalogue/inventory, native location provisioning, service zones, customer discovery, carts/orders/payments, bank details/commission/finance/settlements, driver operations, notifications, broad audit/reporting and deployment infrastructure.
