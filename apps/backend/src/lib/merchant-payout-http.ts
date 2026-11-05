import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId, emptyInput } from "../modules/marketplace/team-policy";
import type { PayoutAction } from "../modules/marketplace/merchant-payout-policy";
import { MerchantPayouts } from "./merchant-payout-service";

export const merchantPayoutHandler=(action:PayoutAction|"read"|"evidence"|"attention")=>async(req:MedusaRequest,res:MedusaResponse)=>{
  res.setHeader("Cache-Control","private, no-store");
  try {
    const auth=(req as AuthenticatedMedusaRequest).auth_context;
    if(auth?.actor_type!=="user" || !auth.actor_id) {res.status(401).json({message:"Sign in required."});return;}
    if(action!=="attention") financialParse(emptyInput,req.query);
    const service=new MerchantPayouts(req.scope),actor=auth.actor_id;
    if(action==="attention") {res.json(await service.attention(actor,req.query));return;}
    const payable=financialParse(resourceId,req.params.id);
    res.json(action==="read"?await service.read(actor,payable):action==="evidence"?await service.evidence(actor,payable)
      :await service.execute(actor,payable,action,req.body));
  } catch(error) {
    const type=MedusaError.isMedusaError(error)?error.type:null;
    const status=type===MedusaError.Types.FORBIDDEN?403:type===MedusaError.Types.NOT_FOUND?404
      :type===MedusaError.Types.INVALID_DATA?400:type===MedusaError.Types.CONFLICT?409:503;
    res.status(status).json({message:"Settlement payment request unavailable."});
  }
};
