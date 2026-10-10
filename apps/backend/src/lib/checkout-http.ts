import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { CheckoutService } from "./checkout-service";

export const checkoutHandler = (operation: "read" | "prepare" | "confirm" | "abandon") =>
  async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (actor?.actor_type !== "customer" || !actor.actor_id) {
      res.status(401).json({ message: "Sign in required." }); return;
    }
    if (operation !== "read" && Object.keys(req.query).length) {
      res.status(400).json({ message: "Unexpected checkout query parameters." }); return;
    }
    try {
      const service = new CheckoutService(req.scope, actor.actor_id);
      if (operation === "read") {
        res.json(await service.read(req.query, req.params.id)); return;
      }
      if (operation === "abandon") {
        res.json(await service.abandon(req.body)); return;
      }
      const result = await service.prepare(req.body, operation === "confirm");
      res.status(result.reconfirmation_required ? 409 : 200).json({
        ...result, ...(result.reconfirmation_required ? { code: "CHECKOUT_RECONFIRM" } : {}),
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && MedusaError.isMedusaError(error)) {
        if (error.type === MedusaError.Types.INVALID_DATA || error.type === MedusaError.Types.NOT_ALLOWED) {
          res.status(400).json({ code: "CHECKOUT_INPUT_INVALID", message: "Complete your address and refresh checkout." }); return;
        }
        if (error.type === MedusaError.Types.NOT_FOUND) {
          res.status(404).json({ code: "CHECKOUT_UNAVAILABLE", message: "Cart, address or checkout unavailable." }); return;
        }
        if (error.type === MedusaError.Types.CONFLICT) {
          const codes = ["CHECKOUT_FROZEN", "CHECKOUT_RECONFIRM", "CHECKOUT_CART_UNAVAILABLE",
            "DELIVERY_SELECTION_STALE", "DELIVERY_UNAVAILABLE"];
          res.status(409).json({ code: codes.includes(error.message) ? error.message : "CHECKOUT_REFRESH_REQUIRED",
            message: "Refresh checkout and delivery selection before continuing." }); return;
        }
      }
      // Never expose addresses, provider data or native workflow inputs in logs
      // or this DTO. Native writes may have committed: do not claim rollback.
      res.status(503).json({ code: "CHECKOUT_REFRESH_REQUIRED",
        message: "Checkout preparation could not be confirmed. Refresh before continuing." });
    }
  };

export function blockNativePayments(_req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(404).json({ message: "Native payment entry is unavailable." });
}
