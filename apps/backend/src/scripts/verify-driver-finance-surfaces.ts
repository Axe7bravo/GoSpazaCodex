import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, IAuthModuleService } from "@medusajs/framework/types";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { DriverAccountDTO, DriverEarningsPage, DriverEarningSummary, DriverPaymentSummary, DriverPaymentsPage, DriverPaymentEvidence,
  DriverFinanceCapabilities, PlatformRecognitionReviews, PlatformEarningsPage, PlatformPaymentDetail, DriverCompensationHistory } from "@gospaza/contracts";
import { driverFinanceHandler } from "../lib/driver-finance-http";
import { driverPaymentHandler } from "../lib/driver-payment-http";
import { driverFinanceFixtureSchema, driverFinanceManifestPath, driverFinancePassword, type DriverFinanceManifest, type DriverFinanceActorName } from "./fixtures/driver-finance-acceptance";
const decision = () => ({ request_id: randomUUID(), confirmed: true, reason: "Private M21 API evidence review" });
const earningKeys = ["id", "delivery_reference", "order_reference", "economic_at", "amount_minor", "currency", "earning_type", "payment_state", "attention_required", "payment"];
const paymentKeys = ["id", "amount_minor", "currency", "earning_count", "payment_date", "reference", "state", "attention_required"];
const exact = (value: object, fields: string[]) => assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
function assertDriver(row: DriverEarningSummary) { exact(row, earningKeys); if (row.payment) exact(row.payment, paymentKeys); }
export default async function verifyDriverFinanceSurfaces({ container }: ExecArgs) {
  const file = driverFinanceManifestPath(), f = JSON.parse(await readFile(file, "utf8")) as DriverFinanceManifest;
  driverFinanceFixtureSchema(f.schema);
  if (f.api_verified) throw new Error("API fixture is consumed; generate a fresh manifest before rerunning.");
  const base = new URL(process.env.BACKEND_URL ?? "http://localhost:9000");
  assert.ok(["localhost", "127.0.0.1"].includes(base.hostname));
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [f.schema, "public"], pool: { min: 0, max: 4 } });
  const cookies = new Map<DriverFinanceActorName, string>();
  const finance = "/admin/gospaza/driver-finance", payments = "/admin/gospaza/driver-payments";
  async function request<T>(actor: DriverFinanceActorName, path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
    const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(30000), headers: { Cookie: cookies.get(actor) ?? "",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, `${actor}: ${method} ${path} returned ${response.status}; sensitive body omitted.`);
    if (status === 200) assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return response.json() as Promise<T>;
  }
  async function login(name: DriverFinanceActorName) {
    const actor = f.actors[name], role = ["operator", "viewer", "manager", "recorder", "reconciler"].includes(name) ? "user" : name === "merchant" ? "merchant" : name === "customer" ? "customer" : "driver";
    const response = await fetch(new URL(`/auth/${role}/emailpass`, base), { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: actor.email, password: driverFinancePassword(actor.email) }) });
    assert.equal(response.status, 200); const { token } = await response.json() as { token: string }; assert.ok(token);
    const session = await fetch(new URL("/auth/session", base), { method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000) });
    assert.equal(session.status, 200); const cookie = session.headers.getSetCookie().map(v => v.split(";")[0]).join("; "); assert.ok(cookie); cookies.set(name, cookie);
  }
  try {
    const apiDriverProfile = f.actors.apiDriver.profile; assert.ok(apiDriverProfile);
    assert.ok(await db("driver_profile").where({ id: apiDriverProfile, status: "ACTIVE" }).whereNull("deleted_at").first("id"),
      "API suspension fixture consumed; generate a fresh manifest and restart its isolated backend.");
    assert.equal(Number((await db("driver_compensation_terms").count("* as n").first())?.n), 0,
      "API publication fixture consumed; generate a fresh manifest and restart its isolated backend.");
    assert.equal((await db("driver_payment_item").whereIn("earning_id", [...f.earnings.api, ...f.earnings.apiBlocked])).length, 0,
      "Mutable API fixture consumed; generate a fresh manifest instead of replaying an interrupted acceptance run.");
    for (const actor of Object.keys(f.actors) as DriverFinanceActorName[]) await login(actor);
    const own = await request<DriverEarningsPage>("driver", "/driver/earnings");
    exact(own, ["items", "next_after", "unpaid_minor", "reserved_minor", "reviews"]); own.items.forEach(assertDriver);
    assert.equal(own.unpaid_minor, "5000"); assert.equal(own.reserved_minor, "5000");
    const paymentHistory = await request<DriverPaymentsPage>("driver", "/driver/earnings/payments"); exact(paymentHistory, ["items", "next_after"]);
    paymentHistory.items.forEach(row => exact(row, paymentKeys));
    await request("driver", "/driver/earnings/payments?driver=" + f.actors.foreign.profile, "GET", undefined, 400);
    assert.ok(own.reviews.length); own.reviews.forEach(row => exact(row, ["delivery_reference", "state"]));
    const profile = await request<DriverAccountDTO>("driver", "/driver/profile"); assert.equal(profile.profile.status, "SUSPENDED");
    const ownId = f.earnings.readonly[0], foreignId = f.earnings.foreign[0]; assert.ok(ownId && foreignId);
    assertDriver(await request("driver", "/driver/earnings/" + ownId));
    const foreign = await request("driver", "/driver/earnings/" + foreignId, "GET", undefined, 404);
    assert.deepEqual(foreign, await request("driver", "/driver/earnings/not_a_record", "GET", undefined, 404));
    await request("driver", "/driver/earnings?driver=" + f.actors.foreign.profile, "GET", undefined, 400);
    const apiProfile = await request<DriverAccountDTO>("apiDriver", "/driver/profile");
    await request("operator", "/admin/gospaza/drivers/" + apiProfile.profile.id + "/suspend", "POST", { expected_revision: apiProfile.profile.revision, confirmed: true, reason: "M21 same-session suspension proof" });
    assert.ok((await request<DriverEarningsPage>("apiDriver", "/driver/earnings")).items.length);
    const platform = await request<PlatformEarningsPage>("viewer", finance + "/earnings");
    for (const row of platform.items) { exact(row, [...earningKeys, "driver_profile_id", "payer", "payer_classification", "recorded_at", "snapshot", "recognition_exceptions"]); exact(row.snapshot, ["id", "amount_minor", "currency", "terms_revision"]);
      row.recognition_exceptions.forEach(ex => exact(ex, ["reason", "recorded_at"])); }
    assert.deepEqual(await request<DriverFinanceCapabilities>("viewer", finance + "/capabilities"), { view: true, manage: false, record: false, reconcile: false });
    assert.deepEqual(await request<DriverFinanceCapabilities>("manager", finance + "/capabilities"), { view: false, manage: true, record: false, reconcile: false });
    const reviews = await request<PlatformRecognitionReviews>("viewer", finance + "/reviews"); exact(reviews, ["items", "next_after"]);
    reviews.items.forEach(row => exact(row, ["id", "driver_profile_id", "delivery_reference", "reason", "recorded_at"]));
    await request("viewer", payments + "/unknown", "GET", undefined, 403);
    await request("manager", payments + "/record", "POST", {}, 403);
    await request("viewer", "/admin/gospaza/driver-compensation", "POST", {}, 403);
    const history = await request<DriverCompensationHistory>("viewer", "/admin/gospaza/driver-compensation");
    const publication = { ...decision(), expected_revision: history.revision, amount_minor: 5000, currency: "zar" };
    await request("manager", "/admin/gospaza/driver-compensation", "POST", publication);
    await request("manager", "/admin/gospaza/driver-compensation", "POST", { ...publication, reason: "Changed replay" }, 409);
    await request("manager", "/admin/gospaza/driver-compensation", "POST", { ...decision(), expected_revision: history.revision + 1, amount_minor: 0, currency: "zar" }, 400);
    const future = { ...decision(), expected_revision: history.revision + 1, amount_minor: 6000, currency: "zar", effective_at: new Date(Date.now() + 3600000).toISOString() };
    await request("manager", "/admin/gospaza/driver-compensation", "POST", future);
    const futureHistory = await request<DriverCompensationHistory>("viewer", "/admin/gospaza/driver-compensation");
    assert.ok(futureHistory.items.some(row => row.effective_at === future.effective_at && row.amount_minor === "6000"));
    await request("manager", finance + "/earnings", "GET", undefined, 403);
    const { rows: [clock] } = await db.raw("select clock_timestamp() as instant");
    const e = { ...decision(), earning_ids: f.earnings.api, amount_minor: 10000, currency: "zar", channel: "BANK_TRANSFER", beneficiary_reference: "m21_api_private_beneficiary",
      origin_reference: "m21_api_private_origin", external_transfer_id: "m21_api_bank_" + randomUUID(), transferred_at: new Date(clock.instant).toISOString(), evidence_reference: "m21_api_private_proof" };
    for (const extra of [{ driver_profile_id: "forged" }, { payer: "MERCHANT" }, { status: "PAID" }]) await request("recorder", payments + "/record", "POST", { ...e, ...extra }, 400);
    await request("recorder", payments + "/record", "POST", { ...e, amount_minor: 7500 }, 409);
    await request("viewer", payments + "/record", "POST", e, 403);
    const paid = await request<{ payment_id: string }>("recorder", payments + "/record", "POST", e);
    assert.deepEqual(await request("recorder", payments + "/record", "POST", e), await request("recorder", payments + "/record", "POST", e));
    await request("recorder", payments + "/record", "POST", { ...e, external_transfer_id: "changed" }, 409);
    await request("recorder", payments + "/record", "POST", { ...e, ...decision(), earning_ids: f.earnings.foreign }, 409);
    const detail = await request<PlatformPaymentDetail>("viewer", finance + "/payments/" + paid.payment_id);
    exact(detail, ["payment", "earnings"]); exact(detail.payment, [...paymentKeys, "driver_profile_id", "discrepancies"]);
    const serialized = JSON.stringify(detail); for (const value of [e.beneficiary_reference, e.origin_reference, e.external_transfer_id, e.evidence_reference, e.reason]) assert.ok(!serialized.includes(value));
    await request("viewer", payments + "/" + paid.payment_id, "GET", undefined, 403);
    const { evidence_reference: removed, ...facts } = e; assert.ok(removed);
    const reconcile = { ...facts, ...decision(), driver_profile_id: f.actors.apiDriver.profile, review_reference: "m21_api_private_review" };
    await request("recorder", payments + "/" + paid.payment_id + "/reconcile", "POST", reconcile, 403);
    await request("reconciler", payments + "/" + paid.payment_id + "/reconcile", "POST", reconcile);
    const self = await request<DriverEarningSummary>("apiDriver", "/driver/earnings/" + f.earnings.api[0]); assertDriver(self); assert.equal(self.payment_state, "RECONCILED"); assert.equal(self.amount_minor, "5000");
    assert.ok(self.payment); exact(await request<DriverPaymentSummary>("apiDriver", "/driver/earnings/payments/" + self.payment.id), paymentKeys);
    const hiddenPayment = await request("driver", "/driver/earnings/payments/" + paid.payment_id, "GET", undefined, 404);
    assert.deepEqual(hiddenPayment, await request("driver", "/driver/earnings/payments/not_a_payment", "GET", undefined, 404));
    const uncertain = own.items.find(row => row.payment_state === "RESERVED")?.payment; assert.ok(uncertain);
    const unknownEvidence = await request<DriverPaymentEvidence>("reconciler", payments + "/" + uncertain.id);
    await request("reconciler", payments + "/" + uncertain.id + "/reconcile", "POST", { ...decision(), driver_profile_id: unknownEvidence.driver_profile_id,
      earning_ids: unknownEvidence.items.map(row => row.earning_id), amount_minor: Number(unknownEvidence.amount_minor), currency: "zar",
      beneficiary_reference: unknownEvidence.beneficiary_reference, channel: unknownEvidence.channel, origin_reference: unknownEvidence.origin_reference,
      external_transfer_id: unknownEvidence.external_transfer_id, transferred_at: unknownEvidence.transferred_at, review_reference: "m21_unknown_review" }, 409);
    await request("recorder", payments + "/" + paid.payment_id + "/discrepancies", "POST", { ...decision(), category: "RETURNED_TRANSFER", evidence_reference: "m21_private_dispute" });
    const preserved = await request<PlatformPaymentDetail>("viewer", finance + "/payments/" + paid.payment_id); assert.equal(preserved.payment.state, "RECONCILED"); assert.equal(preserved.payment.attention_required, true);
    const blockedEvidence = { ...e, ...decision(), earning_ids: f.earnings.apiBlocked, external_transfer_id: "m21_blocked_" + randomUUID() };
    const blocked = await request<{ payment_id: string }>("recorder", payments + "/record", "POST", blockedEvidence);
    await request("recorder", payments + "/" + blocked.payment_id + "/discrepancies", "POST", { ...decision(), category: "AMOUNT_MISMATCH", evidence_reference: "m21_private_discrepancy" });
    await request("reconciler", payments + "/" + blocked.payment_id + "/reconcile", "POST", { ...reconcile, ...decision(), earning_ids: f.earnings.apiBlocked,
      external_transfer_id: blockedEvidence.external_transfer_id }, 409);
    for (const actor of ["merchant", "customer", "driver"] as const) {
      await request(actor, finance + "/earnings", "GET", undefined, 401); await request(actor, payments + "/record", "POST", e, 401);
      await request(actor, finance + "/payments/" + paid.payment_id, "GET", undefined, 401);
    }
    for (const actor of ["merchant", "customer"] as const) await request(actor, "/driver/earnings", "GET", undefined, 401);
    // Same native session, actual authoritative identity removal (separate single-use actor).
    await request("revoked", "/driver/earnings");
    await container.resolve<IAuthModuleService>(Modules.AUTH).deleteAuthIdentities([f.actors.revoked.identity]);
    await request("revoked", "/driver/earnings", "GET", undefined, 401);
    await fetch(new URL("/auth/session", base), { method: "DELETE", headers: { Cookie: cookies.get("apiDriver") ?? "" }, signal: AbortSignal.timeout(30000) });
    await request("apiDriver", "/driver/earnings", "GET", undefined, 401);
    // Environment grants live in the server process. Exercise the actual route
    // handlers with the unchanged HTTP-authenticated actor/session, as M19/M20.
    const viewerIdentity = await request<{ actor: { id: string } }>("viewer", "/admin/gospaza/me");
    for (const name of ["recorder", "reconciler"] as const)
      assert.equal((await request<{ actor: { id: string } }>(name, "/admin/gospaza/me")).actor.id, f.actors[name].id);
    const scope = container.createScope(); scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    const invoke = async (kind: "read" | "record" | "reconcile") => {
      let status = 200; const res = { setHeader: () => undefined, status: (value: number) => { status = value; return res; }, json: () => undefined };
      const name = kind === "read" ? "viewer" : kind === "record" ? "recorder" : "reconciler";
      const req = { scope, query: {}, params: { id: paid.payment_id }, auth_context: { actor_type: "user", actor_id: f.actors[name].id },
        headers: { cookie: cookies.get(name) }, body: {} };
      await (kind === "read" ? driverFinanceHandler("earnings") : driverPaymentHandler(kind === "record" ? "RECORD" : "RECONCILE"))(req as unknown as MedusaRequest, res as unknown as MedusaResponse); return status;
    };
    for (const [kind, grant, actor, admitted] of [["read", "DRIVER_EARNINGS_VIEW_USER_IDS", viewerIdentity.actor.id, 200], ["record", "DRIVER_PAYMENT_RECORD_USER_IDS", f.actors.recorder.id, 400],
      ["reconcile", "DRIVER_PAYMENT_RECONCILE_USER_IDS", f.actors.reconciler.id, 400]] as const) {
      const previous = process.env[grant];
      try { process.env[grant] = actor; assert.equal(await invoke(kind), admitted); delete process.env[grant]; assert.equal(await invoke(kind), 403); }
      finally { if (previous === undefined) delete process.env[grant]; else process.env[grant] = previous; }
    }
    assert.equal((await request<{ actor: { id: string } }>("viewer", "/admin/gospaza/me")).actor.id, viewerIdentity.actor.id);
    const untouched = await db("driver_payment_item").whereIn("earning_id", f.earnings.browser); assert.equal(untouched.length, 0, "Browser lifecycle must remain unconsumed by API acceptance.");
    await writeFile(file, JSON.stringify({ ...f, api_verified: true }));
    console.log("M21-E direct API, suspension, native identity revocation, grant-handler and privacy acceptance passed.");
  } finally {
    for (const cookie of cookies.values()) await fetch(new URL("/auth/session", base), { method: "DELETE", headers: { Cookie: cookie }, signal: AbortSignal.timeout(30000) });
    await db.destroy();
  }
}
