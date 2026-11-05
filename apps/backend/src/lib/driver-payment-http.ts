import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { financialParse } from "../modules/marketplace/financial-policy";
import type { DriverPaymentAction } from "../modules/marketplace/driver-payment-policy";
import { DriverPayments } from "./driver-payment";

export const driverPaymentHandler = (action: DriverPaymentAction | "selection" | "evidence" | "attention") =>
  async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const auth = (req as AuthenticatedMedusaRequest).auth_context;
      if (auth?.actor_type !== "user" || !auth.actor_id) { res.status(401).json({ message: "Sign in required." }); return; }
      const service = new DriverPayments(req.scope), actor = auth.actor_id;
      if (action === "selection") { res.json(await service.selection(actor, financialParse(resourceId, req.params.id), req.query)); return; }
      if (action === "attention") { res.json(await service.attention(actor, req.query)); return; }
      financialParse(emptyInput, req.query);
      if (action === "RECORD" || action === "UNKNOWN") { res.json(await service.record(actor, action, req.body)); return; }
      const payment = financialParse(resourceId, req.params.id);
      res.json(action === "evidence" ? await service.evidence(actor, payment) : await service.execute(actor, payment, action, req.body));
    } catch (error) {
      const type = MedusaError.isMedusaError(error) ? error.type : null;
      res.status(type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404
        : type === MedusaError.Types.INVALID_DATA ? 400 : type === MedusaError.Types.CONFLICT ? 409 : 503)
        .json({ message: "Driver payment information unavailable." });
    }
  };
