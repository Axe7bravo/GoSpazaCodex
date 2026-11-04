import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { CommissionService } from "./commission-service";
import { OrderEconomics } from "./order-economics";
import { applicantIdentity } from "./applicant-auth";

export const commissionHandler = (action: "publish"|"history"|"order"|"merchant") => async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if(action==="merchant") {
      financialParse(emptyInput,req.query);
      res.json(await new OrderEconomics(req.scope).merchant(applicantIdentity(req),financialParse(resourceId,req.params.id)));
      return;
    }
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (!actor?.actor_id || actor.actor_type !== "user") {
      res.status(401).json({ message: "Sign in required." }); return;
    }
    const service = new CommissionService(req.scope);
    if (action !== "history") financialParse(emptyInput, req.query);
    const result = action === "publish" ? await service.publish(actor.actor_id, req.body)
      : action === "history" ? await service.history(actor.actor_id, req.query)
      : await new OrderEconomics(req.scope).platform(actor.actor_id, financialParse(resourceId, req.params.id));
    res.json(result);
  } catch (error) {
    const type = MedusaError.isMedusaError(error) ? error.type : null;
    const ruleTimeConflict = action === "publish" && error && typeof error === "object" && "constraint" in error
      && (error.constraint === "commission_rule_no_backdating" || error.constraint === "commission_rule_effective_unique");
    const status = type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404
      : type === MedusaError.Types.INVALID_DATA ? 400 : type === MedusaError.Types.CONFLICT || ruleTimeConflict ? 409 : 503;
    res.status(status).json({ message: "Commission request unavailable." });
  }
};
