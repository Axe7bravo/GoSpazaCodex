import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { driverIdentity } from "./driver-auth";
import { DispatchService } from "./dispatch-service";
import { dispatchParse, emptyDispatch, dispatchRevision, dispatchConfigurationInput } from "../modules/marketplace/dispatch-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { dispatchCommandWorkflow } from "../workflows/dispatch-command";
import { applicantIdentity } from "./applicant-auth";
import { DispatchProjection } from "./dispatch-projection";
export function orderDelivery(actor: "merchant" | "customer") {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    prepare(req, res);
    const context = (req as AuthenticatedMedusaRequest).auth_context;
    const identity = actor === "merchant" ? applicantIdentity(req)
      : context?.actor_type === "customer" ? context.actor_id : undefined;
    if (!identity) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
    res.json(await new DispatchProjection(req.scope).read(actor, identity, dispatchParse(resourceId, req.params.id)));
  };
}
function prepare(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store"); dispatchParse(emptyDispatch, req.query);
}
function platform(req: MedusaRequest) {
  const c = (req as AuthenticatedMedusaRequest).auth_context;
  if (c?.actor_type !== "user" || !c.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform authentication required.");
  return c.actor_id;
}
export async function availability(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json(await new DispatchService(req.scope).readAvailability(driverIdentity(req)));
}
export async function current(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json(await new DispatchService(req.scope).current(driverIdentity(req)));
}
export async function configuration(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json(await new DispatchService(req.scope).configuration(platform(req), dispatchParse(resourceId, req.params.id)));
}
// Location samples must never enter persisted workflow input/step history.
export async function location(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json(await new DispatchService(req.scope).location(driverIdentity(req), req.body));
}
export function command(action: "ONLINE" | "OFFLINE" | "ACCEPT" | "DECLINE" | "CONFIGURE") {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    prepare(req, res);
    const actor = action === "CONFIGURE" ? { type: "user" as const, id: platform(req) } : { type: "driver" as const, id: driverIdentity(req) };
    const id = ["ACCEPT","DECLINE","CONFIGURE"].includes(action) ? dispatchParse(resourceId, req.params.id) : undefined;
    const body = action === "CONFIGURE" ? dispatchParse(dispatchConfigurationInput, req.body) : dispatchParse(dispatchRevision, req.body);
    const { result } = await dispatchCommandWorkflow(req.scope).run({ input: { actor, action, id, body } });
    res.json(result);
  };
}
