import { releaseContextHold } from "../modules/marketplace/delivery-reservation-repository";
import { createCartWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ICartModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { bindCart, supersedeCart } from "../modules/marketplace/cart-context-repository";
import type { CartContext } from "../modules/marketplace/cart-context-repository";

interface SwitchInput {
  oldCartId: string;
  customerId: string;
  merchantId: string;
  storeId: string;
  channelId: string;
  regionId: string;
  variantId: string;
  quantity: number;
}

// Internal orchestration only, called while holding the customer advisory lock.
// Native creation owns its compensation. Marketplace publication is the final
// commit point: never place fallible business work after that commit.
export async function switchMarketplaceCart(container: MedusaContainer, input: SwitchInput): Promise<string> {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const { result: candidate } = await createCartWorkflow(container).run({
    input: {
      customer_id: input.customerId,
      sales_channel_id: input.channelId,
      region_id: input.regionId,
      currency_code: "zar",
      items: [{ variant_id: input.variantId, quantity: input.quantity }],
    },
  });
  try {
    await db.transaction(async (trx) => {
      const previous = await trx<CartContext>("cart_marketplace_context")
        .where({ medusa_cart_id: input.oldCartId }).whereNull("superseded_at").whereNull("deleted_at").first();
      if (!previous) throw new Error("Cart is no longer current.");
      await releaseContextHold(trx, previous.id, "STORE_SWITCHED");
      await bindCart(trx, {
        cartId: candidate.id, merchantId: input.merchantId, storeId: input.storeId,
      });
      await supersedeCart(trx, input.oldCartId);
    });
  } catch (error) {
    // A lost commit acknowledgement must not cause deletion of a published
    // replacement. Re-read authority, never retry native creation.
    let contexts: CartContext[];
    try {
      contexts = await db<CartContext>("cart_marketplace_context")
        .whereIn("medusa_cart_id", [input.oldCartId, candidate.id]).whereNull("deleted_at");
    } catch (readError) {
      throw new AggregateError([error, readError], "Cart switch requires recovery; publication could not be determined.");
    }
    const replacement = contexts.find((context) => context.medusa_cart_id === candidate.id);
    const previous = contexts.find((context) => context.medusa_cart_id === input.oldCartId);
    if (replacement && !replacement.superseded_at && previous?.superseded_at
      && replacement.merchant_id === input.merchantId && replacement.merchant_store_id === input.storeId) {
      return candidate.id;
    }
    if (replacement || !previous || previous.superseded_at) {
      throw new Error("Cart switch requires recovery; unexpected binding state.", { cause: error });
    }
    // Transaction rolled back: the previous cart is still current. Delete only
    // this unpublished native candidate through the supported Cart Module API.
    try {
      await carts.deleteCarts([candidate.id]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Cart switch failed and candidate cleanup requires recovery.");
    }
    throw error;
  }
  return candidate.id;
}
