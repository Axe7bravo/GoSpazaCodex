import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { currentPlatform, platformAccess } from "../../../../../../../lib/platform-access";
import { rescueDeliveryWorkflow } from "../../../../../../../workflows/rescue-delivery";
import { dispatchParse } from "../../../../../../../modules/marketplace/dispatch-policy";
import { resourceId } from "../../../../../../../modules/marketplace/team-policy";
import { rescueInput } from "../../../../../../../modules/marketplace/delivery-rescue-policy";
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = await currentPlatform(req.scope, req.auth_context);
    await platformAccess(req.scope, actor, "DELIVERY_OPERATIONS_VIEW", "DELIVERY_RESCUE");
    if (Object.keys(req.query).length) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid rescue command.");
    const delivery = dispatchParse(resourceId, req.params.id), body = dispatchParse(rescueInput, req.body);
    // Validate before workflow history can retain any unknown request fields.
    const { result } = await rescueDeliveryWorkflow(req.scope).run({ input: { actor, delivery, body } });
    res.json(result);
  } catch (error) {
    const type = MedusaError.isMedusaError(error) ? error.type : null;
    const status = type === MedusaError.Types.INVALID_DATA ? 400 : type === MedusaError.Types.UNAUTHORIZED ? 401
      : type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404 : type === MedusaError.Types.CONFLICT ? 409 : 503;
    res.status(status).json({ code: status === 409 ? "RESCUE_STATE_CONFLICT" : "RESCUE_UNAVAILABLE",
      message: status === 409 ? "Delivery state changed. Refresh before another action." : "Dispatch rescue is unavailable." });
  }
}
