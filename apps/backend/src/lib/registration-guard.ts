import { createHash } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { IAuthModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { POST as nativeRegister } from "@medusajs/medusa/api/auth/[actor_type]/[auth_provider]/register/route";
import { AUTH_METHODS } from "./auth-config";

// Medusa 2.18 EmailPass register can reset an unclaimed identity's password.
// Merchant applicants/members deliberately derive tenancy from membership, not
// native actor metadata. Public registration must never reclaim that identity.
// Native registration/token issuance remains unchanged for new identities.
export async function guardEmailPassRegistration(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (req.params.auth_provider !== "emailpass") { next(); return; }
  try {
    const actor = req.params.actor_type;
    if ((actor !== "merchant" && actor !== "customer") || !AUTH_METHODS[actor].includes("emailpass")) {
      throw new MedusaError(MedusaError.Types.FORBIDDEN, "Registration is not available.");
    }
    const body = req.body as { email?: unknown } | undefined;
    if (typeof body?.email !== "string") throw new MedusaError(MedusaError.Types.INVALID_DATA, "Email required.");
    const email = body.email;
    const lockKey = createHash("sha256").update("gospaza:emailpass-register:" + email).digest().readBigInt64BE().toString();
    const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
    await db.transaction(async (trx) => {
      // Transaction-scoped advisory lock has no lease that can expire mid-write.
      // No native auth table is accessed through SQL; lookups use its public API.
      await trx.raw("SET LOCAL lock_timeout = '5s'");
      await trx.raw("select pg_advisory_xact_lock(?::bigint)", [lockKey]);
      const existing = await auth.listProviderIdentities({ provider: "emailpass", entity_id: email }, { take: 1 });
      if (existing.length) {
        // Existing clients already fall back from 401 registration to native login.
        throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in with the existing account.");
      }
      await nativeRegister(req, res);
    });
  } catch (error) { next(error); }
}
