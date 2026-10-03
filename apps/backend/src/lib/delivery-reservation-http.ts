import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { DeliveryReservationService } from "./delivery-reservation-service";

type Operation = "availability" | "select" | "release" | "restore";
export const deliveryHandler = (operation: Operation) => async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  if (operation !== "restore" && Object.keys(req.query).length) {
    res.status(400).json({ message: "Unexpected delivery query parameters." }); return;
  }
  try {
    const service = new DeliveryReservationService(req.scope, actor.actor_id);
    res.json(await service[operation](operation === "restore" ? req.query : req.body));
  } catch (error) {
    if (error instanceof MedusaError) {
      if (error.type === MedusaError.Types.INVALID_DATA) {
        res.status(400).json({ code: "DELIVERY_INPUT_INVALID", message: "Invalid delivery selection." }); return;
      }
      if (error.type === MedusaError.Types.NOT_FOUND) {
        res.status(404).json({ code: "DELIVERY_UNAVAILABLE", message: "Cart or delivery selection unavailable." }); return;
      }
      if (error.type === MedusaError.Types.CONFLICT) {
        const codes = ["DELIVERY_SELECTION_STALE", "DELIVERY_SLOT_UNAVAILABLE", "DELIVERY_UNAVAILABLE"];
        res.status(409).json({ code: codes.includes(error.message) ? error.message : "DELIVERY_CONFIGURATION_STALE",
          message: "Refresh delivery availability before selecting again." }); return;
      }
    }
    req.scope.resolve<{ error(message: string, error?: Error): void }>(ContainerRegistrationKeys.LOGGER)
      .error("Delivery reservation operation failed.", error instanceof Error ? error : undefined);
    // Commit acknowledgement may be uncertain. Do not claim rollback or retry a
    // selection automatically; restoration returns authoritative persisted state.
    res.status(503).json({ code: "DELIVERY_REFRESH_REQUIRED", message: "Refresh your delivery selection before making another change." });
  }
};
