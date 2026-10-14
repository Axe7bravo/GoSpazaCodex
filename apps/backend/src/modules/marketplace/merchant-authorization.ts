import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { MedusaError } from "@medusajs/framework/utils";
import type MarketplaceService from "./service";
import { requireCapability } from "./team-policy";
import type { Capability } from "./team-policy";

export type ActiveMerchant = Awaited<ReturnType<MarketplaceService["resolveTenant"]>>;
// Shared M11/M12 outer boundary. Team revocation uses the same merchant lock.
export async function withMerchantAuthorization<T>(
  db: Knex, marketplace: MarketplaceService, identity: string, capability: Capability,
  work: (trx: Knex.Transaction, tenant: ActiveMerchant) => Promise<T>,
): Promise<T> {
  const initial = await marketplace.resolveTenant(identity);
  return db.transaction(async (trx) => {
    await trx("merchant").where({ id: initial.merchant.id }).forUpdate().first();
    const tenant = await marketplace.resolveTenant(identity, trx);
    if (tenant.merchant.id !== initial.merchant.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant context changed.");
    requireCapability(tenant.membership.member_type, capability);
    return work(trx, tenant);
  });
}
