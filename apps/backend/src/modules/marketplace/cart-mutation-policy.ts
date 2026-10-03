import { z } from "@medusajs/framework/zod";
import { discoveryInput } from "../../lib/discovery-service";

const cartId = z.string().regex(/^cart_[a-zA-Z0-9_-]{1,100}$/);
const variantId = z.string().regex(/^variant_[a-zA-Z0-9_-]{1,100}$/);
export const cartLineId = z.string().regex(/^cali_[a-zA-Z0-9_-]{1,100}$/);
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Location is an M6/M7 location selection, never a trusted eligibility or
// stock-location ID. DiscoveryService resolves owned addresses server-side.
export const addCartInput = z.object({
  cart_id: cartId.optional(),
  variant_id: variantId,
  quantity,
  location: discoveryInput,
}).strict();

export const updateCartItemInput = z.object({
  cart_id: cartId,
  quantity,
  location: discoveryInput.optional(),
}).strict();

export const removeCartItemInput = z.object({ cart_id: cartId }).strict();

export const switchCartInput = z.object({
  cart_id: cartId,
  variant_id: variantId,
  quantity,
  location: discoveryInput,
  confirm: z.literal(true),
}).strict();
