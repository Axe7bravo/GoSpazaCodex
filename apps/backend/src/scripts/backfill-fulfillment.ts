import type { ExecArgs } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { LocationService } from "../lib/location-service";
export default async function backfillFulfillment({ container }: ExecArgs) {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const service = new LocationService(container);
  const stores = await db("merchant_store").whereNull("deleted_at").whereNotNull("medusa_stock_location_id").select("id");
  for (const store of stores) {
    await service.ensureFulfillment(store.id);
    const assignments = await db("merchant_store_service_zone").where({ merchant_store_id: store.id, active: true }).whereNull("deleted_at").select("service_zone_id");
    for (const assignment of assignments) await service.assign(assignment.service_zone_id, store.id, true);
  }
  container.resolve<{ info(message: string): void }>(ContainerRegistrationKeys.LOGGER).info("Fulfillment backfill completed.");
}
