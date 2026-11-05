import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { financialParse } from "../modules/marketplace/financial-policy";
import { DriverEarnings } from "./driver-earning";

export async function driverEarningRead(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (actor?.actor_type !== "user" || !actor.actor_id) { res.status(401).json({ message: "Sign in required." }); return; }
    financialParse(emptyInput, req.query);
    res.json(await new DriverEarnings(req.scope).forOrder(actor.actor_id, financialParse(resourceId, req.params.id)));
  } catch (error) {
    const type = MedusaError.isMedusaError(error) ? error.type : null;
    res.status(type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404 : type === MedusaError.Types.INVALID_DATA ? 400 : 503)
      .json({ message: "Driver earning information unavailable." });
  }
}
