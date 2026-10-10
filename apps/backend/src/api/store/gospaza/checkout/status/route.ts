import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { CheckoutStatusService } from "../../../../../lib/checkout-status-service";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  try {
    res.json(await new CheckoutStatusService(req.scope, actor.actor_id).read(req.query));
  } catch (error) {
    if (error instanceof MedusaError && error.type === MedusaError.Types.NOT_FOUND) {
      res.status(404).json({ code: "CHECKOUT_UNAVAILABLE" }); return;
    }
    if (error instanceof MedusaError && error.type === MedusaError.Types.INVALID_DATA) {
      res.status(400).json({ code: "CHECKOUT_INPUT_INVALID" }); return;
    }
    res.status(503).json({ code: "CHECKOUT_REFRESH_REQUIRED" });
  }
}