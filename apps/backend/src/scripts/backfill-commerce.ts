import type { ExecArgs } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { ensureCommerce } from "../lib/commerce";
export default async function backfillCommerce({ container }: ExecArgs) {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const merchants = await db<{ id: string }>("merchant").where({ status: "ACTIVE" }).whereNull("deleted_at").select("id").orderBy("id");
  for (const merchant of merchants) {
    await ensureCommerce(container, merchant.id);
    console.log("Commerce infrastructure ready for merchant " + merchant.id);
  }
}
