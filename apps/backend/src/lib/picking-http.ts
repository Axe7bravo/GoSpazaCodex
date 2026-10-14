import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { applicantIdentity } from "./applicant-auth";
import { PickingService } from "./picking-service";
import { orderParse } from "../modules/marketplace/order-operation-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";
import { pickingCommand } from "../modules/marketplace/picking-policy";
import type { PickingAction } from "../modules/marketplace/picking-policy";
import { updatePickingWorkflow } from "../workflows/update-picking";

export async function list(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await new PickingService(req.scope).list(applicantIdentity(req), req.query));
}
export async function detail(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  orderParse(emptyInput, req.query);
  res.json({ picking: await new PickingService(req.scope).detail(applicantIdentity(req), orderParse(resourceId, req.params.id)) });
}
async function mutate(req: MedusaRequest, res: MedusaResponse, action: PickingAction) {
  res.setHeader("Cache-Control", "private, no-store");
  const identity = applicantIdentity(req);
  orderParse(emptyInput, req.query);
  const order_id = orderParse(resourceId, req.params.id);
  const command = pickingCommand(action, req.body, req.params.line_id);
  try {
    const { result } = await updatePickingWorkflow(req.scope).run({ input: {
      identity, order_id, action, body: command.input, line_id: command.action === "LINE" ? command.line_id : undefined,
    } });
    res.json(result);
  } catch (error) {
    if (MedusaError.isMedusaError(error) && error.code === "PICKING_CONFLICT") {
      res.status(409).json({ code: "PICKING_CONFLICT", message: "Picking changed or is not eligible. Refresh picking." });
      return;
    }
    throw error;
  }
}
export const claim = (req: MedusaRequest, res: MedusaResponse) => mutate(req, res, "CLAIM");
export const line = (req: MedusaRequest, res: MedusaResponse) => mutate(req, res, "LINE");
export const reassign = (req: MedusaRequest, res: MedusaResponse) => mutate(req, res, "REASSIGN");
export const complete = (req: MedusaRequest, res: MedusaResponse) => mutate(req, res, "COMPLETE");
