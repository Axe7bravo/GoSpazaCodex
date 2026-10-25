import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { driverIdentity } from "./driver-auth";
import { dispatchParse, emptyDispatch } from "../modules/marketplace/dispatch-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { HandoffService } from "./handoff-service";
import { DeliveryTracking } from "./delivery-tracking";
function prepare(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store"); dispatchParse(emptyDispatch, req.query);
  return dispatchParse(resourceId, req.params.id);
}
function customer(req: MedusaRequest) {
  const auth = (req as AuthenticatedMedusaRequest).auth_context;
  if (auth?.actor_type !== "customer" || !auth.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  return auth.actor_id;
}
export async function arrive(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new HandoffService(req.scope).arrive(driverIdentity(req), id, req.body));
}
export async function verify(req: MedusaRequest, res: MedusaResponse) {
  // Never put candidate OTPs into workflow inputs, errors or audit evidence.
  const id = prepare(req,res); res.json(await new HandoffService(req.scope).verify(driverIdentity(req), id, req.body));
}
export async function read(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new HandoffService(req.scope).read(driverIdentity(req), id));
}
export async function latest(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store"); dispatchParse(emptyDispatch, req.query);
  res.json(await new HandoffService(req.scope).latest(driverIdentity(req)));
}
export async function beginTracking(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new DeliveryTracking(req.scope).begin(driverIdentity(req), id, req.body));
}
export async function tracking(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new DeliveryTracking(req.scope).customer(customer(req), id));
}
export async function code(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new HandoffService(req.scope).customerCode(customer(req), id));
}
export async function regenerate(req: MedusaRequest, res: MedusaResponse) {
  const id = prepare(req,res); res.json(await new HandoffService(req.scope).customerCode(customer(req), id, req.body));
}
