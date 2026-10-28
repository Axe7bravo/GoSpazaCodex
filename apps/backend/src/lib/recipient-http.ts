import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { driverIdentity } from "./driver-auth";
import { applicantIdentity } from "./applicant-auth";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { restrictedParse } from "../modules/marketplace/restricted-policy";
import { RecipientService } from "./recipient-service";
function prepare(req:MedusaRequest,res:MedusaResponse) {
  res.setHeader("Cache-Control","private, no-store"); restrictedParse(emptyInput,req.query);
  return restrictedParse(resourceId,req.params.id);
}
export async function read(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).read(driverIdentity(req),id));
}
export async function verify(req:MedusaRequest,res:MedusaResponse) {
  // Transient DOB goes directly to policy, never a persistent workflow input.
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).verify(driverIdentity(req),id,req.body));
}
export async function start(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).returnAction(driverIdentity(req),id,"start",req.body));
}
export async function arrive(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).returnAction(driverIdentity(req),id,"arrive",req.body));
}
export async function document(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).driverDocument(driverIdentity(req),id));
}
export async function merchantRead(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).merchant(applicantIdentity(req),id));
}
export async function receipt(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).merchant(applicantIdentity(req),id,req.body));
}
export async function customerRead(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res), auth=(req as AuthenticatedMedusaRequest).auth_context;
  if(auth?.actor_type!=="customer"||!auth.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED,"Sign in required.");
  res.json(await new RecipientService(req.scope).customer(auth.actor_id,id));
}
export async function merchantDocument(req:MedusaRequest,res:MedusaResponse) {
  const id=prepare(req,res);res.json(await new RecipientService(req.scope).merchantDocument(applicantIdentity(req),id));
}
