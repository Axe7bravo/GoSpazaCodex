import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICustomerModuleService, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { DriverAccountDTO, DriverMutationDTO, MerchantDriverDTO } from "@gospaza/contracts";
import type MarketplaceService from "../modules/marketplace/service";
import { DriverService } from "../modules/marketplace/driver-service";

type Session = { identity: string; email: string; cookie: string; token: string };
// Real native sessions + HTTP authorization + concurrent PostgreSQL transactions.
// No enclosing shared transaction/client, no prerequisite verifier recursion.
export default async function verifyDrivers({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M14 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL ?? "http://localhost:9000");
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const market = container.resolve<MarketplaceService>("marketplace");
  const drivers = new DriverService(container);
  const prefix = "m14-" + randomUUID(), password = randomBytes(24).toString("hex");
  const identities: string[] = [], cookies: string[] = [], userIds: string[] = [], appIds: string[] = [], customerIds: string[] = [];
  const publicEmails: string[] = [];
  const failures: unknown[] = [];
  const key = await keys.createApiKeys({ title: prefix, type: "publishable", created_by: prefix });
  async function call(path: string, who?: Session, method = "GET", body?: unknown, token?: string) {
    return fetch(new URL(path, base), { method, signal: AbortSignal.timeout(60000),
      headers: { "x-publishable-api-key": key.token, ...(who ? { Cookie: who.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function http(path: string, who?: Session, method = "GET", body?: unknown, expected = 200, token?: string): Promise<unknown> {
    const r = await call(path, who, method, body, token), text = await r.text();
    assert.equal(r.status, expected, method + " " + path + " HTTP " + r.status + " " + (path.startsWith("/auth") ? "[auth body omitted]" : text.slice(0,1000)));
    try { return JSON.parse(text); } catch { throw new Error(method + " " + path + " returned non-JSON " + r.headers.get("content-type")); }
  }
  async function login(email: string, identity: string, actor: string): Promise<Session> {
    const result = await http("/auth/" + actor + "/emailpass", undefined, "POST", { email, password }) as { token: string };
    assert.ok(result.token);
    const response = await call("/auth/session", undefined, "POST", undefined, result.token);
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
    assert.ok(cookie); cookies.push(cookie);
    return { identity, email, cookie, token: result.token };
  }
  async function account(label: string, actor = "driver"): Promise<Session> {
    const email = prefix + "-" + label + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password } });
    assert.ok(registered.success && registered.authIdentity);
    identities.push(registered.authIdentity.id);
    if (actor === "user") {
      const user = await users.createUsers({ email }); userIds.push(user.id);
      await auth.updateAuthIdentities({ id: registered.authIdentity.id, app_metadata: { user_id: user.id } });
    }
    return login(email, registered.authIdentity.id, actor);
  }
  const own = async (s: Session) => await http("/driver/profile", s) as DriverAccountDTO;
  const bootstrap = async (s: Session) => await http("/driver/profile/bootstrap", s, "POST", {}) as DriverAccountDTO;
  const change = async (s: Session, path: string, body: unknown, expected = 200, method = "POST") => await http(path, s, method, body, expected) as DriverMutationDTO;
  const decision = (revision: number) => ({ expected_revision: revision, confirmed: true, reason: "Synthetic M14 verification" });
  async function provision(owner: Session, reviewer: string) {
    const app = await market.createDraft(owner.identity); assert.ok(app); appIds.push(app.id);
    await market.edit(app.id, owner.identity, { legal_name: prefix, trading_name: prefix + " shop", contact_name: "Fixture", contact_email: owner.email,
      contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Fixture", province: "Free State", postal_code: "9300", country_code: "ZA", intends_to_sell_alcohol: false, notes: "Synthetic M14" });
    await market.submit(app.id, owner.identity); await market.review(app.id, reviewer, "start-review");
    return market.provision(app.id, reviewer, "Synthetic M14 fixture");
  }
  async function complete(s: Session) {
    const p = await own(s);
    return change(s, "/driver/profile", { expected_revision: p.profile.revision, display_name: "Fixture Driver", contact_phone: "+27 82 123 4567" }, 200, "PATCH");
  }
  async function request(s: Session, store?: string) {
    const p = await own(s);
    return change(s, "/driver/affiliations", { expected_revision: p.profile.revision, kind: store ? "MERCHANT" : "PLATFORM", ...(store ? { merchant_store_id: store } : {}) });
  }
  async function submit(s: Session) {
    const p = await own(s); return change(s, "/driver/profile/submit", { expected_revision: p.profile.revision });
  }
  const adminPath = (id: string, action: string) => "/admin/gospaza/drivers/" + id + "/" + action;
  try {
    const admin = await account("admin", "user"), owner = await account("owner", "merchant"), foreign = await account("foreign", "merchant");
    const reviewer = userIds[0]; assert.ok(reviewer);
    const tenant = await provision(owner, reviewer), otherTenant = await provision(foreign, reviewer);
    const manager = await account("manager", "merchant"), picker = await account("picker", "merchant");
    for (const [s, role] of [[manager, "MANAGER"], [picker, "PICKER"]] as const) {
      const invitation = await market.teamService.invite(owner.identity, { email: s.email, role }, async identity => { const native = await auth.retrieveAuthIdentity(identity, { relations: ["provider_identities"] }); const email = native.provider_identities?.find(p => p.provider === "emailpass")?.entity_id; assert.ok(email); return email; });
      await market.teamService.accept(s.identity, s.email, { token: invitation.token });
    }
    const email = prefix + "-public@example.test"; publicEmails.push(email);
    await http("/auth/driver/emailpass/register", undefined, "POST", { email, password, status: "ACTIVE" }, 400);
    await http("/auth/driver/emailpass/register", undefined, "POST", { email, password });
    const native = await auth.authenticate("emailpass", { body: { email, password } }); assert.ok(native.authIdentity);
    identities.push(native.authIdentity.id);
    const driver = await login(email, native.authIdentity.id, "driver");
    await http("/driver/profile", driver, "GET", undefined, 401);
    await http("/driver/profile/bootstrap", undefined, "POST", {}, 401);
    for (const who of [owner, admin]) await http("/driver/profile/bootstrap", who, "POST", {}, 401);
    const customerScope = await login(email, driver.identity, "customer");
    await http("/driver/profile/bootstrap", customerScope, "POST", {}, 401);
    await http("/auth/driver/emailpass/register", undefined, "POST", { email, password: "hostile-replacement-password" }, 401);
    assert.equal((await auth.authenticate("emailpass", { body: { email, password: "hostile-replacement-password" } })).success, false);
    assert.equal((await auth.authenticate("emailpass", { body: { email, password } })).success, true);
    await auth.updateAuthIdentities({ id: driver.identity, app_metadata: { unrelated_fixture: prefix } });
    // Native customer association races profile bootstrap on the SAME identity.
    const [createdCustomer, init1, init2] = await Promise.all([
      http("/store/customers", undefined, "POST", { email }, 200, customerScope.token), bootstrap(driver), bootstrap(driver),
    ]);
    const customer = createdCustomer as { customer: { id: string } }; assert.ok(customer.customer.id); customerIds.push(customer.customer.id);
    assert.equal(init1.profile.id, init2.profile.id); assert.equal(init1.profile.status, "INCOMPLETE");
    assert.deepEqual(init1.eligibility, { eligible: false, reason: "PROFILE_INACTIVE" });
    assert.equal((await bootstrap(driver)).profile.id, init1.profile.id);
    assert.equal((await db("driver_profile").where({ auth_identity_id: driver.identity })).length, 1);
    const metadata = (await auth.retrieveAuthIdentity(driver.identity)).app_metadata;
    assert.equal(metadata?.customer_id, customer.customer.id); assert.equal(metadata?.unrelated_fixture, prefix); assert.ok(!metadata?.driver_id);
    await bootstrap(driver); assert.deepEqual((await auth.retrieveAuthIdentity(driver.identity)).app_metadata, metadata);
    const restoredCustomer = await login(email, driver.identity, "customer");
    await http("/store/customers/me?fields=id,email", restoredCustomer);
    await http("/driver/profile/bootstrap", restoredCustomer, "POST", {}, 401);
    await http("/store/customers/me", driver, "GET", undefined, 401);
    await http("/store/gospaza/me", driver, "GET", undefined, 401);
    const pId = init1.profile.id;
    // M14-D: actor scope protects reads as well as bootstrap/mutations.
    for (const who of [undefined, restoredCustomer, owner, driver]) {
      await http("/admin/gospaza/drivers", who, "GET", undefined, 401);
      await http("/admin/gospaza/drivers/" + pId, who, "GET", undefined, 401);
    }
    for (const who of [restoredCustomer, owner, admin]) await http("/driver/profile", who, "GET", undefined, 401);
    const profileKeys = ["id", "display_name", "contact_phone", "status", "revision", "submitted_at", "reviewed_at"].sort();
    assert.deepEqual(Object.keys(init1).sort(), ["affiliation", "eligibility", "profile"]);
    assert.deepEqual(Object.keys(init1.profile).sort(), profileKeys);
    const reviewedProjection = await http("/admin/gospaza/drivers/" + pId, admin) as DriverAccountDTO;
    assert.deepEqual(Object.keys(reviewedProjection.profile).sort(), profileKeys);
    await http("/admin/gospaza/drivers?auth_identity_id=" + driver.identity, admin, "GET", undefined, 400);

    for (const field of ["auth_identity_id", "driver_profile_id", "actor_id", "actor_type", "status", "merchant_id", "revision"]) {
      await http("/driver/profile", driver, "PATCH", { expected_revision: 1, display_name: "Fixture", [field]: "forged" }, 400);
      await http("/driver/profile/bootstrap", driver, "POST", { [field]: "forged" }, 400);
    }
    await assert.rejects(db("driver_profile").where({ id: pId }).update({ auth_identity_id: owner.identity, revision: 2 }));
    await assert.rejects(db("driver_profile").insert({ id: "drv_" + randomUUID(), auth_identity_id: driver.identity }), { code: "23505" });
    await http("/driver/profile/submit", driver, "POST", { expected_revision: 1 }, 400);
    await complete(driver);
    const requested = await request(driver); assert.ok(requested.affiliation);
    await assert.rejects(db("driver_affiliation").insert({ id: "daff_" + randomUUID(), driver_profile_id: pId, kind: "PLATFORM", status: "REQUESTED" }), { code: "23505" });
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    const pending = await submit(driver);
    await http("/driver/profile", driver, "PATCH", { expected_revision: pending.profile.revision, display_name: "Changed while pending" }, 409);
    const changes = await change(admin, adminPath(pId, "require-changes"), decision(pending.profile.revision));
    assert.equal(changes.profile.status, "CHANGES_REQUIRED");
    await complete(driver); const resubmitted = await submit(driver);
    await http(adminPath(pId, "approve"), admin, "POST", decision(pending.profile.revision), 409);
    const approvalBody = decision(resubmitted.profile.revision);
    const approvals = await Promise.all([call(adminPath(pId, "approve"), admin, "POST", approvalBody), call(adminPath(pId, "approve"), admin, "POST", approvalBody)]);
    assert.deepEqual(approvals.map(r => r.status), [200, 200]);
    for (const response of approvals) await response.text();
    assert.equal((await own(driver)).profile.status, "ACTIVE");
    assert.equal((await own(driver)).affiliation?.status, "ACTIVE");
    assert.deepEqual((await own(driver)).eligibility, { eligible: true, reason: "ELIGIBLE" });
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, true);
    const approvalEvents = await db("driver_event").where({ driver_profile_id: pId, action: "APPROVE" }); assert.equal(approvalEvents.length, 1);
    assert.equal(approvalEvents[0].actor_id, reviewer);
    let current = await own(driver);
    await change(admin, adminPath(pId, "suspend"), decision(current.profile.revision));
    assert.deepEqual((await own(driver)).eligibility, { eligible: false, reason: "PROFILE_INACTIVE" });
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    current = await own(driver); await change(admin, adminPath(pId, "reactivate"), decision(current.profile.revision));
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, true);
    current = await own(driver); assert.ok(current.affiliation);
    await change(driver, "/driver/affiliations/" + current.affiliation.id + "/withdraw", { expected_revision: current.profile.revision });
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    assert.equal((await own(driver)).affiliation, null);
    const merchantRequest = await request(driver, tenant.store.id); assert.ok(merchantRequest.affiliation);
    const affId = merchantRequest.affiliation.id, merchantPath = "/merchant/drivers/" + affId;
    await http("/merchant/drivers", picker, "GET", undefined, 403);
    await http(merchantPath + "/endorse", picker, "POST", decision(merchantRequest.profile.revision), 403);
    const foreignResult = await http(merchantPath, foreign, "GET", undefined, 404);
    assert.deepEqual(await http("/merchant/drivers/unknown", foreign, "GET", undefined, 404), foreignResult);
    await http(merchantPath + "/endorse", foreign, "POST", decision(merchantRequest.profile.revision), 404);
    await http(merchantPath + "/endorse", owner, "POST", { ...decision(merchantRequest.profile.revision), merchant_id: otherTenant.merchant.id }, 400);
    assert.equal((await call(merchantPath + "/activate", owner, "POST", decision(merchantRequest.profile.revision))).status, 404);
    const list = await http("/merchant/drivers?limit=1&offset=0", owner) as { items: MerchantDriverDTO[] };
    assert.equal(list.items.length, 1); assert.equal(list.items[0]?.contact_phone, null);
    assert.ok(list.items[0]);
    assert.deepEqual(Object.keys(list.items[0]).sort(), ["affiliation", "profile_revision", "display_name", "contact_phone", "persistently_eligible", "available_actions"].sort());
    assert.deepEqual(Object.keys(list.items[0].affiliation).sort(), ["id", "kind", "status", "revision", "merchant_store_id", "created_at"].sort());
    for (const field of ["status", "auth_identity_id", "actor_id", "merchant_store_id", "eligibility", "revision", "reviewed_by"]) {
      await http(merchantPath + "/endorse", owner, "POST", { ...decision(merchantRequest.profile.revision), [field]: "forged" }, 400);
      await http(adminPath(pId, "suspend"), admin, "POST", { ...decision(merchantRequest.profile.revision), [field]: "forged" }, 400);
    }

    assert.deepEqual(list.items[0]?.available_actions, ["endorse", "decline"]);
    assert.ok(!JSON.stringify(list).includes(driver.identity));
    await http("/merchant/drivers?merchant_id=" + otherTenant.merchant.id, owner, "GET", undefined, 400);
    const otherList = await http("/merchant/drivers", foreign) as { items: MerchantDriverDTO[] }; assert.equal(otherList.items.length, 0);
    await http(merchantPath + "/endorse", manager, "POST", decision(merchantRequest.profile.revision));
    current = await own(driver); assert.equal(current.affiliation?.status, "ENDORSED");
    const activatePath = adminPath(pId, "affiliations/" + affId + "/activate");
    await change(admin, activatePath, decision(current.profile.revision));
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, true);
    assert.equal((await drivers.eligibility(pId, otherTenant.store.id)).eligible, false);
    await db("merchant_store").where({ id: tenant.store.id, merchant_id: tenant.merchant.id }).update({ active: false });
    assert.deepEqual((await own(driver)).eligibility, { eligible: false, reason: "STORE_UNAVAILABLE" });
    const adminSummary = await http("/admin/gospaza/drivers/" + pId, admin) as DriverAccountDTO;
    assert.deepEqual(adminSummary.eligibility, { eligible: false, reason: "STORE_UNAVAILABLE" });
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    await db("merchant_store").where({ id: tenant.store.id, merchant_id: tenant.merchant.id }).update({ active: true });
    const activeDetail = await http(merchantPath, owner) as { item: MerchantDriverDTO }; assert.equal(activeDetail.item.contact_phone, "+27 82 123 4567");
    current = await own(driver);
    const revocationBody = decision(current.profile.revision);
    const [revocation, eligibility] = await Promise.all([call(merchantPath + "/revoke", owner, "POST", revocationBody), drivers.eligibility(pId, tenant.store.id)]);
    assert.equal(revocation.status, 200); await revocation.text(); assert.equal(typeof eligibility.eligible, "boolean");
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    await http(merchantPath + "/revoke", manager, "POST", revocationBody);
    assert.equal((await db("driver_event").where({ driver_profile_id: pId, action: "REVOKE" })).length, 1);
    assert.equal((await own(driver)).affiliation, null);
    await http(merchantPath, owner, "GET", undefined, 404);
    const replacementRequest = await request(driver, otherTenant.store.id);
    assert.ok(replacementRequest.affiliation);
    await http(merchantPath + "/revoke", owner, "POST", revocationBody);
    assert.equal((await own(driver)).affiliation?.id, replacementRequest.affiliation.id, "Old revoke replay must not touch a new affiliation");
    await change(driver, "/driver/affiliations/" + replacementRequest.affiliation.id + "/withdraw", { expected_revision: replacementRequest.profile.revision });
    current = await own(driver); await change(admin, adminPath(pId, "suspend"), decision(current.profile.revision));
    current = await own(driver); await http(adminPath(pId, "reactivate"), admin, "POST", decision(current.profile.revision), 409);
    await change(admin, adminPath(pId, "deactivate"), decision(current.profile.revision));
    assert.equal((await bootstrap(driver)).profile.id, pId);
    assert.equal((await bootstrap(driver)).profile.status, "DEACTIVATED");
    current = await own(driver);
    await http("/driver/affiliations", driver, "POST", { expected_revision: current.profile.revision, kind: "PLATFORM" }, 409);
    assert.equal((await drivers.eligibility(pId, tenant.store.id)).eligible, false);
    // Isolated second driver exercises competing affiliation and admin decisions.
    const racer = await account("racer"); const rp = await bootstrap(racer); await complete(racer);
    let rstate = await own(racer);
    const attempts = await Promise.all([
      call("/driver/affiliations", racer, "POST", { expected_revision: rstate.profile.revision, kind: "MERCHANT", merchant_store_id: tenant.store.id }),
      call("/driver/affiliations", racer, "POST", { expected_revision: rstate.profile.revision, kind: "MERCHANT", merchant_store_id: otherTenant.store.id }),
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    for (const response of attempts) await response.text();
    rstate = await own(racer); assert.ok(rstate.affiliation);
    assert.equal((await db("driver_affiliation").where({ driver_profile_id: rp.profile.id }).whereIn("status", ["REQUESTED", "ENDORSED", "ACTIVE"])).length, 1);
    const winner = rstate.affiliation.merchant_store_id === tenant.store.id ? owner : foreign;
    const route = "/merchant/drivers/" + rstate.affiliation.id;
    const race = await Promise.all([call(route + "/endorse", winner, "POST", decision(rstate.profile.revision)), call(route + "/decline", winner, "POST", decision(rstate.profile.revision))]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    for (const response of race) await response.text();
    rstate = await own(racer);
    if (!rstate.affiliation) await request(racer);
    const review = await submit(racer);
    const reviews = await Promise.all([call(adminPath(rp.profile.id, "approve"), admin, "POST", decision(review.profile.revision)), call(adminPath(rp.profile.id, "require-changes"), admin, "POST", decision(review.profile.revision))]);
    assert.deepEqual(reviews.map(r => r.status).sort(), [200, 409]);
    for (const response of reviews) await response.text();
    // A new merchant-affiliated applicant exercises initial atomic activation.
    const applicant = await account("merchant-applicant"); const appProfile = await bootstrap(applicant);
    await complete(applicant); const req = await request(applicant, tenant.store.id); assert.ok(req.affiliation);
    await submit(applicant);
    let applicantState = await own(applicant);
    const affiliationPath = "/merchant/drivers/" + req.affiliation.id;
    await http(adminPath(appProfile.profile.id, "approve"), admin, "POST", decision(applicantState.profile.revision), 409);
    // Endorsement versus review uses the same profile revision. Review can never
    // approve the old unendorsed generation, regardless of transaction order.
    const endorsementReview = await Promise.all([
      call(affiliationPath + "/endorse", owner, "POST", decision(applicantState.profile.revision)),
      call(adminPath(appProfile.profile.id, "approve"), admin, "POST", decision(applicantState.profile.revision)),
    ]);
    assert.deepEqual(endorsementReview.map(r => r.status), [200,409]);
    for (const response of endorsementReview) await response.text();
    applicantState = await own(applicant);
    await change(admin, adminPath(appProfile.profile.id, "approve"), decision(applicantState.profile.revision));
    const initialActive = await own(applicant);
    assert.equal(initialActive.profile.status, "ACTIVE"); assert.equal(initialActive.affiliation?.status, "ACTIVE");
    assert.equal((await drivers.eligibility(appProfile.profile.id, tenant.store.id)).eligible, true);
    // Replacing the affiliation leaves an ineligible gap; it never auto-converts.
    assert.ok(initialActive.affiliation);
    await change(applicant, "/driver/affiliations/" + initialActive.affiliation.id + "/withdraw", { expected_revision: initialActive.profile.revision });
    const nextAffiliation = await request(applicant); assert.ok(nextAffiliation.affiliation);
    const laterActivate = adminPath(appProfile.profile.id, "affiliations/" + nextAffiliation.affiliation.id + "/activate");
    const activateSuspend = await Promise.all([
      call(laterActivate, admin, "POST", decision(nextAffiliation.profile.revision)),
      call(adminPath(appProfile.profile.id, "suspend"), admin, "POST", decision(nextAffiliation.profile.revision)),
    ]);
    assert.deepEqual(activateSuspend.map(r => r.status).sort(), [200,409]);
    for (const response of activateSuspend) await response.text();
    const afterRace = await own(applicant);
    if (afterRace.profile.status === "ACTIVE") assert.equal(afterRace.affiliation?.status, "ACTIVE");
    else { assert.equal(afterRace.profile.status, "SUSPENDED"); assert.equal((await drivers.eligibility(appProfile.profile.id, tenant.store.id)).eligible, false); }
    // Deterministic resubmission race, independent of which prior reviewer won.
    const resubmitter = await account("resubmitter"); const sp = await bootstrap(resubmitter);
    await complete(resubmitter); await request(resubmitter);
    const submitted = await submit(resubmitter);
    await change(admin, adminPath(sp.profile.id, "require-changes"), decision(submitted.profile.revision));
    const resubmitState = await own(resubmitter);
    const staleReview = await Promise.all([
      call("/driver/profile/submit", resubmitter, "POST", { expected_revision: resubmitState.profile.revision }),
      call(adminPath(sp.profile.id, "approve"), admin, "POST", decision(resubmitState.profile.revision)),
    ]);
    assert.deepEqual(staleReview.map(r => r.status), [200,409]);
    for (const response of staleReview) await response.text();

    // M14-D: a later affiliation activation cannot overwrite terminal deactivation.
    let terminalCandidate = await own(resubmitter);
    await change(admin, adminPath(sp.profile.id, "approve"), decision(terminalCandidate.profile.revision));
    terminalCandidate = await own(resubmitter); assert.ok(terminalCandidate.affiliation);
    await change(resubmitter, "/driver/affiliations/" + terminalCandidate.affiliation.id + "/withdraw", { expected_revision: terminalCandidate.profile.revision });
    const terminalRequest = await request(resubmitter); assert.ok(terminalRequest.affiliation);
    const terminalActivation = adminPath(sp.profile.id, "affiliations/" + terminalRequest.affiliation.id + "/activate");
    const terminalBody = decision(terminalRequest.profile.revision);
    const terminalRace = await Promise.all([
      call(terminalActivation, admin, "POST", terminalBody),
      call(adminPath(sp.profile.id, "deactivate"), admin, "POST", terminalBody),
    ]);
    assert.deepEqual(terminalRace.map(r => r.status).sort(), [200, 409]);
    for (const response of terminalRace) await response.text();
    terminalCandidate = await own(resubmitter);
    assert.equal(terminalCandidate.profile.revision, terminalRequest.profile.revision + 1);
    const terminalEvents = await db("driver_event").where({ driver_profile_id: sp.profile.id, previous_revision: terminalRequest.profile.revision });
    assert.equal(terminalEvents.length, 1); assert.equal(terminalEvents[0].actor_id, reviewer);
    if (terminalCandidate.profile.status === "ACTIVE") {
      assert.equal(terminalCandidate.affiliation?.status, "ACTIVE");
      await change(admin, adminPath(sp.profile.id, "deactivate"), decision(terminalCandidate.profile.revision));
    } else assert.equal(terminalCandidate.profile.status, "DEACTIVATED");
    terminalCandidate = await own(resubmitter);
    await http(terminalActivation, admin, "POST", decision(terminalCandidate.profile.revision), 409);
    assert.equal((await drivers.eligibility(sp.profile.id, tenant.store.id)).eligible, false);
    assert.equal((await bootstrap(resubmitter)).profile.status, "DEACTIVATED");

    // Audit failure rolls back the profile update at deferred commit.
    const before = await own(racer);
    await assert.rejects(db.transaction(async trx => { await trx("driver_profile").where({ id: rp.profile.id }).update({ revision: before.profile.revision + 1 }); }));
    assert.equal((await own(racer)).profile.revision, before.profile.revision);
    // Cross-driver known ID cannot be used even with the current victim revision.
    const oldAff = await db<{ id: string }>("driver_affiliation").where({ driver_profile_id: pId }).first(); assert.ok(oldAff);
    await http("/driver/affiliations/" + oldAff.id + "/withdraw", racer, "POST", { expected_revision: before.profile.revision }, 404);
    await http("/driver/affiliations/unknown/withdraw", racer, "POST", { expected_revision: before.profile.revision }, 404);
    await http(adminPath(rp.profile.id, "approve"), owner, "POST", decision(before.profile.revision), 401);
    await http(adminPath(rp.profile.id, "approve"), racer, "POST", decision(before.profile.revision), 401);
    // A profile/affiliation grant is insufficient after native identity removal.
    await auth.deleteAuthIdentities([racer.identity]);
    assert.equal((await drivers.eligibility(rp.profile.id, tenant.store.id)).eligible, false);
    await http("/driver/profile", racer, "GET", undefined, 401);
    // Removed/inactive memberships lose tenant authority, including known IDs.
    const managerMember = await db<{ id: string }>("merchant_member").where({ auth_identity_id: manager.identity }).first(); assert.ok(managerMember);
    await market.teamService.changeMember(owner.identity, managerMember.id, { status: "INACTIVE" });
    await http("/merchant/drivers", manager, "GET", undefined, 401);
    await http(merchantPath + "/revoke", manager, "POST", revocationBody, 401);
  } catch (error) { failures.push(error); }
  finally {
    for (const email of publicEmails) {
      try { for (const p of await auth.listProviderIdentities({ provider: "emailpass", entity_id: email })) if (p.auth_identity_id && !identities.includes(p.auth_identity_id)) identities.push(p.auth_identity_id); }
      catch (error) { failures.push(error); }
    }
    for (const cookie of cookies) {
      try { const r = await fetch(new URL("/auth/session", base), { method: "DELETE", headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) }); assert.ok([200,401].includes(r.status)); }
      catch (error) { failures.push(error); }
    }
    let removed = false;
    try {
      await db.transaction(async trx => {
        const profiles = await trx<{ id: string }>("driver_profile").whereIn("auth_identity_id", identities).select("id");
        const ids = profiles.map(p => p.id);
        await trx("driver_event").whereIn("driver_profile_id", ids).delete();
        await trx("driver_affiliation").whereIn("driver_profile_id", ids).delete();
        await trx("driver_profile").whereIn("id", ids).delete();
        const apps = await trx<{ id: string }>("merchant_application").whereIn("id", appIds).whereIn("applicant_identity_id", identities).select("id");
        const merchants = await trx<{ id: string }>("merchant").whereIn("source_application_id", apps.map(a => a.id)).select("id");
        const mids = merchants.map(m => m.id);
        await trx("merchant_invitation").whereIn("merchant_id", mids).delete();
        await trx("merchant_member").whereIn("merchant_id", mids).delete();
        await trx("merchant_store").whereIn("merchant_id", mids).delete();
        await trx("merchant").whereIn("id", mids).delete();
        await trx("merchant_application").whereIn("id", apps.map(a => a.id)).delete();
      }); removed = true;
    } catch (error) { failures.push(new Error("M14 fixture cleanup failed: " + prefix, { cause: error })); }
    if (removed) for (const cleanup of [() => customers.deleteCustomers(customerIds), () => users.deleteUsers(userIds), () => auth.deleteAuthIdentities(identities)]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    try { await keys.revoke(key.id, { revoked_by: prefix, revoke_in: 0 }); await keys.deleteApiKeys(key.id); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "M14 driver verification failed; fixture " + prefix);
  console.log("M14-B passed: metadata-free native identity, actor isolation, lifecycle, tenant affiliation, eligibility, real races and audit rollback.");
}
