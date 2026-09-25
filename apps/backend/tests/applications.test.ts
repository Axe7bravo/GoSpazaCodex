import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationFields, parse, patchSchema, validateSubmission, validateDocument, MAX_FILE_BYTES } from "../src/modules/marketplace/validation";
import { merchantBoundary } from "../src/lib/applicant-auth";
import { privateFileConfig } from "../src/lib/private-file-config";
import { appDTO, documentDTO } from "../src/lib/application-http";
import type { ApplicationRow, DocumentRow } from "../src/modules/marketplace/service";
const complete = { legal_name: "Fixture business", trading_name: "Fixture shop", contact_name: "Applicant", contact_email: "fixture@example.test", contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Test city", province: "Test province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "" };
test("draft patches accept incomplete fields but reject ownership/status injection", () => {
  assert.deepEqual(parse(patchSchema, { legal_name: "Shop" }), { legal_name: "Shop" });
  for (const field of ["status", "applicant_identity_id", "submitted_at", "merchant_id"]) assert.throws(() => parse(patchSchema, { [field]: "injected" }));
  assert.doesNotThrow(() => validateSubmission(complete));
  assert.throws(() => validateSubmission({ ...complete, city: "" }));
  assert.throws(() => parse(applicationFields, { ...complete, contact_email: "invalid" }));
});
const specimens = [
  { mime_type: "application/pdf", bytes: Buffer.from("%PDF-1.4\nfixture\n%%EOF") },
  { mime_type: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") },
  { mime_type: "image/jpeg", bytes: Buffer.from([255,216,255,224,0,2,255,217]) },
];
test("document validation checks contents, size, metadata and display-name safety", () => {
  for (const specimen of specimens) {
    const data = { document_type: "OTHER", display_name: "../../fixture", mime_type: specimen.mime_type, content: specimen.bytes.toString("base64") };
    assert.equal(validateDocument(data).display_name, "fixture");
    assert.throws(() => validateDocument({ ...data, content: Buffer.from("not a file").toString("base64") }));
    assert.throws(() => validateDocument({ ...data, mime_type: "text/html" }));
    assert.throws(() => validateDocument({ ...data, content: "a".repeat(4 * Math.ceil(MAX_FILE_BYTES / 3) + 4) }));
  }
  assert.throws(() => validateDocument({ document_type: "OTHER", display_name: "fake.png", mime_type: "image/png", content: specimens[0]!.bytes.toString("base64") }));
});
test("local private storage is never configured under served paths or for production", () => {
  assert.throws(() => privateFileConfig({ APP_ENV: "production" }));
  assert.throws(() => privateFileConfig({ APP_ENV: "development", APPLICATION_FILES_LOCAL_DIR: "./static/private" }));
  assert.doesNotThrow(() => privateFileConfig({ APP_ENV: "test", APPLICATION_FILES_LOCAL_DIR: "./.private-tests" }));
});
test("application and document DTOs exclude ownership and storage internals", () => {
  const application = appDTO({ ...complete, id: "mapp_fixture", applicant_identity_id: "private-auth-reference", status: "DRAFT", submitted_at: null } as ApplicationRow);
  assert.equal("applicant_identity_id" in application, false);
  const document = documentDTO({ id: "madoc_fixture", storage_key: "private-key", application_id: "mapp_fixture" } as DocumentRow);
  assert.equal("storage_key" in document, false); assert.equal("application_id" in document, false);
});

test("actorless merchant sessions are limited to applicant routes", async () => {
  for (const actor of ["merchant", "customer", "driver", "user"]) {
    for (const path of ["/merchant/applicant/me", "/merchant/applications/me", "/merchant/me", "/merchant/orders"]) {
      let allowed = false; let status = 0;
      const req = { originalUrl: path, path: "/", headers: {}, session: { auth_context: { actor_type: actor, actor_id: "", auth_identity_id: "fixture_identity" } },
        scope: { resolve: () => ({ projectConfig: { http: { jwtSecret: "unit-fixture-only" } } }) },
      } as unknown as import("@medusajs/framework/http").MedusaRequest;
      const res = { status(value: number) { status = value; return this; }, json() {} } as unknown as import("@medusajs/framework/http").MedusaResponse;
      await merchantBoundary(req, res, () => { allowed = true; });
      const expected = actor === "merchant" && (path.includes("/applicant/") || path.includes("/applications/"));
      assert.equal(allowed, expected); if (!expected) assert.equal(status, 401);
    }
  }
});
