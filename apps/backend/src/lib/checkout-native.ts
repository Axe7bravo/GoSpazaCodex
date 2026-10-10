import type { CartDTO, ICartModuleService, MedusaContainer } from "@medusajs/framework/types";
import { BigNumber, MedusaError, Modules } from "@medusajs/framework/utils";
import { addShippingMethodToCartWorkflow, refreshCartItemsWorkflow, updateCartWorkflow } from "@medusajs/medusa/core-flows";
import { detachHistoricalCollection } from "./checkout-payment-links";
import { DiscoveryService } from "./discovery-service";
import { checkoutAddress, checkoutSnapshot, checkoutRevision } from "../modules/marketplace/checkout-policy";
import { minorPrice } from "../modules/marketplace/catalogue-policy";
import type { CheckoutSnapshot } from "../modules/marketplace/checkout-policy";

const unavailable = () => new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_NATIVE_STATE");
export function checkoutMoney(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string" && !(value instanceof BigNumber)) throw unavailable();
  try { return minorPrice(value); } catch { throw unavailable(); }
}

export async function ownedCheckoutAddress(container: MedusaContainer, customerId: string, addressId: string) {
  const owned = await new DiscoveryService(container, customerId).ownedAddress(addressId);
  const parsed = checkoutAddress.safeParse({
    first_name: owned.first_name, last_name: owned.last_name, address_1: owned.address_1,
    address_2: owned.address_2 ?? "", city: owned.city, province: owned.province,
    postal_code: owned.postal_code, country_code: owned.country_code, phone: owned.phone ?? "",
  });
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Complete your delivery address.");
  return { id: owned.id, address: parsed.data };
}

export function nativeCheckoutTotals(cart: CartDTO) {
  return {
    total_minor: checkoutMoney(cart.total), subtotal_minor: checkoutMoney(cart.subtotal),
    tax_total_minor: checkoutMoney(cart.tax_total), discount_total_minor: checkoutMoney(cart.discount_total),
    shipping_total_minor: checkoutMoney(cart.shipping_total),
  };
}
export function nativeCheckoutItems(cart: CartDTO) {
  return cart.items?.map((item) => ({
    id: item.id, variant_id: item.variant_id, quantity: Number(item.quantity),
    unit_price_minor: checkoutMoney(item.unit_price), total_minor: checkoutMoney(item.total),
  }));
}

// Never refresh a live collection or its historical sessions. A proven closed
// operation may be unlinked, retaining all historical native payment resources.
export async function requireUnpaidCart(container: MedusaContainer, cartId: string): Promise<void> {
  await detachHistoricalCollection(container, cartId);
}

export async function refreshCheckoutCart(
  container: MedusaContainer, cartId: string, address: CheckoutSnapshot["address"], optionId: string,
): Promise<CartDTO> {
  await requireUnpaidCart(container, cartId);
  await updateCartWorkflow(container).run({ input: { id: cartId, shipping_address: address } });
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const current = await carts.retrieveCart(cartId, { relations: ["shipping_methods"] });
  // Reconcile authoritative native state before any repeated attachment. Never
  // blindly replay a shipping create after an uncertain prior response.
  if (current.shipping_methods?.length !== 1 || current.shipping_methods[0]?.shipping_option_id !== optionId) {
    await addShippingMethodToCartWorkflow(container).run({
      input: { cart_id: cartId, options: [{ id: optionId }] },
    });
  }
  await refreshCartItemsWorkflow(container).run({
    input: { cart_id: cartId, force_refresh: true, force_tax_calculation: true },
  });
  // The workflow result is not its final refreshed totals. Read decorated native
  // totals explicitly, including the relations required by Medusa 2.18.
  const cart = await carts.retrieveCart(cartId, {
    select: ["id", "customer_id", "currency_code", "completed_at", "total", "subtotal",
      "tax_total", "discount_total", "shipping_total"],
    relations: ["items", "items.tax_lines", "items.adjustments", "shipping_methods",
      "shipping_methods.tax_lines", "shipping_methods.adjustments"],
  });
  if (cart.completed_at || cart.currency_code !== "zar" || !cart.items?.length
    || cart.shipping_methods?.length !== 1 || cart.shipping_methods[0]?.shipping_option_id !== optionId) throw unavailable();
  return cart;
}

export async function assertNativeCheckoutSnapshot(container: MedusaContainer, snapshot: CheckoutSnapshot) {
  const native = await container.resolve<ICartModuleService>(Modules.CART).retrieveCart(snapshot.cart_id, {
    select: ["id", "customer_id", "currency_code", "completed_at", "total", "subtotal",
      "tax_total", "discount_total", "shipping_total"],
    relations: ["items", "items.tax_lines", "items.adjustments", "shipping_methods",
      "shipping_methods.tax_lines", "shipping_methods.adjustments", "shipping_address"],
  });
  const method = native.shipping_methods?.[0];
  const address = native.shipping_address;
  if (native.completed_at || native.customer_id !== snapshot.customer_id || native.currency_code !== "zar"
    || native.shipping_methods?.length !== 1 || !method || !address) throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_RECONFIRM");
  const current = checkoutSnapshot.parse({ ...snapshot,
    customer_id: native.customer_id, currency_code: native.currency_code,
    shipping_method_id: method.id, shipping_option_id: method.shipping_option_id,
    totals: nativeCheckoutTotals(native), items: nativeCheckoutItems(native),
    address: {
      first_name: address.first_name, last_name: address.last_name, address_1: address.address_1,
      address_2: address.address_2 ?? "", city: address.city, province: address.province,
      postal_code: address.postal_code, country_code: address.country_code, phone: address.phone ?? "",
    },
  });
  if (checkoutRevision(current) !== checkoutRevision(snapshot)) throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_RECONFIRM");
}

