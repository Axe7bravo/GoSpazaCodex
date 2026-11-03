import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type SafeStoreCreditService from "../modules/store-credit/service";
export default async function restoreCheckoutCredit(container:MedusaContainer) {
  const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const rows=await db("checkout_credit_redemption as r").join("checkout_attempt as a","a.id","r.attempt_id")
    .whereNull("r.restore_id").whereNotNull("a.closed_at").whereNull("a.payment_accepted_at")
    .whereIn("a.state",["FAILED","EXPIRED","ABANDONED","SUPERSEDED"])
    .whereNotExists(db("checkout_completion as c").whereRaw("c.checkout_attempt_id=a.id").select("c.id"))
    .select("r.attempt_id").orderBy("r.spent_at").limit(20);
  const native=container.resolve<SafeStoreCreditService>("store_credit");
  for(const row of rows) await native.restoreClosedCheckout(row.attempt_id);
}
export const config={name:"gospaza-restore-closed-credit",schedule:"*/1 * * * *"};
