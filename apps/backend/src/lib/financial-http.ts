import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { FinancialService } from "./financial-service";
import { StoreCreditSettlement } from "./store-credit-settlement";
import { financialAdjustmentWorkflow } from "../workflows/financial-adjustment";
import { refundAdjustmentWorkflow } from "../workflows/refund-adjustment";
import { applicantIdentity } from "./applicant-auth";
import { financialParse } from "../modules/marketplace/financial-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";

type Action="customer"|"merchant"|"admin-order"|"list"|"approve"|"goodwill"|"refund"|"issue-credit"|"balance"|"apply-balance";
export const financialHandler=(action:Action)=>async(req:MedusaRequest,res:MedusaResponse)=>{
  res.setHeader("Cache-Control","private, no-store");
  try {
    const auth=(req as AuthenticatedMedusaRequest).auth_context;
    const admin=["admin-order","list","approve","goodwill","refund","issue-credit"].includes(action);
    if (action!=="merchant" && (!auth?.actor_id || auth.actor_type!==(admin ? "user":"customer"))) {
      res.status(401).json({ message:"Sign in required." }); return;
    }
    if (action!=="list") financialParse(emptyInput,req.query);
    const id=["list","balance","apply-balance"].includes(action) ? "":financialParse(resourceId,req.params.id);
    const actor=action==="merchant" ? applicantIdentity(req):auth?.actor_id ?? "";
    const service=new FinancialService(req.scope);
    const result=action==="customer" ? await service.customer(actor,id)
      :action==="merchant" ? await service.merchant(actor,id)
      :action==="admin-order" ? await service.adminOrder(actor,id)
      :action==="list" ? await service.list(actor,req.query)
      :action==="refund" ? (await refundAdjustmentWorkflow(req.scope).run({input:{user:actor,adjustment:id,body:req.body}})).result
      :action==="issue-credit" ? await new StoreCreditSettlement(req.scope).issue(actor,id,req.body)
      :action==="balance" ? await new StoreCreditSettlement(req.scope).balance(actor)
      :action==="apply-balance" ? await new StoreCreditSettlement(req.scope).apply(actor,req.body)
      :(await financialAdjustmentWorkflow(req.scope).run({input:{user:actor,id,action,body:req.body}})).result;
    res.json(result);
  } catch(error) {
    const status=MedusaError.isMedusaError(error) ? error.type===MedusaError.Types.NOT_FOUND ? 404
      :error.type===MedusaError.Types.FORBIDDEN ? 403:error.type===MedusaError.Types.INVALID_DATA ? 400
      :error.type===MedusaError.Types.UNAUTHORIZED ? 401:error.type===MedusaError.Types.CONFLICT ? 409:503:503;
    res.status(status).json({ message:status===409 ? "Financial evidence requires review.":"Financial request unavailable." });
  }
};
