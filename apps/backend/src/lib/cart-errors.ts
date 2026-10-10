import { MedusaError } from "@medusajs/framework/utils";

// Medusa 2.18 workflow errors are serialized records, not necessarily Error
// instances. Use its supported marker guard, after excluding null/primitives.
export function cartMutationFailure(error: unknown, nativeMutationStarted: boolean) {
  if (typeof error === "object" && error !== null && MedusaError.isMedusaError(error)) {
    if (error.code === MedusaError.Codes.INSUFFICIENT_INVENTORY) {
      return { status: 409, body: { code: "CART_INVENTORY_UNAVAILABLE", message: "The requested quantity is unavailable." } };
    }
    if (error.type === MedusaError.Types.INVALID_DATA || error.type === MedusaError.Types.NOT_ALLOWED) {
      return { status: 400, body: { message: "Invalid cart input or unavailable quantity." } };
    }
    if (error.type === MedusaError.Types.NOT_FOUND) {
      return { status: 404, body: { message: "Cart or product unavailable." } };
    }
    if (error.type === MedusaError.Types.CONFLICT) {
      const code = error.message === "CART_MERCHANT_CONFLICT" ? "CART_MERCHANT_CONFLICT"
        : error.message === "CHECKOUT_FROZEN" ? "CHECKOUT_FROZEN" : "CART_STATE_CONFLICT";
      return { status: 409, body: { code, message: code === "CART_MERCHANT_CONFLICT"
        ? "Your cart belongs to another store. Keep it or explicitly confirm a store switch."
        : "The cart cannot be changed in its current state." } };
    }
  }
  // Do not unwrap aggregate/cause errors: compensation failures must not be
  // mistaken for the original domain rejection.
  return nativeMutationStarted
    ? { status: 503, body: { code: "CART_MUTATION_UNCERTAIN", message: "Refresh your cart before making another change." } }
    : { status: 503, body: { code: "CART_UNAVAILABLE", message: "Cart validation is unavailable." } };
}
