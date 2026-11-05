import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { applicantIdentity } from "./applicant-auth";
import { SettlementProjection } from "./settlement-projection";
export const settlementProjectionHandler=(action:"platform-list"|"platform-detail"|"merchant-list"|"merchant-detail")=>async(req:MedusaRequest,res:MedusaResponse)=>{
  res.setHeader("Cache-Control","private, no-store");
  try {
    const service=new SettlementProjection(req.scope);
    if(action.endsWith("detail")) financialParse(emptyInput,req.query);
    const id=action.endsWith("detail")?financialParse(resourceId,req.params.id):"";
    if(action.startsWith("merchant")) {
      const identity=applicantIdentity(req);
      res.json(action==="merchant-list"?await service.merchantList(identity,req.query):await service.merchantDetail(identity,id));return;
    }
    const auth=(req as AuthenticatedMedusaRequest).auth_context;
    if(auth?.actor_type!=="user" || !auth.actor_id) {res.status(401).json({message:"Sign in required."});return;}
    res.json(action==="platform-list"?await service.platformList(auth.actor_id,req.query):await service.platformDetail(auth.actor_id,id));
  } catch(error) {
    const type=MedusaError.isMedusaError(error)?error.type:null;
    const status=type===MedusaError.Types.UNAUTHORIZED?401:type===MedusaError.Types.FORBIDDEN?403:type===MedusaError.Types.NOT_FOUND?404
      :type===MedusaError.Types.INVALID_DATA?400:type===MedusaError.Types.CONFLICT?409:503;
    res.status(status).json({message:"Statement request unavailable."});
  }
};
