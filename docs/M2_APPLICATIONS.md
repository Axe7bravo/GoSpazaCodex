# M2 — Merchant applications

## Ownership and scope

Medusa 2.18.0 remains pinned. M2 reuses EmailPass and native sessions. Public merchant registration now creates an applicant login through /auth/merchant/emailpass/register; it does not set merchant_id, create a Merchant, or create membership. Customer registration is unchanged; public driver/user registration remains blocked.

Only /merchant/applicant/me and /merchant/applications/* permit an authenticated merchant auth identity without a provisioned actor ID. Existing /merchant/me and other operational merchant paths still require the provisioned merchant actor. Application ownership uses authenticated auth_identity_id, never email or a browser-supplied owner ID. The applicant probe returns only { applicant: true }; the browser session type explicitly has application scope and no merchant ID. Native auth identity references remain server-side.

The marketplace module owns MerchantApplication and MerchantApplicationDocument. Onboarding state is not a native Medusa commerce entity. No Store, Stock Location, Merchant, membership, commission or commerce data is created. The auth identity reference crosses the module boundary without duplicating credentials or creating a speculative business link.

A database unique constraint permits one application per identity. Draft creation retries return the same application. Draft edit, submit and document changes serialize on the application's PostgreSQL row lock. Concurrent submissions preserve one timestamp. A database trigger prevents changing that timestamp or resetting submitted state to DRAFT. No final-decision mutation is exposed.

## Journey and APIs

Merchant /apply creates an applicant login; /login handles returning applicants. The portal root and /application start a draft, resume editing, or display a read-only submitted/later state. Submission validates all contact/address fields; address line 2 and notes are optional. Documents are optional in M2 because no legally sufficient document set has been specified. Alcohol intent and document categories do not establish regulatory compliance.

Applicant routes:
- GET /merchant/applicant/me
- POST /merchant/applications (empty JSON body; idempotent draft creation)
- GET /merchant/applications/me
- PATCH /merchant/applications/:id (editable field allowlist only)
- POST /merchant/applications/:id/documents
- DELETE /merchant/applications/:id/documents/:documentId
- POST /merchant/applications/:id/submit (empty JSON body)
- GET /merchant/applications/:id/documents/:documentId/access

Platform-user-only, read-only routes:
- GET /admin/gospaza/merchant-applications?status=SUBMITTED&q=shop&limit=20&offset=0
- GET /admin/gospaza/merchant-applications/:id
- GET /admin/gospaza/merchant-applications/:id/documents/:documentId/access

Admin screens are /admin/merchant-applications and /admin/merchant-applications/[id] on port 3003. They exclude drafts, support search/status/pagination, and provide authorized document downloads. No approve/reject/provision controls exist. Full platform capabilities remain deferred.

## Native private file storage

Inspected native File Module createFiles/deleteFiles/getAsBuffer, Local and S3 providers. The native abstraction supports access: private and authenticated byte retrieval, so no parallel storage provider was introduced. Marketplace owns document metadata and storage references; File Module/provider owns bytes. Files never enter PostgreSQL. Original names are display metadata only: uploads use server-generated UUID filenames.

Local provider defaults put private files in static, so M2 explicitly overrides private_upload_dir to repository .private/merchant-documents. It is gitignored and outside served paths. Do not serve, publish, or symlink this directory into static/public. APPLICATION_FILES_LOCAL_DIR can specify another private absolute path. Existing local .env files need no changes unless choosing another directory.

APPLICATION_FILES_PROVIDER defaults to local for development/test. Staging/production refuse local storage and require s3 plus APPLICATION_FILES_S3_ENDPOINT (HTTPS), APPLICATION_FILES_S3_BUCKET, APPLICATION_FILES_S3_REGION, APPLICATION_FILES_S3_ACCESS_KEY_ID, APPLICATION_FILES_S3_SECRET_ACCESS_KEY. Configure a dedicated private bucket, blocked public access, and credentials limited to that bucket. The native provider uses private ACLs, a merchant-applications/ prefix and private/no-store caching. The S3-compatible service must support private ACLs. No infrastructure is provisioned. Do not change providers/directories with existing documents without migrating bytes; storage references belong to the configured provider.

Uploads use bounded JSON with base64 content: document_type, display_name, mime_type, content. Binary limit is 10 MB; route body limit is 14 MB for base64 overhead. PDF/JPEG/PNG signatures and declared MIME must match; names and metadata are bounded. Maximum 20 documents per application. This is format validation, not malware scanning or legal-document validation. Documents are attachments with nosniff, sandbox and no-store headers after fresh actor/ownership checks. Neither public URLs nor storage keys are returned.

## File lifecycle and limitations

Upload holds the draft row lock while storing bytes and inserting metadata. Persistence failure triggers native file deletion; cleanup failure fails the request explicitly. A process crash or ambiguous database commit during file I/O can require operator reconciliation: no distributed transaction between storage and PostgreSQL is claimed.

Removal first authorizes owner and draft state, then persists removal_pending. Pending documents cannot be downloaded and block submission. It deletes bytes, then metadata. Storage failure is visible and the UI offers Retry removal; repeat completed removals are safe. There is no automatic purge or deletion of unrelated data. Submitted applications cannot remove/replace files.

Auth throttling from M1 remains; uploads are bounded by size and per-application count. Production ingress rate limits, malware scanning, retention policy, capabilities and MFA are not implemented here. Database/file failures are not represented as successful actions.

## Commands for user to run

All commands are single lines from the repository root. Stop on every failure. Preserve existing environment files, databases and private directories. No new package dependencies were introduced.

1. `pnpm run lint` — expect no lint errors.
2. `pnpm run typecheck` — expect all workspace checks to pass.
3. `pnpm test` — expect existing and new unit/client/security tests to pass.
4. `pnpm run db:migrate` — with existing local PostgreSQL/Redis available, apply the marketplace tables, constraints and timestamp trigger. Expect successful migrations/link sync. The migration is checked in; no generation command is needed.
5. `pnpm run dev` — leave backend and frontends running; API 9000, frontends 3000–3003.
6. `pnpm --filter @gospaza/backend run test:applications` — another terminal; expect M2 application integration passed and successful cleanup. Uses the same local database/provider as the running backend and refuses non-local environments.
7. `pnpm --filter @gospaza/backend run test:integration` — expect M1 regression coverage to pass. Public merchant registration is intentionally allowed now. Wait one minute between rapid auth-suite runs if throttling reports 429.
8. `pnpm run test:browser` — expect existing auth tests plus M2 applicant/admin UI tests to pass. Chromium from M1 is a prerequisite.
9. Stop development with Ctrl+C, then `pnpm run build` — expect all builds/checks to succeed.

Manual checks: register on merchant /apply, save a draft, upload a PDF/JPEG/PNG, reload, download/remove, and submit. Confirm later edits are rejected. In a separate browser profile sign into the existing platform-user account and inspect submitted application/documents. A second applicant must never gain access using guessed IDs. Inspect narrow and wide layouts. Do not use real identity documents in local tests.

The integration script creates only unique synthetic native identities/users and applications; cleanup is scoped to this run's tracked IDs. It verifies ownership, wrong actors, unique draft creation, idempotent submission, read-only state, format/size limits, private access, persistence compensation, failed-deletion retry and read-only admin. Browser tests mock HTTP for UI states; they do not replace real integration evidence.

## Static security review

Critical: None identified in static review; runtime verification pending.
High: None identified in static review; bucket privacy must be enforced operationally.
Medium: No malware scanning or production ingress throttling; bounded private attachments reduce but do not eliminate upload risks. Crash reconciliation is manual.
Low / hardening: Full admin capability/MFA and retention configuration are deferred.
Verified boundaries (static): session actor checks, owner-scoped queries, strict field allowlists, draft row locks, private native provider access, no public storage DTOs, no final-decision routes.
Tests added: validation/DTO/config unit checks; real database/API ownership, race and file lifecycle coverage; applicant/admin browser states.

No command-heavy verification was executed by Codex. All M2 results await user verification. M3 is not implemented.

Native references: [Module database operations](https://docs.medusajs.com/learn/fundamentals/modules/db-operations), [Module isolation](https://docs.medusajs.com/learn/fundamentals/modules/isolation). File behavior was inspected directly in pinned 2.18.0 packages.
