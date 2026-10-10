import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { addressInput } from "./location-policy";

export const checkoutId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const checkoutReadInput = z.object({ cart_id: checkoutId }).strict();
export const checkoutPrepareInput = checkoutReadInput.extend({
  address_id: checkoutId,
  expected_reservation_revision: z.number().int().positive(),
}).strict();
export const checkoutConfirmInput = checkoutPrepareInput.extend({
  confirmed: z.literal(true),
  checkout_revision: revision,
}).strict();
export const checkoutAbandonInput = checkoutReadInput.extend({
  attempt_id: checkoutId, checkout_revision: revision, confirmed: z.literal(true),
}).strict();

export const checkoutAddress = addressInput.omit({ location: true });
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const checkoutSnapshot = z.object({
  customer_id: checkoutId,
  cart_id: checkoutId,
  cart_context_id: checkoutId,
  merchant_id: checkoutId,
  merchant_store_id: checkoutId,
  address_id: checkoutId,
  address: checkoutAddress,
  reservation_id: checkoutId,
  reservation_revision: z.number().int().positive(),
  configuration_revision: z.number().int().positive(),
  delivery_option_id: checkoutId,
  shipping_option_id: checkoutId,
  shipping_method_id: checkoutId,
  currency_code: z.literal("zar"),
  totals: z.object({
    total_minor: cents, subtotal_minor: cents, tax_total_minor: cents,
    discount_total_minor: cents, shipping_total_minor: cents,
  }).strict(),
  items: z.array(z.object({
    id: checkoutId, variant_id: checkoutId, quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    unit_price_minor: cents, total_minor: cents,
  }).strict()).min(1),
}).strict();
export type CheckoutSnapshot = z.infer<typeof checkoutSnapshot>;

// Schema projection fixes property order and rejects unsupported/missing values.
// A revision is a comparison token, never proof of ownership or authorization.
export function checkoutRevision(snapshot: CheckoutSnapshot): string {
  const canonical = checkoutSnapshot.parse(snapshot);
  canonical.items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
