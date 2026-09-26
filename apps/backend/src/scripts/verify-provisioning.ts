import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IAuthModuleService, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type MarketplaceService from "../modules/marketplace/service";

// Real HTTP and real PostgreSQL constraints. Run against a local, migrated backend.
export default async function verifyProvisioning({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M3 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const market = container.resolve<MarketplaceService>("marketplace");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const prefix = "m3-" + randomUUID(), password = randomBytes(24).toString("hex");
  const identities: string[] = [], userIds: string[] = [], cookies: string[] = [], appIds: string[] = [];
  const failures: unknown[] = [];
  async function request(path: string, cookie?: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    return fetch(new URL(path, base), { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  }
  async function session(actor: string, suffix: string) {
    const email = prefix + suffix + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password } });
    assert.ok(registered.success && registered.authIdentity); const owner = registered.authIdentity.id; identities.push(owner);
    if (actor === "user") { const user = await users.createUsers({ email }); userIds.push(user.id); await auth.updateAuthIdentities({ id: owner, app_metadata: { user_id: user.id } }); }
    const login = await request("/auth/" + actor + "/emailpass", undefined, "POST", { email, password }); assert.equal(login.status, 200);
    const { token } = await login.json();
    const exchange = await request("/auth/session", undefined, "POST", undefined, { Authorization: "Bearer " + token }); assert.equal(exchange.status, 200);
    const cookie = exchange.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie); cookies.push(cookie);
    return { cookie, owner };
  }
  const fields = { legal_name: prefix, trading_name: prefix + " shop", contact_name: "Fixture", contact_email: prefix + "@example.test", contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Test city", province: "Test province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "Synthetic verification" };
  const adminPath = (id: string) => "/admin/gospaza/merchant-applications/" + id;
  const ownPath = (id: string) => "/merchant/applications/" + id;
  const approval = { confirmed: true, reason: "Reviewed synthetic fixture" };
  async function application(owner: { cookie: string; owner: string }) {
    const row = await market.createDraft(owner.owner); assert.ok(row); appIds.push(row.id);
    await market.edit(row.id, owner.owner, fields); await market.submit(row.id, owner.owner); return row.id;
  }
  async function post(id: string, action: string, cookie: string, body: unknown = {}) {
    return request(adminPath(id) + "/" + action, cookie, "POST", body);
  }
  try {
    const admin = await session("user", "admin"), secondAdmin = await session("user", "second-admin"), a = await session("merchant", "a"), b = await session("merchant", "b"), c = await session("merchant", "c");
    const aid = await application(a), bid = await application(b), cid = await application(c);
    const d = await session("merchant", "partial"), did = await application(d);
    for (const wrong of [a, b, await session("customer", "customer"), await session("driver", "driver")]) {
      for (const action of ["start-review", "request-information", "reject", "approve"]) assert.equal((await post(aid, action, wrong.cookie, approval)).status, 401);
      assert.equal((await request(adminPath(aid) + "/review-history", wrong.cookie)).status, 401);
      if (wrong !== a && wrong !== b) assert.equal((await request("/merchant/me", wrong.cookie)).status, 401);
    }
    assert.equal((await request("/merchant/me", a.cookie)).status, 401);
    assert.equal((await request(ownPath(aid) + "/review-history", b.cookie)).status, 404);
    assert.equal((await post(aid, "approve", admin.cookie, approval)).status, 400);
    assert.equal((await post(aid, "start-review", admin.cookie)).status, 200);
    assert.equal((await post(aid, "start-review", admin.cookie)).status, 400);
    assert.equal((await post(aid, "request-information", admin.cookie, { reason: " " })).status, 400);
    const initial = (await market.detail(aid)).application.submitted_at!.toISOString();
    assert.equal((await post(aid, "request-information", admin.cookie, { reason: "Please clarify the address" })).status, 200);
    assert.equal((await request(ownPath(aid), a.cookie, "PATCH", { address_line_1: "2 Test Street" })).status, 200);
    const file = { document_type: "OTHER", display_name: "fixture.pdf", mime_type: "application/pdf", content: Buffer.from("%PDF-1.4\nfixture\n%%EOF").toString("base64") };
    const uploaded = await request(ownPath(aid) + "/documents", a.cookie, "POST", file); assert.equal(uploaded.status, 200);
    const docId = (await uploaded.json()).documents[0].id;
    assert.equal((await request(ownPath(aid) + "/documents/" + docId, a.cookie, "DELETE")).status, 200);
    assert.equal((await request(ownPath(aid) + "/submit", a.cookie, "POST", {})).status, 200);
    assert.equal((await market.detail(aid)).application.submitted_at!.toISOString(), initial);
    assert.ok((await market.detail(aid)).application.last_submitted_at);
    const visibleHistory = await (await request(ownPath(aid) + "/review-history", a.cookie)).json();
    assert.deepEqual(visibleHistory.review_history.map((e: { action: string }) => e.action), ["REVIEW_STARTED", "INFORMATION_REQUESTED", "RESUBMITTED"]);
    assert.ok(visibleHistory.review_history.every((e: object) => !("platform_user_id" in e)));
    assert.equal((await post(aid, "start-review", admin.cookie)).status, 200);
    // Provision another fixture first, then temporarily occupy A's identity with
    // B's membership. A fails on the real unique constraint after merchant/store inserts.
    assert.equal((await post(bid, "start-review", admin.cookie)).status, 200);
    assert.equal((await post(bid, "approve", admin.cookie, approval)).status, 200);
    const bTenant = await market.resolveTenant(b.owner);
    await db("merchant_member").where({ merchant_id: bTenant.merchant.id, auth_identity_id: b.owner }).update({ auth_identity_id: a.owner });
    await assert.rejects(market.resolveTenant(a.owner), "ownership mismatch must fail closed");
    await assert.rejects(market.provision(aid, userIds[0]!, approval.reason));
    assert.equal((await market.detail(aid)).application.status, "UNDER_REVIEW");
    assert.equal((await db("merchant").where({ source_application_id: aid })).length, 0, "merchant/store transaction rolled back");
    assert.equal((await market.reviewHistory(aid)).filter((e) => e.action === "APPROVED").length, 0);
    await db("merchant_member").where({ merchant_id: bTenant.merchant.id, auth_identity_id: a.owner }).update({ auth_identity_id: b.owner });
    for (const injected of [{ owner_id: b.owner }, { merchant_id: bTenant.merchant.id }, { medusa_stock_location_id: "sloc_injected" }, { status: "APPROVED" }]) assert.equal((await post(aid, "approve", admin.cookie, { ...approval, ...injected })).status, 400);
    assert.equal((await post(aid, "approve", admin.cookie, { reason: "reviewed", confirmed: false })).status, 400);
    // A consistent pre-existing partial snapshot is reconciled, never duplicated.
    assert.equal((await post(did, "start-review", admin.cookie)).status, 200);
    const partialId = "mer_" + randomUUID();
    await db("merchant").insert({ id: partialId, source_application_id: did, legal_name: fields.legal_name, trading_name: fields.trading_name });
    assert.equal((await post(did, "approve", admin.cookie, approval)).status, 200);
    assert.equal((await market.resolveTenant(d.owner)).merchant.id, partialId);
    const concurrent = await Promise.all([post(aid, "approve", admin.cookie, approval), post(aid, "approve", secondAdmin.cookie, approval)]);
    for (const response of concurrent) assert.equal(response.status, 200, await response.text());
    assert.equal((await post(aid, "approve", admin.cookie, approval)).status, 200);
    const tenant = await market.resolveTenant(a.owner);
    assert.equal((await db("merchant").where({ source_application_id: aid })).length, 1);
    assert.equal((await db("merchant_store").where({ merchant_id: tenant.merchant.id })).length, 1);
    assert.equal((await db("merchant_member").where({ merchant_id: tenant.merchant.id, auth_identity_id: a.owner })).length, 1);
    const store = await db("merchant_store").where({ merchant_id: tenant.merchant.id }).first();
    assert.equal(store.medusa_stock_location_id, null, "M3 defers inventory resources");
    assert.equal(store.address_line_1, "2 Test Street");
    const approvals = (await market.reviewHistory(aid)).filter((e) => e.action === "APPROVED"); assert.equal(approvals.length, 1); assert.ok(userIds.includes(approvals[0]!.platform_user_id!));
    // Database uniqueness remains effective independently of service checks.
    await assert.rejects(async () => await db("merchant").insert({ id: "mer_" + randomUUID(), source_application_id: aid, legal_name: prefix, trading_name: prefix }));
    await assert.rejects(async () => await db("merchant_store").insert({ ...store, id: "mstore_" + randomUUID() }));
    const member = await db("merchant_member").where({ auth_identity_id: a.owner }).first();
    await assert.rejects(async () => await db("merchant_member").insert({ ...member, id: "mmem_" + randomUUID() }));
    const resolved = await request("/merchant/me?merchant_id=" + bTenant.merchant.id, a.cookie, "GET", undefined, { "x-merchant-id": bTenant.merchant.id });
    assert.equal(resolved.status, 200); assert.deepEqual(await resolved.json(), tenant);
    assert.equal((await request("/merchant/me", c.cookie)).status, 401);
    await db("merchant_member").where({ id: member.id }).update({ status: "INACTIVE" });
    assert.equal((await request("/merchant/me", a.cookie)).status, 401);
    await db("merchant_member").where({ id: member.id }).update({ status: "ACTIVE" });
    await db("merchant").where({ id: tenant.merchant.id }).update({ status: "SUSPENDED" });
    assert.equal((await request("/merchant/me", a.cookie)).status, 401);
    await db("merchant").where({ id: tenant.merchant.id }).update({ status: "ACTIVE" });
    await db("merchant").where({ id: tenant.merchant.id }).update({ deleted_at: new Date() });
    assert.equal((await request("/merchant/me", a.cookie)).status, 401);
    await db("merchant").where({ id: tenant.merchant.id }).update({ deleted_at: null });
    await db("merchant_member").where({ id: member.id }).delete();
    assert.equal((await request("/merchant/me", a.cookie)).status, 401);
    await db("merchant_member").insert(member);
    const ownSummary = await (await request("/merchant/applications/me", a.cookie)).json();
    assert.deepEqual(ownSummary.tenant, tenant);
    assert.equal("auth_identity_id" in ownSummary.tenant.membership, false);
    assert.equal("medusa_stock_location_id" in ownSummary.tenant.store, false);
    const adminHistory = await (await request(adminPath(aid) + "/review-history", admin.cookie)).json();
    assert.equal(adminHistory.review_history.at(-1).platform_user_id, approvals[0]!.platform_user_id);
    await assert.rejects(async () => await db("merchant_application_review").where({ id: approvals[0]!.id }).update({ reason: "rewrite" }));
    assert.equal((await request(adminPath(aid), admin.cookie, "PATCH", { status: "REJECTED" })).status, 404);
    assert.equal((await request(ownPath(aid), a.cookie, "PATCH", { notes: "late" })).status, 400);
    assert.equal((await post(cid, "start-review", admin.cookie)).status, 200);
    assert.equal((await post(cid, "reject", admin.cookie, {})).status, 400);
    assert.equal((await post(cid, "reject", admin.cookie, { reason: "Application is not eligible" })).status, 200);
    assert.equal((await request(ownPath(cid), c.cookie, "PATCH", { notes: "late" })).status, 400);
    assert.equal((await request(ownPath(cid) + "/submit", c.cookie, "POST", {})).status, 400);
    const repeatedDraft = await market.createDraft(c.owner); assert.equal(repeatedDraft!.status, "REJECTED");
    assert.equal((await post(cid, "approve", admin.cookie, approval)).status, 400);
    assert.equal((await request("/merchant/me", c.cookie)).status, 401);
  } catch (error) { failures.push(error); }
  finally {
    // Cleanup is scoped to this run's tracked identities; all failures are reported.
    for (const cookie of cookies) { try { assert.ok([200, 401].includes((await request("/auth/session", cookie, "DELETE")).status)); } catch (error) { failures.push(error); } }
    try {
      const owned = await db("merchant_application").whereIn("id", appIds).whereIn("applicant_identity_id", identities).select("id");
      const ids = owned.map((row) => row.id);
      const docs = await db("merchant_application_document").whereIn("application_id", ids).select("storage_key");
      const files = container.resolve<import("@medusajs/framework/types").IFileModuleService>(Modules.FILE);
      for (const doc of docs) await files.deleteFiles(doc.storage_key);
      await db.transaction(async (trx) => {
        const merchants = await trx("merchant").whereIn("source_application_id", ids).select("id"); const mids = merchants.map((row) => row.id);
        await trx("merchant_member").whereIn("merchant_id", mids).delete(); await trx("merchant_store").whereIn("merchant_id", mids).delete();
        await trx("merchant").whereIn("id", mids).delete(); await trx("merchant_application").whereIn("id", ids).delete();
      });
    } catch (error) { failures.push(new Error("M3 fixture cleanup failed; prefix " + prefix, { cause: error })); }
    for (const cleanup of [() => users.deleteUsers(userIds), () => auth.deleteAuthIdentities(identities)]) { try { await cleanup(); } catch (error) { failures.push(error); } }
  }
  if (failures.length) throw new AggregateError(failures, "M3 verification or cleanup failed; prefix " + prefix);
  console.log("M3 integration passed: review lifecycle, atomic rollback, concurrent/repeated approval, uniqueness and tenant isolation.");
}
