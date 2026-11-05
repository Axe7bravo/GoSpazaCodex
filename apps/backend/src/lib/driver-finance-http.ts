import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { driverIdentity } from "./driver-auth";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { DriverFinanceProjection, driverFinanceEmpty } from "./driver-finance-projection";
export const driverFinanceHandler = (action: "own" | "own-payments" | "own-earning" | "own-payment" | "capabilities" | "reviews" | "earnings" | "earning" | "payments" | "payment") =>
  async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      if (action === "own" || action === "own-payments" || action === "own-earning" || action === "own-payment") {
        const identity = driverIdentity(req);
        const service = new DriverFinanceProjection(req.scope);
        if (action === "own") { res.json(await service.driverList(identity, req.query)); return; }
        if (action === "own-payments") { res.json(await service.driverPayments(identity, req.query)); return; }
        financialParse(driverFinanceEmpty, req.query); const id = financialParse(resourceId, req.params.id);
        res.json(action === "own-earning" ? await service.driverEarning(identity, id) : await service.driverPayment(identity, id)); return;
      }
      const auth = (req as AuthenticatedMedusaRequest).auth_context;
      if (auth?.actor_type !== "user" || !auth.actor_id) { res.status(401).json({ message: "Sign in required." }); return; }
      const service = new DriverFinanceProjection(req.scope);
      if (action === "earnings" || action === "payments" || action === "reviews") { res.json(await service[action](auth.actor_id, req.query)); return; }
      financialParse(driverFinanceEmpty, req.query);
      res.json(action === "capabilities" ? await service.capabilities(auth.actor_id)
        : action === "earning" ? await service.earningDetail(auth.actor_id, financialParse(resourceId, req.params.id))
        : await service.paymentDetail(auth.actor_id, financialParse(resourceId, req.params.id)));
    } catch (error) {
      const type = MedusaError.isMedusaError(error) ? error.type : null;
      res.status(type === MedusaError.Types.UNAUTHORIZED ? 401 : type === MedusaError.Types.FORBIDDEN ? 403
        : type === MedusaError.Types.NOT_FOUND ? 404 : type === MedusaError.Types.INVALID_DATA ? 400 : 503)
        .json({ message: "Driver financial information unavailable." });
    }
  };
