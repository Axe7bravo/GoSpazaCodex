import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IAuthModuleService, IUserModuleService, IFileModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import MarketplaceService from "../modules/marketplace/service";
import { MAX_FILE_BYTES, validateDocument } from "../modules/marketplace/validation";

export default async function verifyApplications({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M2 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const files = container.resolve<IFileModuleService>(Modules.FILE);
  const market = container.resolve<MarketplaceService>("marketplace");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const prefix = "m2-" + randomUUID(); const password = randomBytes(24).toString("hex");
  const identities: string[] = []; const userIds: string[] = []; const cookies: string[] = []; const appIds: string[] = [];
  const failures: unknown[] = [];
  async function request(path: string, cookie?: string, method = "GET", body?: unknown, token?: string) {
    return fetch(new URL(path, base), { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  }
  async function session(actor: string, suffix: string, platform = false) {
    const email = prefix + suffix + "@example.test";
    // Merchant registration uses the public native route. Other identities are internal fixtures only.
    if (actor === "merchant") {
      assert.equal((await request("/auth/merchant/emailpass/register", undefined, "POST", { email, password })).status, 200);
    } else {
      const created = await auth.register("emailpass", { body: { email, password } }); assert.ok(created.success);
    }
    const identity = await auth.authenticate("emailpass", { body: { email, password } }); assert.ok(identity.authIdentity);
    identities.push(identity.authIdentity.id);
    if (platform) {
      const user = await users.createUsers({ email }); userIds.push(user.id);
      await auth.updateAuthIdentities({ id: identity.authIdentity.id, app_metadata: { user_id: user.id } });
    }
    const login = await request("/auth/" + actor + "/emailpass", undefined, "POST", { email, password }); assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    const response = await request("/auth/session", undefined, "POST", undefined, token); assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((s) => s.split(";")[0]).join("; "); assert.ok(cookie); cookies.push(cookie);
    return { cookie, owner: identity.authIdentity.id };
  }
  const fields = { legal_name: prefix, trading_name: prefix + " shop", contact_name: "Fixture applicant", contact_email: prefix + "@example.test", contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Test city", province: "Test province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: true, notes: "Synthetic fixture" };
  const document = { document_type: "OTHER", display_name: "../../fixture.pdf", mime_type: "application/pdf", content: Buffer.from("%PDF-1.4\nfixture\n%%EOF").toString("base64") };
  try {
    assert.equal((await request("/merchant/applications/me")).status, 401);
    const a = await session("merchant", "-a"); const b = await session("merchant", "-b");
    const admin = await session("user", "-admin", true);
    for (const actor of ["customer", "driver"]) {
      const other = await session(actor, "-" + actor);
      assert.equal((await request("/merchant/applications/me", other.cookie)).status, 401);
      assert.equal((await request("/admin/gospaza/merchant-applications", other.cookie)).status, 401);
    }
    assert.equal((await request("/merchant/applications/me", admin.cookie)).status, 401);
    assert.equal((await request("/admin/gospaza/merchant-applications", a.cookie)).status, 401);
    assert.equal((await request("/merchant/me", a.cookie)).status, 401, "applicant has no operational merchant identity");
    assert.equal((await request("/merchant/applicant/me", a.cookie)).status, 200);
    assert.equal((await (await request("/merchant/applications/me", a.cookie)).json()).application, null);
    const creates = await Promise.all([request("/merchant/applications", a.cookie, "POST", {}), request("/merchant/applications", a.cookie, "POST", {})]);
    for (const response of creates) assert.equal(response.status, 200);
    const created = await creates[0]!.json(); const repeated = await creates[1]!.json();
    assert.equal(created.application.id, repeated.application.id, "one application per auth identity");
    const id: string = created.application.id; appIds.push(id); const path = "/merchant/applications/" + id;
    const bCreated = await request("/merchant/applications", b.cookie, "POST", {}); assert.equal(bCreated.status, 200);
    const bid: string = (await bCreated.json()).application.id; appIds.push(bid);
    assert.equal((await request(path, b.cookie)).status, 404);
    assert.equal((await (await request("/merchant/applications/me", b.cookie)).json()).application.id, bid);
    assert.equal((await request(path, b.cookie, "PATCH", { legal_name: "stolen" })).status, 404);
    assert.equal((await request(path + "/documents", b.cookie, "POST", document)).status, 404);
    assert.equal((await request(path + "/submit", b.cookie, "POST", {})).status, 404);
    assert.equal((await request(path, a.cookie, "PATCH", { status: "APPROVED" })).status, 400);
    assert.equal((await request(path, a.cookie, "PATCH", { applicant_identity_id: b.owner })).status, 400);
    assert.equal((await request(path + "/submit", a.cookie, "POST", {})).status, 400);
    assert.equal((await request(path, a.cookie, "PATCH", fields)).status, 200);
    const draftList = await request("/admin/gospaza/merchant-applications?q=" + prefix, admin.cookie); assert.equal(draftList.status, 200);
    assert.equal((await draftList.json()).count, 0, "admin list excludes drafts");
    assert.equal((await request("/admin/gospaza/merchant-applications/" + id, admin.cookie)).status, 404);
    assert.equal((await request(path + "/documents", a.cookie, "POST", { ...document, content: Buffer.from("fake").toString("base64") })).status, 400);
    assert.equal((await request(path + "/documents", a.cookie, "POST", { ...document, content: "a".repeat(4 * Math.ceil(MAX_FILE_BYTES / 3) + 4) })).status, 400);
    const uploaded = await request(path + "/documents", a.cookie, "POST", document); assert.equal(uploaded.status, 200);
    const uploadBody = await uploaded.json(); const documentId: string = uploadBody.documents[0].id;
    assert.equal(uploadBody.documents[0].display_name, "fixture.pdf"); assert.equal("storage_key" in uploadBody.documents[0], false);
    assert.equal("applicant_identity_id" in uploadBody.application, false);
    const accessPath = path + "/documents/" + documentId + "/access";
    assert.equal((await request(accessPath)).status, 401); assert.equal((await request(accessPath, b.cookie)).status, 404);
    assert.equal((await request(path + "/documents/" + documentId, b.cookie, "DELETE")).status, 404);
    const access = await request(accessPath, a.cookie); assert.equal(access.status, 200);
    assert.equal(access.headers.get("cache-control"), "private, no-store"); assert.match(access.headers.get("content-disposition")!, /^attachment/);
    assert.equal(await access.text(), Buffer.from(document.content, "base64").toString());
    const stored = await market.document(id, documentId, a.owner);
    assert.ok(!stored.storage_key.includes("fixture.pdf") && !stored.storage_key.includes(".."));
    if ((process.env.APPLICATION_FILES_PROVIDER ?? "local") === "local") assert.equal((await request("/static/" + encodeURIComponent(stored.storage_key))).status, 404);
    // Force a DB constraint failure after an actual file upload; compensation must remove it.
    let compensationKey = "";
    const observed = Object.create(files) as IFileModuleService;
    observed.createFiles = (async (data: Parameters<IFileModuleService["createFiles"]>[0]) => { const result = await files.createFiles(data); compensationKey = result.id; return result; }) as IFileModuleService["createFiles"];
    observed.deleteFiles = async (ids: string | string[]) => { await files.deleteFiles(Array.isArray(ids) ? ids : [ids]); };
    await assert.rejects(market.upload(id, a.owner, { ...validateDocument(document), bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }, observed));
    assert.ok(compensationKey); await assert.rejects(files.getAsBuffer(compensationKey));
    // A provider failure leaves a retryable tombstone and blocks submit/download.
    const broken = Object.create(files) as IFileModuleService; broken.deleteFiles = async () => { throw new Error("Fixture storage outage"); };
    await assert.rejects(market.removeDocument(id, documentId, a.owner, broken));
    assert.equal((await request(accessPath, a.cookie)).status, 404);
    assert.equal((await request(path + "/submit", a.cookie, "POST", {})).status, 400);
    assert.equal((await request(path + "/documents/" + documentId, a.cookie, "DELETE")).status, 200);
    assert.equal((await request(path + "/documents/" + documentId, a.cookie, "DELETE")).status, 200, "removal retry is safe");
    const replacement = await request(path + "/documents", a.cookie, "POST", document); assert.equal(replacement.status, 200);
    const replacementId = (await replacement.json()).documents[0].id as string;
    const [racingEdit, ...submitted] = await Promise.all([request(path, a.cookie, "PATCH", { notes: "concurrent draft edit" }), request(path + "/submit", a.cookie, "POST", {}), request(path + "/submit", a.cookie, "POST", {})]);
    assert.ok(racingEdit && [200, 400].includes(racingEdit.status));
    for (const response of submitted) assert.equal(response.status, 200);
    const first = await submitted[0]!.json(); const second = await submitted[1]!.json();
    assert.equal(first.application.notes, racingEdit.status === 200 ? "concurrent draft edit" : fields.notes, "submit serializes with draft edits");
    assert.equal(first.application.status, "SUBMITTED"); assert.equal(first.application.submitted_at, second.application.submitted_at);
    const replay = await request(path + "/submit", a.cookie, "POST", {}); assert.equal(replay.status, 200);
    assert.equal((await replay.json()).application.submitted_at, first.application.submitted_at);
    assert.equal((await request(path, a.cookie, "PATCH", { notes: "late" })).status, 400);
    assert.equal((await request(path + "/documents", a.cookie, "POST", document)).status, 400);
    assert.equal((await request(path + "/documents/" + replacementId, a.cookie, "DELETE")).status, 400);
    const adminPath = "/admin/gospaza/merchant-applications/" + id;
    assert.equal((await request(adminPath, admin.cookie)).status, 200);
    assert.equal((await request(adminPath + "/documents/" + replacementId + "/access", admin.cookie)).status, 200);
    assert.equal((await request(adminPath + "/documents/" + replacementId + "/access", a.cookie)).status, 401);
    const listing = await request("/admin/gospaza/merchant-applications?status=SUBMITTED&q=" + prefix + "&limit=1&offset=0", admin.cookie);
    assert.equal(listing.status, 200); assert.equal((await listing.json()).count, 1);
    for (const decision of ["approve", "reject"]) assert.equal((await request(adminPath + "/" + decision, admin.cookie, "POST", {})).status, 404);
  } catch (error) { failures.push(error); }
  finally {
    // Limit cleanup to this run's tracked identities and unique-prefix applications.
    const tasks: Array<{ label: string; run: () => Promise<unknown> }> = [
      ...cookies.map((cookie, i) => ({ label: "session " + i, run: async () => { const response = await request("/auth/session", cookie, "DELETE"); assert.ok([200,401].includes(response.status)); } })),
      ...appIds.map((id) => ({ label: "application " + id, run: async () => {
        const row = await db("merchant_application").where({ id }).whereIn("applicant_identity_id", identities).first();
        if (!row) return;
        const documents = await db("merchant_application_document").where({ application_id: id }).select("storage_key");
        for (const document of documents) await files.deleteFiles(document.storage_key);
        await db("merchant_application").where({ id }).whereIn("applicant_identity_id", identities).delete();
      } })),
    ];
    const results = await Promise.allSettled(tasks.map((task) => task.run()));
    results.forEach((result, i) => { if (result.status === "rejected") failures.push(new Error("M2 cleanup failed for " + tasks[i]!.label + "; prefix " + prefix)); });
    const nativeCleanup = await Promise.allSettled([users.deleteUsers(userIds), auth.deleteAuthIdentities(identities)]);
    if (nativeCleanup.some((r) => r.status === "rejected")) failures.push(new Error("M2 native fixture cleanup failed; prefix " + prefix));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "M2 verification or cleanup failed.");
  console.log("M2 application integration passed: lifecycle, actor/ownership isolation, private files, compensation, read-only admin and concurrent submission.");
}
