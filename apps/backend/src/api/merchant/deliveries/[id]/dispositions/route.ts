import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { applicantIdentity } from "../../../../../lib/applicant-auth";
import { ReturnedInventory } from "../../../../../lib/returned-inventory";
import { financialParse } from "../../../../../modules/marketplace/financial-policy";
import { emptyInput, resourceId } from "../../../../../modules/marketplace/team-policy";

async function handle(req:MedusaRequest,res:MedusaResponse,mutate:boolean) {
  res.setHeader("Cache-Control","private, no-store");
  try {
    financialParse(emptyInput,req.query);
    const deliveryId=financialParse(resourceId,req.params.id);
    res.json(await new ReturnedInventory(req.scope).handle(applicantIdentity(req),deliveryId,mutate ? req.body ?? {}:undefined));
  } catch(error) {
    const status=!MedusaError.isMedusaError(error) ? 503:error.type===MedusaError.Types.INVALID_DATA ? 400:
      error.type===MedusaError.Types.FORBIDDEN ? 403:error.type===MedusaError.Types.UNAUTHORIZED ? 401:
      error.type===MedusaError.Types.NOT_FOUND ? 404:error.type===MedusaError.Types.CONFLICT ? 409:503;
    res.status(status).json({message:"Returned inventory unavailable."});
  }
}
export const GET=(req:MedusaRequest,res:MedusaResponse)=>handle(req,res,false);
export const POST=(req:MedusaRequest,res:MedusaResponse)=>handle(req,res,true);
