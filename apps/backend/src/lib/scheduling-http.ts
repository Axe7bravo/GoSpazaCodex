import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { SchedulingService } from "./scheduling-service";
import { configurationReason, policyInput, schedulingId, schedulingInput, slotInput } from "../modules/marketplace/scheduling-policy";

export function schedulingAdmin(req: MedusaRequest): string {
  const actor = (req as AuthenticatedMedusaRequest).auth_context;
  if (actor?.actor_type !== "user" || !actor.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform user session required.");
  return actor.actor_id;
}
function param(req: MedusaRequest, key: string) { return schedulingInput(schedulingId, req.params[key]); }
function reply(res: MedusaResponse, data: unknown) {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(data);
}
const reason = z.object({ confirmed: z.literal(true), reason: configurationReason }).strict();
export async function getScheduling(req: MedusaRequest, res: MedusaResponse) {
  schedulingAdmin(req);
  reply(res, await new SchedulingService(req.scope).configuration(param(req, "storeId")));
}
export async function configurePolicy(req: MedusaRequest, res: MedusaResponse) {
  const user = schedulingAdmin(req);
  const data = schedulingInput(reason.extend({ policy: policyInput }).strict(), req.body);
  reply(res, await new SchedulingService(req.scope).savePolicy(param(req, "storeId"), data.policy, user, data.reason));
}
export async function configureAssignment(req: MedusaRequest, res: MedusaResponse) {
  const user = schedulingAdmin(req);
  const data = schedulingInput(reason.extend({ priority: z.number().int().min(-2147483648).max(2147483647),
    asap_enabled: z.boolean(), scheduled_enabled: z.boolean() }).strict(), req.body);
  reply(res, await new SchedulingService(req.scope).configureAssignment(param(req, "storeId"), param(req, "assignmentId"),
    data.priority, data.asap_enabled, data.scheduled_enabled, user, data.reason));
}
export async function synchronizeScheduling(req: MedusaRequest, res: MedusaResponse) {
  const user = schedulingAdmin(req), data = schedulingInput(reason, req.body);
  reply(res, await new SchedulingService(req.scope).synchronize(param(req, "storeId"), user, data.reason));
}
export async function listSlots(req: MedusaRequest, res: MedusaResponse) {
  schedulingAdmin(req);
  reply(res, { slots: await new SchedulingService(req.scope).slots(param(req, "storeId")) });
}
export const configureSlot = (create: boolean) => async (req: MedusaRequest, res: MedusaResponse) => {
  const user = schedulingAdmin(req), data = schedulingInput(reason.extend({ slot: slotInput }).strict(), req.body);
  reply(res, { slot: await new SchedulingService(req.scope).saveSlot(param(req, "storeId"), data.slot,
    user, data.reason, create ? undefined : param(req, "slotId")) });
};
export function blockNativeShipping(_req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(404).json({ message: "Use the GoSpaza delivery API." });
}
