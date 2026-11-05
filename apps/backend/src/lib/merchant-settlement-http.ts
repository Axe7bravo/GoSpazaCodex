import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { MerchantSettlements } from "./merchant-settlement-service";

export const merchantSettlementHandler=(action:"read"|"generate"|"prepare"|"supersede"|"activate")=>async(req:MedusaRequest,res:MedusaResponse)=>{
  res.setHeader("Cache-Control","private, no-store");
  try {
    const auth=(req as AuthenticatedMedusaRequest).auth_context;
    if(auth?.actor_type!=="user" || !auth.actor_id) {res.status(401).json({message:"Sign in required."});return;}
    financialParse(emptyInput,req.query);
    const service=new MerchantSettlements(req.scope),actor=auth.actor_id;
    const result=action==="generate"?await service.generate(actor,req.body):action==="activate"?await service.activate(actor,req.body)
      :action==="read"?await service.read(actor,financialParse(resourceId,req.params.id))
      :action==="prepare"?await service.prepare(actor,financialParse(resourceId,req.params.id),req.body)
      :await service.supersede(actor,financialParse(resourceId,req.params.id),req.body);
    res.json(result);
  } catch(error) {
    const type=MedusaError.isMedusaError(error)?error.type:null;
    const status=type===MedusaError.Types.FORBIDDEN?403:type===MedusaError.Types.NOT_FOUND?404
      :type===MedusaError.Types.INVALID_DATA?400:type===MedusaError.Types.CONFLICT?409:503;
    res.status(status).json({message:"Settlement request unavailable."});
  }
};
