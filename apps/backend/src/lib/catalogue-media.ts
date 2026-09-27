import type { MedusaContainer, IFileModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { PUBLIC_PREFIX } from "../modules/routed-file/storage";

export interface CatalogueMediaRow {
  id: string;
  profile_id: string;
  file_key: string;
  public_url: string;
  removal_pending: boolean;
}
export async function cleanupCatalogueMedia(container: MedusaContainer, media: CatalogueMediaRow) {
  if (!media.removal_pending || !media.file_key.startsWith(PUBLIC_PREFIX)) throw new Error("Invalid catalogue cleanup reference.");
  const query = container.resolve<{
    graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: { id: string }[] }>;
  }>(ContainerRegistrationKeys.QUERY);
  const references = await Promise.all([
    query.graph({ entity: "product_image", fields: ["id"], filters: { url: media.public_url } }),
    query.graph({ entity: "product", fields: ["id"], filters: { thumbnail: media.public_url } }),
    query.graph({ entity: "product_variant", fields: ["id"], filters: { thumbnail: media.public_url } }),
  ]);
  if (references.some((result) => result.data.length)) return false;
  await container.resolve<IFileModuleService>(Modules.FILE).deleteFiles(media.file_key);
  await container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("catalogue_media").where({ id: media.id, removal_pending: true }).delete();
  return true;
}
