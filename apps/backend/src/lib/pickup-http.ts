import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { driverIdentity } from "./driver-auth";
import { dispatchParse, emptyDispatch } from "../modules/marketplace/dispatch-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { pickupCommand } from "../modules/marketplace/pickup-policy";
import { PickupService } from "./pickup-service";
import { pickupWorkflow } from "../workflows/pickup";
import { z } from "@medusajs/framework/zod";
export async function pickupState(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store"); dispatchParse(emptyDispatch, req.query);
  res.json(await new PickupService(req.scope).read(driverIdentity(req)));
}
export async function confirmPickup(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store"); dispatchParse(emptyDispatch, req.query);
  const body = dispatchParse(pickupCommand, req.body);
  const { result } = await pickupWorkflow(req.scope).run({ input: { identity: driverIdentity(req),
    delivery_id: dispatchParse(resourceId, req.params.id), expected_revision: body.expected_revision } });
  res.json(result);
}
// Native Admin routes remain available for non-marketplace resources. GoSpaza
// Orders must use the guarded domain even when the caller knows a native ID.
export async function blockNativeDelivery(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const path = req.originalUrl.split("?")[0] ?? "";
  // Raw creation accepts arbitrary line references and shipped/delivered dates.
  // There is no approved HTTP use of this escape hatch; internal workflows remain available.
  if (/^\/admin\/fulfillments\/?$/i.test(path)) { res.status(404).json({ message: "Not found." }); return; }
  const order = /^\/admin\/orders\/([^/]+)\/(?:fulfillments|cancel)(?:\/|$)/i.exec(path);
  const native = /^\/admin\/fulfillments\/([^/]+)(?:\/|$)/i.exec(path);
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  let protectedOrder = false;
  if (order) protectedOrder = !!await db("checkout_completion").where({ order_id: decodeURIComponent(order[1] ?? "") }).first();
  if (native) {
    const id = decodeURIComponent(native[1] ?? "");
    const rows = await req.scope.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: { order_id: string }[] }> }>
      (ContainerRegistrationKeys.QUERY).graph({ entity: "order_fulfillment", fields: ["order_id"], filters: { fulfillment_id: id } });
    protectedOrder = !!await db("delivery_operation").where({ native_fulfillment_id: id }).first()
      || rows.data.length > 0 && !!await db("checkout_completion").whereIn("order_id", rows.data.map(row => row.order_id)).first();
    if (!protectedOrder) {
      // The native entity can precede its Order link during an interrupted run.
      const found = await req.scope.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>
        (ContainerRegistrationKeys.QUERY).graph({ entity: "fulfillment", fields: ["id","metadata"], filters: { id } });
      for (const value of found.data) {
        const candidate = z.object({ metadata: z.object({ gospaza_pickup_operation: z.string() }).passthrough() }).safeParse(value);
        if (candidate.success && await db("pickup_operation").where({ id: candidate.data.metadata.gospaza_pickup_operation }).first()) protectedOrder = true;
      }
    }
  }
  if (protectedOrder) { res.status(404).json({ message: "Not found." }); return; }
  next();
}
