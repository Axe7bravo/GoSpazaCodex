import { MedusaError } from "@medusajs/framework/utils";
import { decideMerchantOrderWorkflow } from "../workflows/decide-merchant-order";
import { parseOrderDecision } from "../modules/marketplace/order-operation-policy";
import type { OrderDecisionAction } from "../modules/marketplace/order-operation-policy";
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { applicantIdentity } from "./applicant-auth";
import { OrderOperationsService } from "./order-operations-service";
import { orderParse } from "../modules/marketplace/order-operation-policy";
import { emptyInput, resourceId } from "../modules/marketplace/team-policy";

export async function list(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await new OrderOperationsService(req.scope).list(applicantIdentity(req), req.query));
}
export async function detail(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  orderParse(emptyInput, req.query);
  const id = orderParse(resourceId, req.params.id);
  res.json({ order: await new OrderOperationsService(req.scope).detail(applicantIdentity(req), id) });
}

async function decision(req: MedusaRequest, res: MedusaResponse, action: OrderDecisionAction) {
  res.setHeader("Cache-Control", "private, no-store");
  const identity = applicantIdentity(req);
  orderParse(emptyInput, req.query);
  const id = orderParse(resourceId, req.params.id);
  // Validate at the HTTP boundary as well as inside the owning service.
  parseOrderDecision(action, req.body);
  try {
    const { result } = await decideMerchantOrderWorkflow(req.scope).run({
      input: { identity, order_id: id, action, body: req.body },
    });
    res.json({ decision: result });
  } catch (error) {
    // Medusa 2.18 otherwise rewrites domain conflicts to a generic retry key.
    if (MedusaError.isMedusaError(error) && error.code === "ORDER_DECISION_CONFLICT") {
      res.status(409).json({ code: "ORDER_DECISION_CONFLICT", message: "An order decision is already recorded or the view is stale. Refresh the order." });
      return;
    }
    throw error;
  }
}
export const accept = (req: MedusaRequest, res: MedusaResponse) => decision(req, res, "accept");
export const reject = (req: MedusaRequest, res: MedusaResponse) => decision(req, res, "reject");

export async function customerDetail(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "customer" || !actor.actor_id) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  orderParse(emptyInput, req.query);
  const id = orderParse(resourceId, req.params.id);
  res.json({ order: await new OrderOperationsService(req.scope).customerDetail(actor.actor_id, id) });
}
