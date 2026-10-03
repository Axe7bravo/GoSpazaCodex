import { createHash } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";

// Hold across native workflows AND compensation. Native persistence does not
// participate in this transaction; it provides the outer serialization boundary.
export async function cartOperation<T>(container: MedusaContainer, customerId: string,
  work: () => Promise<T>): Promise<T> {
  if (!customerId) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  const key = createHash("sha256").update("gospaza:customer-cart:" + customerId).digest().readBigInt64BE().toString();
  return container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION).transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '10s'");
    await trx.raw("select pg_advisory_xact_lock(?::bigint)", [key]);
    return work();
  });
}
