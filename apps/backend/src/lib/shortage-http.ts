import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { applicantIdentity } from "./applicant-auth";
import { PickingService } from "./picking-service";
import { orderParse } from "../modules/marketplace/order-operation-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { preferenceInput, omissionInput, shortageAdmissionInput } from "../modules/marketplace/shortage-policy";
import { updateShortageWorkflow } from "../workflows/update-shortage";

async function respond(res: MedusaResponse, work: () => Promise<unknown>) {
  res.setHeader("Cache-Control", "private, no-store");
  try { res.json(await work()); }
  catch (error) {
    if (MedusaError.isMedusaError(error) && ["SHORTAGE_CONFLICT", "PICKING_CONFLICT"].includes(error.code ?? "")) {
      res.status(409).json({ code: "SHORTAGE_CONFLICT", message: "The shortage or picking state changed. Refresh the order." });
      return;
    }
    throw error;
  }
}
function orderId(req: MedusaRequest) {
  orderParse(emptyInput, req.query);
  return orderParse(resourceId, req.params.id);
}
function customerId(req: MedusaRequest) {
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  }
  return actor.actor_id;
}
export async function customerRead(req: MedusaRequest, res: MedusaResponse) {
  await respond(res, () => new PickingService(req.scope).customerShortages(customerId(req), orderId(req), "READ"));
}
export async function preferenceRead(req: MedusaRequest, res: MedusaResponse) {
  await respond(res, async () => {
    const result = await new PickingService(req.scope).customerShortages(customerId(req), orderId(req), "READ");
    if (!("preference" in result)) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Preference unavailable.");
    return { preference: result.preference };
  });
}
async function customerMutation(req: MedusaRequest, res: MedusaResponse, action: "PREFERENCE" | "OMIT") {
  await respond(res, async () => {
    const customer_id = customerId(req), order_id = orderId(req);
    const body = action === "PREFERENCE" ? orderParse(preferenceInput, req.body) : orderParse(omissionInput, req.body);
    const case_id = action === "OMIT" ? orderParse(resourceId, req.params.case_id) : undefined;
    const { result } = await updateShortageWorkflow(req.scope).run({ input: { action, customer_id, order_id, case_id, body } });
    return result;
  });
}
export const preferenceUpdate = (req: MedusaRequest, res: MedusaResponse) => customerMutation(req, res, "PREFERENCE");
export const omit = (req: MedusaRequest, res: MedusaResponse) => customerMutation(req, res, "OMIT");
export async function merchantRead(req: MedusaRequest, res: MedusaResponse) {
  await respond(res, () => new PickingService(req.scope).shortageDetail(applicantIdentity(req), orderId(req)));
}
export async function admit(req: MedusaRequest, res: MedusaResponse) {
  await respond(res, async () => {
    const { result } = await updateShortageWorkflow(req.scope).run({ input: { action: "ADMIT",
      identity: applicantIdentity(req), order_id: orderId(req), line_id: orderParse(resourceId, req.params.line_id),
      body: orderParse(shortageAdmissionInput, req.body) } });
    return result;
  });
}
