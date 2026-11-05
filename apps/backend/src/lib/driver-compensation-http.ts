import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { financialParse } from "../modules/marketplace/financial-policy";
import { DriverCompensation } from "./driver-compensation";

export const driverCompensationHandler = (action: "history" | "publish" | "activate" | "resolution") => async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (actor?.actor_type !== "user" || !actor.actor_id) { res.status(401).json({ message: "Sign in required." }); return; }
    if (action !== "history") financialParse(emptyInput, req.query);
    const service = new DriverCompensation(req.scope);
    const result = action === "history" ? await service.history(actor.actor_id, req.query)
      : action === "publish" ? await service.publish(actor.actor_id, req.body)
      : action === "activate" ? await service.activate(actor.actor_id, req.body)
      : await service.resolution(actor.actor_id, financialParse(resourceId, req.params.id));
    res.json(result);
  } catch (error) {
    const type = MedusaError.isMedusaError(error) ? error.type : null;
    const constraint = error && typeof error === "object" && "constraint" in error ? error.constraint : null;
    const decisionConflict = constraint === "driver_compensation_no_backdating" || constraint === "driver_compensation_revision"
      || constraint === "driver_compensation_terms_effective_at_key";
    const status = type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404
      : type === MedusaError.Types.INVALID_DATA ? 400 : type === MedusaError.Types.CONFLICT || decisionConflict ? 409 : 503;
    res.status(status).json({ message: "Driver compensation request unavailable." });
  }
};
