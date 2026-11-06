import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { z, ZodError } from "@medusajs/framework/zod";
import { currentPlatform } from "./platform-access";
import { OperationsService } from "./operations-service";
export function operationsHandler(action: "overview" | "attention" | "order" | "delivery" | "lookup" | "health" | "order-timeline" | "delivery-timeline") {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const actor = await currentPlatform(req.scope, (req as AuthenticatedMedusaRequest).auth_context), service = new OperationsService(req.scope);
      if (["overview", "order", "delivery", "health"].includes(action)) z.object({}).strict().parse(req.query);
      const result = action === "overview" ? await service.overview(actor) : action === "attention" ? await service.attention(actor, req.params.source, req.query)
        : action === "order" ? await service.order(actor, req.params.id) : action === "delivery" ? await service.delivery(actor, req.params.id)
        : action === "lookup" ? await service.lookup(actor, req.query) : action === "health" ? await service.health(actor)
        : await service.timeline(actor, action === "order-timeline" ? "order" : "delivery", req.params.id, req.query);
      res.json(result);
    } catch (error) {
      const type = MedusaError.isMedusaError(error) ? error.type : null;
      res.status(error instanceof ZodError || type === MedusaError.Types.INVALID_DATA ? 400 : type === MedusaError.Types.FORBIDDEN ? 403
        : type === MedusaError.Types.UNAUTHORIZED ? 401 : type === MedusaError.Types.NOT_FOUND ? 404 : 503).json({ message: "Operational information unavailable." });
    }
  };
}
