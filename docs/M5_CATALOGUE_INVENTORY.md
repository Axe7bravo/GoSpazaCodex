# M5 catalogue and inventory

Implementation awaits user-run verification. Medusa remains pinned to 2.18.0.

## Native ownership

Native Product, ProductVariant/options, Pricing, InventoryItem/InventoryLevel, StockLocation, SalesChannel and image relationships remain authoritative. The pinned core workflows create inventory items and price-set links for managed variants. No native Medusa Store is created for a merchant.

```text
Merchant ── unique mapping ── SalesChannel ── native link ── StockLocation
   │                                │                          │
   │                         native product link         MerchantStore
   └─ ProductMarketplaceProfile ── read-only module link ── Product
                                                           │
                                                       Variant
                                                           │
                                                     InventoryItem
                                                           │
                                                 InventoryLevel at location
```

ProductMarketplaceProfile holds merchant ownership and the restricted-product flag, with one unique native product reference. Its merchant foreign key references only a GoSpaza table. A supported read-only module link resolves the native Product; the native ID is unique, so one product cannot acquire a second merchant owner. Merchant and MerchantStore use unique native ID mappings plus supported read-only links. No foreign keys point into Medusa-owned tables.

CatalogueMedia stores provider references solely for cleanup, not product image relationships. Product images remain native. Merchant API DTOs expose only tracked public images, never application-document references or arbitrary native image URLs.

## Provisioning

`commerce:backfill` calls the same `ensureCommerce` service as future approval. It serializes by merchant using a PostgreSQL advisory transaction lock, resolves existing mappings, and creates missing infrastructure through native create-channel/create-location/link workflows. Both marketplace mappings are committed together after the native link completes. Repetition and simultaneous calls reuse the same mappings. GET routes never create infrastructure.

The store address comes from the approved application snapshot. Missing, disabled or inconsistent topology fails closed. M3's custom approval transaction is retained; a native setup failure does not undo its completed audit/approval. Retry approval or run backfill to finish setup. Core workflow compensation handles reported native failures. Abrupt process termination with incomplete compensation may require operator reconciliation; no bulk resource deletion or guessed ownership reconciliation is performed.

## Product and stock behavior

OWNER and MANAGER receive catalogue/inventory view and manage capabilities; PICKER receives view only. All routes resolve authenticated membership and check ownership on the backend. Sales Channel is not authorization.

Create simple or predefined variants using native options (for example 500g/1kg/2kg). Every variant has ZAR price, optional SKU and discrete stocked units; backorders are disabled. Product creation remains draft until ownership and inventory levels exist, then applies requested native publication status. Setting draft is the routine removal mechanism; no product hard-delete endpoint is exposed.

Prices cross the GoSpaza API as integer cents. Medusa 2.18 uses major units; conversion uses exact decimal strings/BigInt (10999 ↔ 109.99). Updates use the native variant workflow, binding price changes by variant ID rather than array position.

Existing variant names/count are fixed in this M5 editor; title/description/compliance/status, SKU, price and stocked quantities remain editable. There is no live weight repricing. Native stocked, reserved and available values are displayed; only stocked is writable. Merchant stock writes serialize by merchant and use absolute quantities: the last serialized successful writer wins. Reservations remain native and are never overwritten by this API.

Product search/status/pagination uses native queries. Inventory search/pagination is performed server-side over the authenticated merchant's native variant DTOs; this is suitable for initial catalogue scale but is not a large-catalogue query optimization.

## File Module adapter

Medusa 2.18 supports one File Module provider. `routed-file` implements its public provider contract using Node filesystem APIs and the public AWS SDK as an S3-compatible client for **Cloudflare R2**, GoSpaza's selected production object storage. AWS SDK package names do not imply AWS hosting. It does not import Medusa provider internals or register a second provider. AWS SDK client-s3 and s3-request-presigner are direct dependencies pinned to versions already present transitively in the lockfile.

| Class | New key namespace | Local development | Production |
| --- | --- | --- | --- |
| Private | merchant-applications/gospaza-private-v1/ | Existing private document directory | Dedicated private Cloudflare R2 bucket and credentials |
| Public | gospaza-public-v1/ | backend/static/catalogue | Dedicated public Cloudflare R2 bucket with production custom domain |

