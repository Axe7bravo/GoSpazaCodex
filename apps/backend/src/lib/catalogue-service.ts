import { cleanupCatalogueMedia } from "./catalogue-media";
import { randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules, ProductStatus } from "@medusajs/framework/utils";
import type { MedusaContainer, IProductModuleService, IFileModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { updateProductsWorkflow, updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import type MarketplaceService from "../modules/marketplace/service";
import { requireCapability } from "../modules/marketplace/team-policy";
import type { Capability } from "../modules/marketplace/team-policy";
import { catalogueParse, productInput, catalogueQuery, stockInput, validateCatalogueImage } from "../modules/marketplace/catalogue-policy";
import { commerceContext, commerceLock, ensureCommerce } from "./commerce";
import { nativeProducts, productDTO, inventoryId } from "./catalogue-native";
import { createCatalogueProductWorkflow } from "../workflows/create-catalogue-product";
import { updateCatalogueProductWorkflow } from "../workflows/update-catalogue-product";
import { PUBLIC_PREFIX } from "../modules/routed-file/storage";

interface Profile { id: string; merchant_id: string; medusa_product_id: string; requires_age_verification: boolean }
interface Media { id: string; profile_id: string; file_key: string; public_url: string; removal_pending: boolean }
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Catalogue resource not found.");
export class CatalogueService {
  private db: Knex;
  constructor(private container: MedusaContainer, private identity: string) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private async tenant(capability: Capability) {
    const tenant = await this.container.resolve<MarketplaceService>("marketplace").resolveTenant(this.identity);
    requireCapability(tenant.membership.member_type, capability);
    return tenant;
  }
  private async write<T>(capability: Capability, work: (merchantId: string) => Promise<T>) {
    const tenant = await this.tenant(capability);
    return commerceLock(this.container, tenant.merchant.id, async () => {
      const current = await this.tenant(capability);
      if (current.merchant.id !== tenant.merchant.id) throw missing();
      return work(current.merchant.id);
    });
  }
  private async owned(merchantId: string, productId: string) {
    const profile = await this.db<Profile>("product_marketplace_profile")
      .where({ merchant_id: merchantId, medusa_product_id: productId }).whereNull("deleted_at").first();
    if (!profile) throw missing();
    return profile;
  }
  async detail(id: string) {
    const tenant = await this.tenant("MERCHANT_CATALOG_VIEW");
    return this.detailFor(tenant.merchant.id, id);
  }
  private async detailFor(merchantId: string, id: string) {
    const profile = await this.owned(merchantId, id);
    const topology = await commerceContext(this.container, merchantId);
    const [product] = await nativeProducts(this.container, [id]);
    if (!product) throw missing();
    return productDTO(this.container, product, topology.locationId, profile.requires_age_verification);
  }
  async list(input: unknown) {
    const filters = catalogueParse(catalogueQuery, input);
    const tenant = await this.tenant("MERCHANT_CATALOG_VIEW");
    const topology = await commerceContext(this.container, tenant.merchant.id);
    const profiles = await this.db<Profile>("product_marketplace_profile").where({ merchant_id: tenant.merchant.id }).whereNull("deleted_at");
    if (!profiles.length) return { products: [], count: 0, limit: filters.limit, offset: filters.offset };
    const [page, count] = await this.container.resolve<IProductModuleService>(Modules.PRODUCT).listAndCountProducts({
      id: profiles.map((p) => p.medusa_product_id), ...(filters.q ? { q: filters.q } : {}), ...(filters.status ? { status: filters.status === "draft" ? ProductStatus.DRAFT : ProductStatus.PUBLISHED } : {}),
    }, { select: ["id"], skip: filters.offset, take: filters.limit, order: { created_at: "DESC", id: "ASC" } });
    const products = await nativeProducts(this.container, page.map((p) => p.id));
    const byId = new Map(products.map((p) => [p.id, p]));
    return { products: await Promise.all(page.map((p) => productDTO(this.container, byId.get(p.id)!, topology.locationId,
      profiles.find((profile) => profile.medusa_product_id === p.id)!.requires_age_verification))), count, limit: filters.limit, offset: filters.offset };
  }
  async create(input: unknown) {
    const data = catalogueParse(productInput, input);
    if (data.variants.some((v) => v.id)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "New variants cannot supply IDs.");
    const tenant = await this.tenant("MERCHANT_CATALOG_MANAGE");
    await ensureCommerce(this.container, tenant.merchant.id);
    return this.write("MERCHANT_CATALOG_MANAGE", async (merchantId) => {
      const topology = await commerceContext(this.container, merchantId);
      const { result } = await createCatalogueProductWorkflow(this.container).run({ input: {
        merchantId, channelId: topology.channelId, locationId: topology.locationId, product: data,
      } });
      return this.detailFor(merchantId, result);
    });
  }
  async update(id: string, input: unknown) {
    const data = catalogueParse(productInput, input);
    return this.write("MERCHANT_CATALOG_MANAGE", async (merchantId) => {
      const profile = await this.owned(merchantId, id);
      const topology = await commerceContext(this.container, merchantId);
      const [product] = await nativeProducts(this.container, [id]);
      if (!product) throw missing();
      const ids = new Set(data.variants.map((v) => v.id));
      if (ids.size !== product.variants.length || data.variants.length !== product.variants.length ||
          product.variants.some((v) => !ids.has(v.id))) throw missing();
      // Option topology remains stable after creation. No variant deletion in M5.
      for (const variant of data.variants) {
        if (product.variants.find((v) => v.id === variant.id)?.title !== variant.title) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, "Variant names are fixed after creation.");
        }
      }
      await updateCatalogueProductWorkflow(this.container).run({ input: {
        productId: id, profileId: profile.id, product: data,
        levels: data.variants.map((v) => ({ inventory_item_id: inventoryId(product.variants.find((item) => item.id === v.id)!),
          location_id: topology.locationId, stocked_quantity: v.stocked_quantity })),
      } });
      return this.detailFor(merchantId, id);
    });
  }
  async inventory(input: unknown) {
    const filters = catalogueParse(catalogueQuery, input);
    const tenant = await this.tenant("MERCHANT_INVENTORY_VIEW");
    const topology = await commerceContext(this.container, tenant.merchant.id);
    const profiles = await this.db<Profile>("product_marketplace_profile").where({ merchant_id: tenant.merchant.id }).whereNull("deleted_at");
    const products = await nativeProducts(this.container, profiles.map((p) => p.medusa_product_id));
    const rows = (await Promise.all(products.map((p) => productDTO(this.container, p, topology.locationId,
      profiles.find((profile) => profile.medusa_product_id === p.id)!.requires_age_verification))))
      .flatMap((p) => p.variants.map((v) => ({ ...v, product_id: p.id, product_title: p.title })))
      .filter((v) => (v.product_title + " " + v.title + " " + v.sku).toLowerCase().includes(filters.q.toLowerCase()))
      .sort((a, b) => a.product_title.localeCompare(b.product_title) || a.id.localeCompare(b.id));
    return { items: rows.slice(filters.offset, filters.offset + filters.limit), count: rows.length, limit: filters.limit, offset: filters.offset };
  }
  async stock(itemId: string, input: unknown) {
    const data = catalogueParse(stockInput, input);
    return this.write("MERCHANT_INVENTORY_MANAGE", async (merchantId) => {
      const profiles = await this.db<Profile>("product_marketplace_profile").where({ merchant_id: merchantId }).whereNull("deleted_at");
      const products = await nativeProducts(this.container, profiles.map((p) => p.medusa_product_id));
      const product = products.find((p) => p.variants.some((v) => inventoryId(v) === itemId));
      if (!product) throw missing();
      const topology = await commerceContext(this.container, merchantId);
      await updateInventoryLevelsWorkflow(this.container).run({ input: { updates: [{
        inventory_item_id: itemId, location_id: topology.locationId, stocked_quantity: data.stocked_quantity,
      }] } });
      return this.detailFor(merchantId, product.id);
    });
  }
  async upload(productId: string, input: unknown) {
    const image = validateCatalogueImage(input);
    return this.write("MERCHANT_CATALOG_MANAGE", async (merchantId) => {
      const profile = await this.owned(merchantId, productId);
      const [product] = await nativeProducts(this.container, [productId]);
      if (!product) throw missing();
      if (product.images.length >= 10) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Maximum ten images per product.");
      const files = this.container.resolve<IFileModuleService>(Modules.FILE);
      const stored = await files.createFiles({ filename: randomUUID(), content: image.content, mimeType: image.mime_type, access: "public" });
      let mediaId: string | undefined;
      try {
        if (!stored.id.startsWith(PUBLIC_PREFIX) || !/^https?:\/\//.test(stored.url)) throw new Error("Catalogue storage returned an invalid public reference.");
        mediaId = "cmedia_" + randomUUID();
        await this.db("catalogue_media").insert({ id: mediaId, profile_id: profile.id, file_key: stored.id, public_url: stored.url });
        await updateProductsWorkflow(this.container).run({ input: { products: [{
          id: productId, images: [...product.images, { url: stored.url }], thumbnail: product.images[0]?.url ?? stored.url,
        }] } });
      } catch (error) {
        try {
          if (!stored.id.startsWith(PUBLIC_PREFIX)) throw new Error("Refusing private-file cleanup from catalogue.");
          const [pending] = mediaId ? await this.db<Media>("catalogue_media").where({ id: mediaId })
            .update({ removal_pending: true }).returning("*") : [];
          if (pending) await cleanupCatalogueMedia(this.container, pending);
          else await files.deleteFiles(stored.id);
        } catch (cleanup) { throw new AggregateError([error, cleanup], "Catalogue upload cleanup failed."); }
        throw error;
      }
      return this.detailFor(merchantId, productId);
    });
  }
  async removeImage(productId: string, imageId: string) {
    return this.write("MERCHANT_CATALOG_MANAGE", async (merchantId) => {
      const profile = await this.owned(merchantId, productId);
      const [product] = await nativeProducts(this.container, [productId]);
      if (!product) throw missing();
      const image = product.images.find((row) => row.id === imageId);
      if (!image) throw missing();
      const media = await this.db<Media>("catalogue_media").where({ profile_id: profile.id, public_url: image.url }).first();
      if (!media || !media.file_key.startsWith(PUBLIC_PREFIX)) throw missing();
      const remaining = product.images.filter((row) => row.id !== imageId);
      // Persist cleanup intent before detaching. A delete/storage failure remains retryable.
      await this.db("catalogue_media").where({ id: media.id }).update({ removal_pending: true, updated_at: new Date() });
      try {
        await updateProductsWorkflow(this.container).run({ input: { products: [{
          id: productId, images: remaining, thumbnail: remaining[0]?.url ?? null,
        }] } });
      } catch (error) {
        try { await this.db("catalogue_media").where({ id: media.id }).update({ removal_pending: false, updated_at: new Date() }); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Catalogue image detachment recovery failed."); }
        throw error;
      }
      // Native admin may reference public URLs independently. Retain referenced objects.
      await cleanupCatalogueMedia(this.container, { ...media, removal_pending: true });
      return this.detailFor(merchantId, productId);
    });
  }
}
