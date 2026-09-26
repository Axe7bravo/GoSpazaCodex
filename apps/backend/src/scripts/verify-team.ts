import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IAuthModuleService, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type MarketplaceService from "../modules/marketplace/service";
import { tokenHash } from "../modules/marketplace/team-policy";

type Session = { identity: string; email: string; cookie: string };
type Created = Awaited<ReturnType<MarketplaceService["teamService"]["invite"]>>;
const invitePath = "/merchant/team/invitations";
const memberPath = (id: string) => "/merchant/team/members/" + id;

// Real native auth sessions, HTTP middleware and PostgreSQL transactions.
// Only synthetic fixtures from this invocation are removed during cleanup.
export default async function verifyTeam({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M4 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const market = container.resolve<MarketplaceService>("marketplace");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const prefix = "m4-" + randomUUID();
  const registrationEmail = prefix + "-registration-race@example.test";
  const password = randomBytes(24).toString("hex");
  const identities: string[] = [], cookies: string[] = [], userIds: string[] = [], appIds: string[] = [];
  const failures: unknown[] = [];
  async function request(path: string, session?: Session, method = "GET", body?: unknown) {
    return fetch(new URL(path, base), {
      method, signal: AbortSignal.timeout(60000),
      headers: { ...(session ? { Cookie: session.cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function expectStatus(response: Promise<Response> | Response, status: number) {
    const result = await response;
    assert.equal(result.status, status, "Unexpected HTTP status (response body deliberately omitted)");
    return result;
  }
  async function session(suffix: string, actor = "merchant"): Promise<Session> {
    const email = prefix + "-" + suffix + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password } });
    assert.ok(registered.success && registered.authIdentity);
    const identity = registered.authIdentity.id;
    identities.push(identity);
    if (actor === "user") {
      const user = await users.createUsers({ email });
      userIds.push(user.id);
      await auth.updateAuthIdentities({ id: identity, app_metadata: { user_id: user.id } });
    }
    const login = await expectStatus(request("/auth/" + actor + "/emailpass", undefined, "POST", { email, password }), 200);
    const loginBody = await login.json() as { token: string };
    const exchanged = await fetch(new URL("/auth/session", base), {
      method: "POST", headers: { Authorization: "Bearer " + loginBody.token }, signal: AbortSignal.timeout(60000),
    });
    assert.equal(exchanged.status, 200);
    const cookie = exchanged.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie);
    cookies.push(cookie);
    return { identity, email, cookie };
  }
  async function provision(owner: Session) {
    const app = await market.createDraft(owner.identity);
    assert.ok(app);
    appIds.push(app.id);
    await market.edit(app.id, owner.identity, {
      legal_name: prefix, trading_name: prefix + " shop", contact_name: "Fixture", contact_email: owner.email,
      contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Fixture city",
      province: "Fixture province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "Synthetic M4 fixture",
    });
    await market.submit(app.id, owner.identity);
    await market.review(app.id, userIds[0]!, "start-review");
    return market.provision(app.id, userIds[0]!, "Synthetic M4 provisioning");
  }
  async function invite(owner: Session, email: string, role: "MANAGER" | "PICKER" = "MANAGER"): Promise<Created> {
    const response = await expectStatus(request(invitePath, owner, "POST", { email, role }), 201);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const created = await response.json() as Created;
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(created.token), "Strong token format required");
    assert.ok(!("token_hash" in created.invitation));
    return created;
  }
  const accept = (who: Session | undefined, created: Created, extra: Record<string, string> = {}) => request(invitePath + "/accept", who, "POST", { token: created.token, ...extra });
  async function memberships(who: Session) {
    return db<{ id: string; merchant_id: string; member_type: string; status: string }>("merchant_member").where({ auth_identity_id: who.identity });
  }
  try {
    const platform = await session("platform", "user");
    const ownerA = await session("owner-a"), ownerB = await session("owner-b");
    const tenantA = await provision(ownerA), tenantB = await provision(ownerB);
    const manager = await session("manager"), picker = await session("picker"), outsider = await session("outsider");
    await expectStatus(request("/merchant/me", ownerA), 200);
    await expectStatus(request("/merchant/me", outsider), 401);
    await expectStatus(request(invitePath, ownerA, "POST", { email: ownerA.email.toUpperCase(), role: "PICKER" }), 409);
    await expectStatus(request(invitePath, ownerA, "POST", { email: manager.email, role: "OWNER" }), 400);
    for (const injection of [{ merchant_id: tenantB.merchant.id }, { created_by_member_id: tenantB.membership.id }, { auth_identity_id: outsider.identity }]) {
      await expectStatus(request(invitePath, ownerA, "POST", { email: manager.email, role: "MANAGER", ...injection }), 400);
    }
    const duplicate = await Promise.all([
      request(invitePath, ownerA, "POST", { email: manager.email, role: "MANAGER" }),
      request(invitePath, ownerA, "POST", { email: manager.email.toUpperCase(), role: "MANAGER" }),
    ]);
    assert.deepEqual(duplicate.map((r) => r.status).sort(), [201, 409]);
    const managerInvite = await duplicate.find((r) => r.status === 201)!.json() as Created;
    const stored = await db<{ token_hash: string }>("merchant_invitation").where({ id: managerInvite.invitation.id }).first();
    assert.ok(stored && stored.token_hash === tokenHash(managerInvite.token));
    await expectStatus(accept(undefined, managerInvite), 401);
    for (const wrong of [platform, await session("customer", "customer"), await session("driver", "driver")]) {
      await expectStatus(accept(wrong, managerInvite), 401);
      await expectStatus(request("/merchant/team", wrong), 401);
    }
    await expectStatus(accept(outsider, managerInvite), 409);
    await expectStatus(accept(manager, managerInvite, { merchant_id: tenantB.merchant.id }), 400);
    await expectStatus(accept(manager, managerInvite, { role: "OWNER" }), 400);
    await expectStatus(accept(manager, managerInvite, { auth_identity_id: ownerA.identity }), 400);
    const accepted = await Promise.all([accept(manager, managerInvite), accept(manager, managerInvite)]);
    assert.deepEqual(accepted.map((r) => r.status).sort(), [200, 409]);
    await expectStatus(accept(manager, managerInvite), 409);
    const managerRows = await memberships(manager);
    assert.equal(managerRows.length, 1);
    const member = managerRows[0]!;
    assert.equal(member.member_type, "MANAGER");
    assert.equal(member.merchant_id, tenantA.merchant.id);
    const pickerInvite = await invite(ownerA, picker.email, "PICKER");
    await expectStatus(accept(picker, pickerInvite), 200);
    const pickerRows = await memberships(picker);
    assert.equal(pickerRows.length, 1);
    const pickerMember = pickerRows[0]!;
    const managerContext = await (await expectStatus(request("/merchant/me", manager), 200)).json() as { membership: { capabilities: string[] } };
    assert.ok(managerContext.membership.capabilities.includes("MERCHANT_TEAM_VIEW"));
    assert.ok(!managerContext.membership.capabilities.includes("MERCHANT_TEAM_MANAGE"));
    await expectStatus(request("/merchant/me", picker), 200);
    await expectStatus(request("/merchant/team", manager), 200);
    await expectStatus(request("/merchant/team", picker), 403);
    const pending = await invite(ownerA, outsider.email);
    for (const restricted of [manager, picker]) {
      await expectStatus(request(invitePath, restricted, "POST", { email: outsider.email, role: "PICKER" }), 403);
      await expectStatus(request(invitePath + "/" + pending.invitation.id + "/revoke", restricted, "POST", {}), 403);
      await expectStatus(request(memberPath(member.id), restricted, "PATCH", { status: "INACTIVE" }), 403);
    }
    // Known, real resources from the other merchant, not merely nonexistent IDs.
    await expectStatus(request(memberPath(member.id), ownerB, "PATCH", { status: "INACTIVE" }), 404);
    await expectStatus(request(invitePath + "/" + pending.invitation.id + "/revoke", ownerB, "POST", {}), 404);
    for (const input of [{ role: "PICKER" }, { status: "INACTIVE" }]) {
      await expectStatus(request(memberPath(tenantA.membership.id), ownerA, "PATCH", input), 403);
    }
    for (const input of [{ role: "OWNER" }, { status: "SUSPENDED" }, { merchant_id: tenantB.merchant.id }, {}]) {
      await expectStatus(request(memberPath(member.id), ownerA, "PATCH", input), 400);
    }
    await expectStatus(request(memberPath(member.id), ownerA, "PATCH", { role: "PICKER" }), 200);
    await expectStatus(request("/merchant/team", manager), 403);
    await expectStatus(request(memberPath(member.id), ownerA, "PATCH", { role: "MANAGER" }), 200);
    await expectStatus(request(memberPath(pickerMember.id), ownerA, "PATCH", { status: "INACTIVE" }), 200);
    await expectStatus(request("/merchant/me", picker), 401);
    await assert.rejects(market.resolveTenant(picker.identity));
    const conflicting = await invite(ownerB, picker.email);
    await expectStatus(accept(picker, conflicting), 409); // Inactive identities cannot switch either.
    await expectStatus(request(memberPath(pickerMember.id), ownerA, "PATCH", { status: "ACTIVE" }), 200);
    await expectStatus(request("/merchant/me", picker), 200);
    await expectStatus(accept(picker, conflicting), 409);
    assert.equal((await memberships(picker)).length, 1);
    await expectStatus(request(invitePath, ownerA, "POST", { email: manager.email, role: "PICKER" }), 409);
    const listed = await (await expectStatus(request(invitePath, ownerA), 200)).json() as { invitations: Record<string, unknown>[] };
    assert.ok(listed.invitations.some((row) => row.id === managerInvite.invitation.id && row.state === "ACCEPTED"));
    for (const row of listed.invitations) assert.deepEqual(Object.keys(row).sort(), ["id", "email", "role", "state", "expires_at", "created_at"].sort());
    const members = await (await expectStatus(request("/merchant/team", ownerA), 200)).json() as { members: Record<string, unknown>[] };
    for (const row of members.members) assert.deepEqual(Object.keys(row).sort(), ["id", "role", "status", "created_at"].sort());
    // A committed revocation remains terminal under repeated simultaneous requests.
    const revokePath = invitePath + "/" + pending.invitation.id + "/revoke";
    await expectStatus(request(revokePath, ownerA, "POST", {}), 200);
    const revokedRace = await Promise.all([accept(outsider, pending), request(revokePath, ownerA, "POST", {})]);
    assert.deepEqual(revokedRace.map((r) => r.status), [409, 200]);
    assert.equal((await memberships(outsider)).length, 0);
    // Also race an initially pending acceptance against revocation. Exactly one
    // terminal transition wins; a successful revoke can never coexist with accept.
    const raceUser = await session("race");
    const racing = await invite(ownerA, raceUser.email, "PICKER");
    const raced = await Promise.all([accept(raceUser, racing), request(invitePath + "/" + racing.invitation.id + "/revoke", ownerA, "POST", {})]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
    const terminal = await db<{ accepted_at: Date | null; revoked_at: Date | null }>("merchant_invitation").where({ id: racing.invitation.id }).first();
    assert.ok(terminal);
    assert.equal(Boolean(terminal.accepted_at), raced[0]!.status === 200);
    assert.equal(Boolean(terminal.revoked_at), raced[1]!.status === 200);
    assert.equal((await memberships(raceUser)).length, raced[0]!.status === 200 ? 1 : 0);
    const expired = await invite(ownerA, outsider.email);
    await db("merchant_invitation").where({ id: expired.invitation.id }).update({ expires_at: new Date(0) });
    await expectStatus(accept(outsider, expired), 409);
    const replacement = await invite(ownerA, outsider.email);
    const afterExpiry = await (await expectStatus(request(invitePath, ownerA), 200)).json() as { invitations: { id: string; state: string }[] };
    assert.equal(afterExpiry.invitations.find((row) => row.id === expired.invitation.id)?.state, "EXPIRED");
    assert.equal(replacement.invitation.state, "PENDING");
    // Different merchant locks: the global DB identity constraint must decide.
    const globalUser = await session("global");
    const globalA = await invite(ownerA, globalUser.email), globalB = await invite(ownerB, globalUser.email);
    const globalRace = await Promise.all([accept(globalUser, globalA), accept(globalUser, globalB)]);
    assert.deepEqual(globalRace.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await memberships(globalUser)).length, 1);
    await assert.rejects(async () => await db("merchant_member").insert({ id: "mmem_" + randomUUID(), merchant_id: tenantB.merchant.id, auth_identity_id: manager.identity, member_type: "PICKER" }), { code: "23505" });
    // Registration must not overwrite an already linked, actorless EmailPass identity.
    for (const actor of ["merchant", "customer"]) {
      await expectStatus(request("/auth/" + actor + "/emailpass/register", undefined, "POST", { email: manager.email, password: "different-long-password" }), 401);
    }
    assert.equal((await auth.authenticate("emailpass", { body: { email: manager.email, password } })).success, true);
    assert.equal((await auth.authenticate("emailpass", { body: { email: manager.email, password: "different-long-password" } })).success, false);
    const registrationRace = await Promise.all([
      request("/auth/merchant/emailpass/register", undefined, "POST", { email: registrationEmail, password }),
      request("/auth/customer/emailpass/register", undefined, "POST", { email: registrationEmail, password: "other-registration-password" }),
    ]);
    const providers = await auth.listProviderIdentities({ provider: "emailpass", entity_id: registrationEmail });
    for (const provider of providers) if (provider.auth_identity_id) identities.push(provider.auth_identity_id);
    assert.deepEqual(registrationRace.map((r) => r.status).sort(), [200, 401]);
    assert.equal(providers.length, 1);
    const winningPassword = registrationRace[0]!.status === 200 ? password : "other-registration-password";
    const losingPassword = registrationRace[0]!.status === 200 ? "other-registration-password" : password;
    assert.equal((await auth.authenticate("emailpass", { body: { email: registrationEmail, password: winningPassword } })).success, true);
    assert.equal((await auth.authenticate("emailpass", { body: { email: registrationEmail, password: losingPassword } })).success, false);
  } catch (error) { failures.push(error); }
  finally {
    // Track a public registration even if the HTTP response was interrupted.
    try {
      const created = await auth.listAuthIdentities({ provider_identities: { provider: "emailpass", entity_id: registrationEmail } });
      for (const identity of created) if (!identities.includes(identity.id)) identities.push(identity.id);
    } catch (error) { failures.push(error); }
    for (const cookie of cookies) {
      try { await expectStatus(request("/auth/session", { identity: "", email: "", cookie }, "DELETE"), 200); }
      catch (error) { failures.push(error); }
    }
    let removed = false;
    try {
      await db.transaction(async (trx) => {
        const apps = await trx<{ id: string }>("merchant_application").whereIn("id", appIds).whereIn("applicant_identity_id", identities).select("id");
        const merchants = await trx<{ id: string }>("merchant").whereIn("source_application_id", apps.map((row) => row.id)).select("id");
        const mids = merchants.map((row) => row.id);
        await trx("merchant_invitation").whereIn("merchant_id", mids).delete();
        await trx("merchant_member").whereIn("merchant_id", mids).delete();
        await trx("merchant_store").whereIn("merchant_id", mids).delete();
        await trx("merchant").whereIn("id", mids).delete();
        await trx("merchant_application").whereIn("id", apps.map((row) => row.id)).delete();
      });
      removed = true;
    } catch (error) { failures.push(new Error("M4 fixture cleanup failed; prefix " + prefix, { cause: error })); }
    if (removed) {
      for (const cleanup of [() => users.deleteUsers(userIds), () => auth.deleteAuthIdentities(identities)]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "M4 verification or cleanup failed; prefix " + prefix);
  console.log("M4 integration passed: native sessions, RBAC, tenant isolation, owner protection and real database invitation races.");
}
