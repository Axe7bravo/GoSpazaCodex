import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { cartMutationFailure } from "./cart-errors";
import { CartFoundationService } from "./cart-service";
import { cartHintInput } from "../modules/marketplace/cart-policy";
import { cartLineId } from "../modules/marketplace/cart-mutation-policy";

// Block every verb/subroute, including transfer, completion and line-item writes.
export function blockNativeCarts(_req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(404).json({ message: "Use the GoSpaza cart API." });
}
export async function restoreCart(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  const parsed = cartHintInput.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: "Invalid cart reference." }); return; }
  try {
    res.json(await new CartFoundationService(req.scope, actor.actor_id).restore(parsed.data.cart_id));
  } catch (error) {
    if (error instanceof MedusaError && error.type === MedusaError.Types.NOT_FOUND) {
      res.status(404).json({ message: "Cart unavailable." });
    } else {
      res.status(503).json({ message: "Cart is unavailable. Please try again." });
    }
  }
}

type CartMutation = (service: CartFoundationService, req: MedusaRequest) => Promise<string>;

function mutation(action: CartMutation) {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (actor?.actor_type !== "customer" || !actor.actor_id) {
      res.status(401).json({ message: "Sign in required." });
      return;
    }
    if (Object.keys(req.query).length) {
      res.status(400).json({ message: "Unexpected cart query parameters." });
      return;
    }
    let service: CartFoundationService | undefined;
    try {
      service = new CartFoundationService(req.scope, actor.actor_id);
      const cartId = await action(service, req);
      res.json({ cart_id: cartId });
    } catch (error) {
      const failure = cartMutationFailure(error, service?.nativeMutationStarted ?? false);
      res.status(failure.status).json(failure.body);
    }
  };
}

function lineItemId(req: MedusaRequest): string {
  const parsed = cartLineId.safeParse(req.params.lineItemId);
  if (!parsed.success) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid line-item reference.");
  }
  return parsed.data;
}

export const addCartItem = mutation((service, req) => service.add(req.body));
export const updateCartItem = mutation((service, req) => service.updateItem(lineItemId(req), req.body));
export const removeCartItem = mutation((service, req) => service.removeItem(lineItemId(req), req.body));
export const switchCartStore = mutation((service, req) => service.switchStore(req.body));
