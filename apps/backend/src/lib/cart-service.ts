import { detachHistoricalCollection } from "./checkout-payment-links";
import { assertCheckoutMutable } from "../modules/marketplace/checkout-repository";
import { releaseContextHold } from "../modules/marketplace/delivery-reservation-repository";
import { addToCartWorkflow, updateLineItemInCartWorkflow, deleteLineItemsWorkflow } from "@medusajs/medusa/core-flows";
import { switchMarketplaceCart } from "../workflows/switch-marketplace-cart";
import { addCartInput, updateCartItemInput, removeCartItemInput, switchCartInput, cartLineId } from "../modules/marketplace/cart-mutation-policy";
import type { CartFoundation } from "@gospaza/contracts";
import type { CartDTO, ICartModuleService, ICustomerModuleService, IProductModuleService,
  IRegionModuleService, IStoreModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { BigNumber, ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { cartOperation } from "./cart-lock";
import { commerceContext } from "./commerce";
import { DiscoveryService } from "./discovery-service";
import type { DiscoveryInput } from "./discovery-service";
import { StorefrontService } from "./storefront-service";
import { createMarketplaceCartWorkflow } from "../workflows/create-marketplace-cart";
import { assertCartRegion, cartHintInput } from "../modules/marketplace/cart-policy";
import type { CartContext } from "../modules/marketplace/cart-context-repository";
import type MarketplaceService from "../modules/marketplace/service";
import { catalogueReadData, nativeProducts, publicProductImages } from "./catalogue-native";
import { minorPrice } from "../modules/marketplace/catalogue-policy";

type Profile = Awaited<ReturnType<MarketplaceService["listProductMarketplaceProfiles"]>>[number];
const CART_READ_FIELDS = [
  "id", "customer_id", "completed_at", "currency_code", "region_id", "sales_channel_id", "item_subtotal",
] as const;
const unavailable = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Cart unavailable.");
const inconsistent = () => new MedusaError(MedusaError.Types.CONFLICT, "Cart requires recovery.");
const empty = (): CartFoundation => ({ cart: null, state: "empty", eligibility: "pending" });

export async function cartRegion(container: MedusaContainer) {
  const stores = await container.resolve<IStoreModuleService>(Modules.STORE).listStores({}, { take: 2 });
  const store = stores[0];
  if (stores.length !== 1 || !store?.default_region_id) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Configure one native Store with a default ZA/ZAR region.");
  }
  const region = await container.resolve<IRegionModuleService>(Modules.REGION)
    .retrieveRegion(store.default_region_id, { relations: ["countries"] });
  assertCartRegion(region);
  return region;
}

export class CartFoundationService {
  private db: Knex;
  private carts: ICartModuleService;
  private mutationStarted = false;

  // HTTP creates one service per request; this only classifies unknown errors.
  get nativeMutationStarted(): boolean {
    return this.mutationStarted;
  }
  constructor(private container: MedusaContainer, private customerId: string) {
    if (!customerId) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.carts = container.resolve<ICartModuleService>(Modules.CART);
  }

  // Native customer_id is the sole ownership authority. Orphan native carts
  // without published contexts are never adopted by current-cart discovery.
  private async current() {
    const carts = await this.carts.listCarts({ customer_id: this.customerId }, {
      relations: ["items"], select: [...CART_READ_FIELDS], take: null,
    });
    const contexts = carts.length ? await this.db<CartContext>("cart_marketplace_context")
      .whereIn("medusa_cart_id", carts.map((cart) => cart.id))
      .whereNull("superseded_at").whereNull("deleted_at") : [];
    // Native completion can mark a cart completed before GoSpaza has a verified
    // terminal receipt. Do not interpret that crash window as an empty cart.
    const completedIds = carts.filter((cart) => cart.completed_at).map((cart) => cart.id);
    if (completedIds.length && await this.db("checkout_attempt").whereIn("medusa_cart_id", completedIds)
      .whereNull("closed_at").first()) {
      throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_FROZEN");
    }
    const candidates = carts.filter((cart) => !cart.completed_at && contexts.some((context) => context.medusa_cart_id === cart.id));
    if (candidates.length > 1) throw inconsistent();
    const cart = candidates[0];
    return cart ? { cart, context: contexts.find((context) => context.medusa_cart_id === cart.id)! } : null;
  }

  // Domain contract for scheduling. The callback runs under the same customer
  // lock as native cart mutations; callers must not acquire that lock again.
  async withCurrent<T>(hint: string | undefined, work: (current: {
    cart: CartDTO; context: CartContext; valid: boolean;
  }) => Promise<T>): Promise<T> {
    return cartOperation(this.container, this.customerId, async () => {
      const current = hint ? await this.requireCurrent(hint) : await this.current();
      if (!current) throw unavailable();
      const restored = await this.restoration(current.cart, current.context);
      return work({ ...current, valid: restored.state === "current" });
    });
  }

  async restore(hint?: string): Promise<CartFoundation> {
    const parsed = cartHintInput.safeParse(hint === undefined ? {} : { cart_id: hint });
    if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid cart reference.");
    return cartOperation(this.container, this.customerId, async () => {
      if (hint) {
        const [cart] = await this.carts.listCarts({ id: hint, customer_id: this.customerId }, {
          relations: ["items"], select: [...CART_READ_FIELDS], take: 1,
        });
        if (!cart) throw unavailable(); // Same response for missing and foreign carts.
        const context = await this.db<CartContext>("cart_marketplace_context")
          .where({ medusa_cart_id: cart.id }).whereNull("deleted_at").first();
        if (context?.superseded_at) return { cart: null, state: "superseded", eligibility: "unavailable" };
        if (!context || cart.completed_at) return { cart: null, state: "stale", eligibility: "unavailable" };
        const current = await this.current();
        if (!current || current.cart.id !== cart.id) throw inconsistent();
        return this.restoration(cart, context);
      }
      const current = await this.current();
      return current ? this.restoration(current.cart, current.context) : empty();
    });
  }

  private async restoration(cart: CartDTO, context: CartContext): Promise<CartFoundation> {
    const store = await this.db<{ id: string; merchant_id: string; name: string; active: boolean }>("merchant_store")
      .where({ id: context.merchant_store_id, merchant_id: context.merchant_id }).whereNull("deleted_at").first();
    const merchant = await this.db<{ status: string; medusa_sales_channel_id: string | null }>("merchant")
      .where({ id: context.merchant_id }).whereNull("deleted_at").first();
    if (!store || !merchant) return { cart: null, state: "stale", eligibility: "unavailable" };
    const items = cart.items ?? [];
    const productIds = [...new Set(items.flatMap((item) => item.product_id ? [item.product_id] : []))];
    const products = await nativeProducts(this.container, productIds);
    const media = (await catalogueReadData(this.container, products, [])).media;
    const images = new Map(products.map((product) =>
      [product.id, publicProductImages(product, media)[0]?.url ?? null]));
    const quantity = (value: unknown) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw inconsistent();
      return number;
    };
    const money = (value: unknown) => {
      if (typeof value !== "string" && typeof value !== "number" && !(value instanceof BigNumber)) throw inconsistent();
      try {
        return minorPrice(value);
      } catch {
        throw inconsistent();
      }
    };
    const dto = {
      id: cart.id,
      store: { id: store.id, name: store.name },
      items: items.map((item) => {
        if (!item.product_id || !item.variant_id) throw inconsistent();
        return {
          id: item.id,
          product_id: item.product_id,
          variant_id: item.variant_id,
          product_title: item.product_title ?? item.title,
          variant_title: item.variant_title ?? item.subtitle ?? "Default",
          image_url: images.get(item.product_id) ?? null,
          unit_price_minor: money(item.unit_price),
          quantity: quantity(item.quantity),
          subtotal_minor: money(item.subtotal),
        };
      }),
      currency_code: "zar" as const,
      subtotal_minor: money(cart.item_subtotal),
      item_count: items.reduce((sum, item) => sum + quantity(item.quantity), 0),
    };
    let valid = store.active && merchant.status === "ACTIVE"
      && cart.currency_code === "zar" && !!cart.region_id
      && !!merchant.medusa_sales_channel_id && cart.sales_channel_id === merchant.medusa_sales_channel_id;
    const variantIds = items.flatMap((item) => item.variant_id ? [item.variant_id] : []);
    const variants = variantIds.length ? await this.container.resolve<IProductModuleService>(Modules.PRODUCT)
      .listProductVariants({ id: variantIds }, { select: ["id", "product_id"], take: null }) : [];
    const variantProductIds = variants.flatMap((variant) => variant.product_id ? [variant.product_id] : []);
    const profiles = variantProductIds.length ? await this.db<Profile>("product_marketplace_profile")
      .whereIn("medusa_product_id", variantProductIds).where({ merchant_id: context.merchant_id }).whereNull("deleted_at") : [];
    valid = valid && items.every((item) => {
      const variant = variants.find((candidate) => candidate.id === item.variant_id);
      return !!variant?.product_id && profiles.some((profile) => profile.medusa_product_id === variant.product_id);
    });
    if (valid) {
      try { await commerceContext(this.container, context.merchant_id); }
      catch (error) {
        if (!(error instanceof MedusaError) || error.type !== MedusaError.Types.CONFLICT) throw error;
        valid = false;
      }
    }
    // Location is deliberately not a prerequisite to restore/decrease/remove.
    // Add/increase separately revalidate current M6 eligibility.
    return { cart: dto, state: valid ? "current" : "stale", eligibility: valid ? "pending" : "unavailable" };
  }

  private async target(variantId: string, location: DiscoveryInput) {
    const [variant] = await this.container.resolve<IProductModuleService>(Modules.PRODUCT)
      .listProductVariants({ id: variantId }, { select: ["id", "product_id"], take: 1 });
    if (!variant?.product_id) throw unavailable();
    const profile = await this.db<Profile>("product_marketplace_profile")
      .where({ medusa_product_id: variant.product_id }).whereNull("deleted_at").first();
    if (!profile) throw unavailable();
    const store = (await new DiscoveryService(this.container, this.customerId).eligible(location))
      .find((candidate) => candidate.merchant_id === profile.merchant_id);
    if (!store) throw unavailable();
    const { product } = await new StorefrontService(this.container, this.customerId).product(location, variant.product_id);
    if (!product.variants.some((candidate) => candidate.id === variantId)) throw unavailable();
    return { merchantId: profile.merchant_id, storeId: store.id };
  }

  private assertBinding(context: CartContext, target: { merchantId: string; storeId: string }) {
    if (context.merchant_id !== target.merchantId || context.merchant_store_id !== target.storeId) {
      throw new MedusaError(MedusaError.Types.CONFLICT, "CART_MERCHANT_CONFLICT");
    }
  }

  private async requireCurrent(cartId: string) {
    const current = await this.current();
    // Includes foreign, superseded, completed and unbound native cart IDs.
    if (!current || current.cart.id !== cartId) throw unavailable();
    return current;
  }

  private async createInput(target: { merchantId: string; storeId: string }, variantId: string, quantity: number) {
    await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(this.customerId);
    const region = await cartRegion(this.container);
    const topology = await commerceContext(this.container, target.merchantId);
    if (topology.store.id !== target.storeId) throw inconsistent();
    return {
      customerId: this.customerId, ...target, channelId: topology.channelId,
      regionId: region.id, variantId, quantity,
    };
  }

  // Keep M8-B get-or-create semantics: a repeated initialization never adds.
  async ensureFirstCart(variantId: string, quantity: number, location: DiscoveryInput): Promise<string> {
    const input = addCartInput.safeParse({ variant_id: variantId, quantity, location });
    if (!input.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid cart input.");
    return cartOperation(this.container, this.customerId, async () => {
      const target = await this.target(variantId, input.data.location);
      const current = await this.current();
      if (current) {
        this.assertBinding(current.context, target);
        if ((await this.restoration(current.cart, current.context)).state !== "current") throw inconsistent();
        return current.cart.id;
      }
      const creation = await this.createInput(target, variantId, quantity);
      this.mutationStarted = true;
      const { result } = await createMarketplaceCartWorkflow(this.container).run({ input: creation });
      return result;
    });
  }

  async add(value: unknown): Promise<string> {
    const parsed = addCartInput.safeParse(value);
    if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid cart input.");
    const input = parsed.data;
    return cartOperation(this.container, this.customerId, async () => {
      const current = input.cart_id ? await this.requireCurrent(input.cart_id) : await this.current();
      const target = await this.target(input.variant_id, input.location);
      if (!current) {
        const creation = await this.createInput(target, input.variant_id, input.quantity);
        this.mutationStarted = true;
        const { result } = await createMarketplaceCartWorkflow(this.container).run({ input: creation });
        return result;
      }
      await assertCheckoutMutable(this.db, current.context.id);
      await detachHistoricalCollection(this.container, current.cart.id);
      this.assertBinding(current.context, target);
      if ((await this.restoration(current.cart, current.context)).state !== "current") throw inconsistent();
      this.mutationStarted = true;
      await addToCartWorkflow(this.container).run({
        input: { cart_id: current.cart.id, items: [{ variant_id: input.variant_id, quantity: input.quantity }] },
      });
      return current.cart.id;
    });
  }

  async updateItem(lineId: string, value: unknown): Promise<string> {
    const parsed = updateCartItemInput.safeParse(value);
    if (!parsed.success || !cartLineId.safeParse(lineId).success) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid cart input.");
    }
    const input = parsed.data;
    return cartOperation(this.container, this.customerId, async () => {
      const current = await this.requireCurrent(input.cart_id);
      const item = current.cart.items?.find((line) => line.id === lineId);
      if (!item) throw unavailable();
      await assertCheckoutMutable(this.db, current.context.id);
      await detachHistoricalCollection(this.container, current.cart.id);
      const previous = Number(item.quantity);
      if (input.quantity > previous) {
        if (!input.location) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose a current delivery location.");
        if (!item.variant_id) throw unavailable();
        this.assertBinding(current.context, await this.target(item.variant_id, input.location));
        if ((await this.restoration(current.cart, current.context)).state !== "current") throw inconsistent();
      }
      if (input.quantity !== previous) {
        // A decrease deliberately skips discovery/restoration eligibility gates.
        // Native pricing and inventory rules still belong to Medusa.
        this.mutationStarted = true;
        await updateLineItemInCartWorkflow(this.container).run({
          input: { cart_id: current.cart.id, item_id: lineId, update: { quantity: input.quantity } },
        });
      }
      return current.cart.id;
    });
  }

  async removeItem(lineId: string, value: unknown): Promise<string> {
    const parsed = removeCartItemInput.safeParse(value);
    if (!parsed.success || !cartLineId.safeParse(lineId).success) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid cart input.");
    }
    return cartOperation(this.container, this.customerId, async () => {
      const current = await this.requireCurrent(parsed.data.cart_id);
      if (!current.cart.items?.some((line) => line.id === lineId)) throw unavailable();
      await assertCheckoutMutable(this.db, current.context.id);
      await detachHistoricalCollection(this.container, current.cart.id);
      this.mutationStarted = true;
      await deleteLineItemsWorkflow(this.container).run({
        input: { cart_id: current.cart.id, ids: [lineId] },
      });
      // Native deletion has completed. A failed scheduling cleanup surfaces as
      // uncertain through the existing M8 boundary; never replay native deletion.
      const updated = await this.carts.retrieveCart(current.cart.id, { relations: ["items"] });
      if (!updated.items?.length) {
        await this.db.transaction((trx) => releaseContextHold(trx, current.context.id, "CART_EMPTY"));
      }
      // Removing the final item preserves the immutable merchant binding.
      return current.cart.id;
    });
  }

  async switchStore(value: unknown): Promise<string> {
    const parsed = switchCartInput.safeParse(value);
    if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Confirm the store switch and choose a delivery location.");
    const input = parsed.data;
    return cartOperation(this.container, this.customerId, async () => {
      const current = await this.requireCurrent(input.cart_id);
      await assertCheckoutMutable(this.db, current.context.id);
      await detachHistoricalCollection(this.container, current.cart.id);
      const target = await this.target(input.variant_id, input.location);
      if (current.context.merchant_id === target.merchantId && current.context.merchant_store_id === target.storeId) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "The cart already belongs to this store.");
      }
      const creation = await this.createInput(target, input.variant_id, input.quantity);
      this.mutationStarted = true;
      return switchMarketplaceCart(this.container, {
        ...creation,
        oldCartId: current.cart.id,
      });
    });
  }
}
