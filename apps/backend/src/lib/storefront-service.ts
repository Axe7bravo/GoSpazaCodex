import type { MedusaContainer, IProductModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils";
import { DiscoveryService, publicStore, storefrontMissing } from "./discovery-service";
import type { DiscoveryInput } from "./discovery-service";
import { catalogueReadData, nativeProducts } from "./catalogue-native";
import { storefrontProduct } from "./storefront-product";
import type { CommerceReference } from "./commerce";
import type MarketplaceService from "../modules/marketplace/service";

type ProductMarketplaceProfile = Awaited<ReturnType<MarketplaceService["listProductMarketplaceProfiles"]>>[number];
export class StorefrontService {
  private db: Knex;
  private discovery: DiscoveryService;
  constructor(private container: MedusaContainer, customerId: string) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.discovery = new DiscoveryService(container, customerId);
  }
  private async products(stores: CommerceReference[], filters: DiscoveryInput, productId?: string) {
    if (!stores.length) return { products: [], count: 0, limit: filters.limit, offset: filters.offset };
    const profileQuery = this.db<ProductMarketplaceProfile, ProductMarketplaceProfile[]>("product_marketplace_profile")
      .whereIn("merchant_id", stores.map((store) => store.merchant_id)).whereNull("deleted_at");
    if (productId) profileQuery.where({ medusa_product_id: productId });
    const profiles: ProductMarketplaceProfile[] = await profileQuery;
    if (!profiles.length) return { products: [], count: 0, limit: filters.limit, offset: filters.offset };
    const query = this.container.resolve<{
      graph(input: { entity: string; fields: string[]; filters: Record<string, unknown>; pagination: { take: null } }):
        Promise<{ data: { product_id: string; sales_channel_id: string }[] }>;
    }>(ContainerRegistrationKeys.QUERY);
    const links = await query.graph({
      entity: "product_sales_channel", fields: ["product_id", "sales_channel_id"],
      filters: { product_id: profiles.map((profile) => profile.medusa_product_id) }, pagination: { take: null },
    });
    const owners = new Map(stores.map((store) => [store.merchant_id, store]));
    const owned = new Map<string, ProductMarketplaceProfile>(profiles.filter((profile) => links.data.some((link) =>
      link.product_id === profile.medusa_product_id && link.sales_channel_id === owners.get(profile.merchant_id)?.medusa_sales_channel_id))
      .map((profile) => [profile.medusa_product_id, profile]));
    if (!owned.size) return { products: [], count: 0, limit: filters.limit, offset: filters.offset };
    // Native Product search is PostgreSQL-backed. Store-name matching is also scoped in SQL.
    const matchingStores = filters.q ? await this.db<{ id: string }>("merchant_store")
      .whereIn("id", stores.map((store) => store.id))
      .whereILike("name", "%" + filters.q.replace(/[\\%_]/g, "\\$&") + "%").select("id") : [];
    const names = new Set(matchingStores.map((store) => store.id));
    const storeProductIds: string[] = [...owned.values()].filter((profile) => names.has(owners.get(profile.merchant_id)!.id))
      .map((profile) => profile.medusa_product_id);
    const products = this.container.resolve<IProductModuleService>(Modules.PRODUCT);
    const textMatches = filters.q ? await products.listProducts({
      id: [...owned.keys()], status: ProductStatus.PUBLISHED, q: filters.q,
    }, { select: ["id"], take: null }) : [];
    const ids = filters.q ? [...new Set([...textMatches.map((row) => row.id), ...storeProductIds])] : [...owned.keys()];
    const candidates = ids.length ? await products.listProducts({ id: ids, status: ProductStatus.PUBLISHED },
      { select: ["id"], take: null, order: { title: "ASC", id: "ASC" } }) : [];
    // Bound native graph/inventory batches; count only usable products before paging.
    const page: NonNullable<ReturnType<typeof storefrontProduct>>[] = [];
    let count = 0;
    for (let index = 0; index < candidates.length; index += 100) {
      const batch = candidates.slice(index, index + 100);
      const native = await nativeProducts(this.container, batch.map((product) => product.id));
      const data = await catalogueReadData(this.container, native, stores.map((store) => store.medusa_stock_location_id!));
      const byId = new Map(native.map((product) => [product.id, product]));
      for (const candidate of batch) {
        const product = byId.get(candidate.id), profile = owned.get(candidate.id)!;
        if (!product) continue;
        const dto = storefrontProduct(product, owners.get(profile.merchant_id)!, profile.requires_age_verification, data);
        if (!dto) continue;
        if (count >= filters.offset && page.length < filters.limit) page.push(dto);
        count++;
      }
    }
    return { products: page, count, limit: filters.limit, offset: filters.offset };
  }
  async catalogue(filters: DiscoveryInput, storeId: string) {
    const store = (await this.discovery.eligible(filters)).find((row) => row.id === storeId);
    if (!store) throw storefrontMissing();
    return { store: publicStore(store), ...await this.products([store], filters) };
  }
  async product(filters: DiscoveryInput, id: string) {
    const stores = await this.discovery.eligible(filters);
    const result = await this.products(stores, { ...filters, q: "", offset: 0, limit: 1 }, id);
    const product = result.products[0];
    if (!product) throw storefrontMissing();
    return { product };
  }
  async search(filters: DiscoveryInput) {
    const stores = await this.discovery.eligible(filters);
    const matched = filters.q ? await this.db<{ id: string }>("merchant_store")
      .whereIn("id", stores.map((store) => store.id))
      .whereILike("name", "%" + filters.q.replace(/[\\%_]/g, "\\$&") + "%").select("id") : stores;
    const ids = new Set(matched.map((store) => store.id));
    const matches = stores.filter((store) => ids.has(store.id));
    return {
      eligible_store_count: stores.length,
      stores: matches.slice(filters.offset, filters.offset + filters.limit).map(publicStore),
      store_count: matches.length,
      ...await this.products(stores, filters),
    };
  }
}