All unclassified/legacy keys resolve as private, including existing local private-* and S3 merchant-applications/* references. They are read/deleted at their original keys; no migration, copy or exposure occurs. New private keys retain the M2 merchant-applications/ prefix, including compatibility with prefix-scoped S3 policies. Do not change the existing private directory/bucket or its disabled-public-access policy. Private uploads retain no-store behavior and return no public URL. R2 does not support object ACLs, so the adapter omits ACL headers for R2 endpoints; private access is enforced by the private bucket configuration and scoped credentials. Other S3-compatible endpoints retain the existing private ACL behavior. M2 authenticated document streaming is unchanged. Private R2 presigned retrieval is short-lived (60 seconds) and available only through server File Module calls. Presigned URLs use the R2 S3 API endpoint, never the public custom domain. The existing authorized M2 streaming routes remain the document access boundary.

Application routes hard-code private. Catalogue routes hard-code public and accept only validated image bytes, never bucket, provider, destination, URL or file key. New keys use server-generated UUIDs. Retrieval/deletion classify the key, not a caller flag.

Catalogue upload accepts JPEG/PNG/WebP, up to 5 MiB, checks signatures and canonical base64, and limits products to ten images. This is signature validation, not an antivirus or full image decoder. Direct presigned uploads are unsupported so actor routes cannot bypass validation.

Public files receive browser URLs. Failed writes attempt cleanup and propagate cleanup errors. Successful files are tracked before native image mutation. Failed mutations mark retained cleanup records pending. Removal detaches the native relationship, checks native image/thumbnail references, and deletes only unreferenced objects. Referenced/failed deletions remain pending. `catalogue:cleanup` retries only those explicit public records; it never scans/deletes application objects.

Production uses two dedicated Cloudflare R2 buckets. Keep `APPLICATION_FILES_PROVIDER=s3` and `CATALOGUE_FILES_PROVIDER=s3`: `s3` and the existing `_S3_*` environment names identify the compatible protocol, not AWS hosting. Existing variable names remain compatible; no credentials, objects or keys are migrated.

- Set each `_S3_ENDPOINT` to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (or the appropriate jurisdictional R2 endpoint), and each `_S3_REGION` to `auto`. Endpoints, bucket names and credentials remain independently configurable.
- Private bucket: public access disabled, no public custom domain, and `r2.dev` disabled. Never relax its access policy.
- Public catalogue bucket: attach a production Cloudflare custom domain and set `CATALOGUE_FILES_PUBLIC_URL` to its HTTPS origin, such as `https://media.example.com`. Leave `r2.dev` disabled; do not use it for production URLs. The custom domain must map to this bucket's object-key root.
- Use separate R2 API credentials with **Object Read & Write**, each scoped to only its required bucket, rather than account-wide administrative permissions. Backend credentials never enter browser environment variables.

Bucket names must differ. Local storage is rejected for staging/production. These are deployment configuration requirements; this repository does not modify R2 buckets or public-access settings.

Cloudflare references: [S3 compatibility and region](https://developers.cloudflare.com/r2/api/s3/api/), [bucket-scoped credentials and endpoints](https://developers.cloudflare.com/r2/api/tokens/), [public custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## APIs and UI

- GET/POST /merchant/products
- GET/PATCH /merchant/products/:id (includes status, variant price/stock)
- POST /merchant/products/:id/images
- DELETE /merchant/products/:id/images/:imageId
- GET /merchant/inventory
- PATCH /merchant/inventory/:inventoryItemId

UI routes: /merchant/products, /merchant/products/new, /merchant/products/[id], /merchant/inventory. They use the existing portal shell, with loading/error/empty states and read-only picker controls. Server capabilities remain authoritative.

## Static security review

- Critical: none identified in static review.
- High: none identified in static review.
- Medium: production bucket/CDN policies and runtime native workflows require user verification.
- Hardening/limits: signature checks are not malware scanning; interrupted process recovery and native Admin edits outside merchant workflows require operational care.
- Reviewed boundaries: native merchant sessions; active tenancy; reusable backend capabilities; strict input allowlists; owned product/variant/inventory/image checks; private-default key routing; separate storage; no provider credentials in DTOs; errors/cleanup are not swallowed.
- Added tests: policy/money/media validation; provider public/private/legacy/S3 routing; real database/API provisioning, rollback, ownership, reservations and concurrent stock writes; browser catalogue/inventory journeys. These tests have not been executed by Codex.

## Commands for user to run

All commands below run from the repository root, one PowerShell line each. Stop on any failure. Keep the existing local environment values; new local catalogue configuration defaults to local even before adding the example variable. PostgreSQL/Redis must already be available for migration/runtime checks.

1. `pnpm install --frozen-lockfile` — link direct SDK dependencies; expect installation to complete without lockfile changes.
2. `pnpm run lint` — expect no errors/warnings.
3. `pnpm run typecheck` — expect all workspace typechecks to finish.
4. `pnpm run test` — expect unit tests, including storage and catalogue policy, to pass.
5. `pnpm run db:migrate` — expect native/custom migrations and link synchronization to finish.
6. `pnpm --filter @gospaza/backend run commerce:backfill` — provision existing active merchants.
7. `pnpm --filter @gospaza/backend run commerce:backfill` — repeat safely; no new mappings/resources.
8. `pnpm run dev` — keep running in a separate terminal; expect all five apps ready.
9. `pnpm --filter @gospaza/backend run test:catalogue` — expect M5 integration passed and successful fixture cleanup. Uses loopback development/test backend and local catalogue storage; do not concurrently edit catalogue data during fault-injection checks.
10. `pnpm --filter @gospaza/backend run test:integration` — M1 native auth regression.
11. `pnpm --filter @gospaza/backend run test:applications` — M2 private document/access regression.
12. `pnpm --filter @gospaza/backend run test:provisioning` — M3 approval/rollback regression with M5 topology and scoped native cleanup.
13. `pnpm --filter @gospaza/backend run test:team` — M4 real database RBAC/invitation regression.
14. `pnpm run test:browser` — expect all M1–M5 browser tests to pass.
15. Stop development with Ctrl+C, then `pnpm run build` — expect all workspace builds to finish.

Targeted browser rerun: `pnpm run test:browser -- tests/browser/catalogue.spec.ts`.
After a reported public-file cleanup failure only: `pnpm --filter @gospaza/backend run catalogue:cleanup`; expect unreferenced pending files removed, still-referenced objects retained.

Production storage must additionally be checked with synthetic uploads: public catalogue URL works without authentication; private/legacy application document access requires its existing authorized route, with direct bucket requests denied. Unit S3 command tests do not prove deployed bucket policy.

No M6 discovery/serviceability, carts, orders, payments, picking, variable-weight repricing, delivery or finance is implemented.
