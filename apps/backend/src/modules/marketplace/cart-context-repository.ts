import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { MedusaError } from "@medusajs/framework/utils";
import type MarketplaceService from "./service";

export type CartContext = Awaited<ReturnType<MarketplaceService["listCartMarketplaceContexts"]>>[number];
export interface CartBinding { cartId: string; merchantId: string; storeId: string }

// Call inside the customer cart-operation boundary. No native table writes.
export async function bindCart(db: Knex | Knex.Transaction, binding: CartBinding) {
  const id = "cmctx_" + randomUUID();
  await db("cart_marketplace_context").insert({
    id, medusa_cart_id: binding.cartId,
    merchant_id: binding.merchantId, merchant_store_id: binding.storeId,
  });
  return id;
}

// M8-C can compose this with binding the replacement in one Marketplace
// transaction. The database forbids changing the binding or undoing supersession.
export async function supersedeCart(db: Knex.Transaction, cartId: string) {
  const changed = await db("cart_marketplace_context")
    .where({ medusa_cart_id: cartId }).whereNull("superseded_at").whereNull("deleted_at")
    .update({ superseded_at: new Date(), updated_at: new Date() });
  if (changed !== 1) throw new MedusaError(MedusaError.Types.CONFLICT, "Cart is no longer current.");
}
