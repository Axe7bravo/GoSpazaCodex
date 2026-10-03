import assert from "node:assert/strict";
import { test } from "node:test";
import { MedusaError } from "@medusajs/framework/utils";
import {
  acceptInput, capabilitiesFor, invitationLifetimeMs, invitationSecret, invitationState,
  inviteInput, memberInput, normalizeEmail, requireCapability, teamParse, tokenHash,
} from "../src/modules/marketplace/team-policy";
import { merchantBoundary } from "../src/lib/applicant-auth";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { emailPassEmail } from "../src/lib/team-http";
import type { IAuthModuleService } from "@medusajs/framework/types";

test("M4 capability matrix and reusable backend rejection", () => {
  assert.deepEqual(capabilitiesFor("OWNER"), ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_TEAM_MANAGE", "MERCHANT_CATALOG_VIEW", "MERCHANT_CATALOG_MANAGE", "MERCHANT_INVENTORY_VIEW", "MERCHANT_INVENTORY_MANAGE"]);
  assert.deepEqual(capabilitiesFor("MANAGER"), ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_CATALOG_VIEW", "MERCHANT_CATALOG_MANAGE", "MERCHANT_INVENTORY_VIEW", "MERCHANT_INVENTORY_MANAGE"]);
  assert.deepEqual(capabilitiesFor("PICKER"), ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_CATALOG_VIEW", "MERCHANT_INVENTORY_VIEW"]);
  for (const role of ["MANAGER", "PICKER"] as const) {
    assert.throws(() => requireCapability(role, "MERCHANT_TEAM_MANAGE"), { type: MedusaError.Types.FORBIDDEN });
  }
  assert.throws(() => requireCapability("PICKER", "MERCHANT_TEAM_VIEW"), { type: MedusaError.Types.FORBIDDEN });
  assert.doesNotThrow(() => requireCapability("OWNER", "MERCHANT_TEAM_MANAGE"));
});

test("strict team inputs reject ownership and identity injection", () => {
  assert.equal(normalizeEmail(" Owner@Example.TEST "), "owner@example.test");
  assert.deepEqual(teamParse(inviteInput, { email: " Picker@Example.TEST ", role: "PICKER" }), { email: "picker@example.test", role: "PICKER" });
  for (const input of [{ email: "x@example.test", role: "OWNER" }, { email: "x@example.test", role: "PICKER", merchant_id: "other" }]) {
    assert.throws(() => teamParse(inviteInput, input), { type: MedusaError.Types.INVALID_DATA });
  }
  for (const input of [{}, { role: "OWNER" }, { status: "SUSPENDED" }, { role: "PICKER", auth_identity_id: "other" }]) {
    assert.throws(() => teamParse(memberInput, input), { type: MedusaError.Types.INVALID_DATA });
  }
  assert.throws(() => teamParse(acceptInput, { token: "A".repeat(43), role: "OWNER" }));
  assert.throws(() => teamParse(acceptInput, { token: "../../secret" }));
});

test("invitation terminal states and exact expiry boundary", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const pending = { accepted_at: null, revoked_at: null, expires_at: new Date(now.getTime() + 1) };
  assert.equal(invitationState(pending, now), "PENDING");
  assert.equal(invitationState({ ...pending, expires_at: now }, now), "EXPIRED");
  assert.equal(invitationState({ ...pending, revoked_at: now }, now), "REVOKED");
  assert.equal(invitationState({ ...pending, expires_at: new Date(0), accepted_at: now }, now), "ACCEPTED");
});

test("invitation secret verifier and centralized bounded expiry", () => {
  const secret = invitationSecret();
  assert.equal(secret.token.length, 43);
  assert.equal(secret.hash, tokenHash(secret.token));
  assert.notEqual(secret.hash, secret.token);
  assert.equal(invitationLifetimeMs({}), 7 * 86400000);
  assert.equal(invitationLifetimeMs({ MERCHANT_INVITATION_EXPIRY_DAYS: "2" }), 2 * 86400000);
  for (const value of ["", " ", "0", "31", "1.5", "NaN", "1e1"]) {
    assert.throws(() => invitationLifetimeMs({ MERCHANT_INVITATION_EXPIRY_DAYS: value }), /MERCHANT_INVITATION_EXPIRY_DAYS/);
  }
});

test("email binding uses native provider/entity_id, never metadata or request input", async () => {
  const auth = {
    retrieveAuthIdentity: async () => ({ id: "auth_fixture", provider_identities: [{
      id: "provider_fixture", provider: "emailpass", entity_id: "correct@example.test",
      user_metadata: { email: "wrong@example.test" },
    }] }),
  } as unknown as IAuthModuleService;
  assert.equal(await emailPassEmail(auth, "auth_fixture"), "correct@example.test");
  const absent = { retrieveAuthIdentity: async () => ({ id: "auth_fixture", provider_identities: [] }) } as unknown as IAuthModuleService;
  await assert.rejects(emailPassEmail(absent, "auth_fixture"), { type: MedusaError.Types.UNAUTHORIZED });
});

test("only the exact merchant POST acceptance route bypasses existing tenancy", async () => {
  for (const actor of ["merchant", "customer", "driver", "user"]) {
    for (const [method, path] of [
      ["POST", "/merchant/team/invitations/accept"],
      ["GET", "/merchant/team/invitations/accept"],
      ["POST", "/merchant/team/invitations/accept/extra"],
      ["POST", "/merchant/team/invitations"],
    ]) {
      let allowed = false;
      let status = 0;
      const req = {
        method, originalUrl: path, path: "/", headers: {},
        session: { auth_context: { actor_type: actor, actor_id: "", auth_identity_id: "auth_fixture" } },
        scope: { resolve: (name: string) => name === "marketplace"
          ? { resolveTenant: async () => { throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "No membership"); } }
          : { projectConfig: { http: { jwtSecret: "fixture-only" } } } },
      } as unknown as MedusaRequest;
      const res = { status(value: number) { status = value; return this; }, json() {} } as unknown as MedusaResponse;
      await merchantBoundary(req, res, () => { allowed = true; });
      const expected = actor === "merchant" && method === "POST" && path === "/merchant/team/invitations/accept";
      assert.equal(allowed, expected);
      if (!expected) assert.equal(status, 401);
    }
  }
});
