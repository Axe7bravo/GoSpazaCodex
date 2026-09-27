import type { ExecArgs } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { commerceLock } from "../lib/commerce";
import { cleanupCatalogueMedia } from "../lib/catalogue-media";
import type { CatalogueMediaRow } from "../lib/catalogue-media";

// Only explicitly pending M5 records; never enumerate buckets or application files.
export default async function cleanup({ container }: ExecArgs) {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const pending = await db<CatalogueMediaRow>("catalogue_media").where({ removal_pending: true });
  let removed = 0;
  for (const media of pending) {
    const profile = await db<{ merchant_id: string }>("product_marketplace_profile").where({ id: media.profile_id }).first();
    if (!profile) throw new Error("Catalogue cleanup profile missing: " + media.id);
    await commerceLock(container, profile.merchant_id, async () => {
      const current = await db<CatalogueMediaRow>("catalogue_media").where({ id: media.id, removal_pending: true }).first();
      if (current && await cleanupCatalogueMedia(container, current)) removed++;
    });
  }
  console.log("Removed " + removed + " unreferenced catalogue files.");
}
