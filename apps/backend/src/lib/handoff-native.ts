import { z } from "@medusajs/framework/zod";
import type { MedusaContainer, IWorkflowEngineService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/medusa/core-flows";
import type { DeliveryCompletion } from "../modules/marketplace/handoff-policy";
import type { PickupOperation } from "../modules/marketplace/pickup-policy";
import { handoffError } from "../modules/marketplace/handoff-policy";
import { NativePickup } from "./pickup-native";
import { completionObservation } from "./completion-native";
export class NativeHandoff {
  constructor(private readonly container: MedusaContainer) {}
  async run(op: DeliveryCompletion, ship: PickupOperation): Promise<string> {
    if (!ship.fulfillment_id) throw handoffError();
    const result = await markOrderFulfillmentAsDeliveredWorkflow(this.container).run({
      context: { transactionId: op.transaction_id }, throwOnError: false,
      input: { orderId: ship.input.order_id, fulfillmentId: ship.fulfillment_id, no_notification: true },
    });
    return z.object({ state: z.string() }).parse(result.transaction.getFlow()).state;
  }
  async terminal(op: DeliveryCompletion): Promise<boolean> {
    const rows = await this.container.resolve<IWorkflowEngineService>(Modules.WORKFLOW_ENGINE).listWorkflowExecutions({
      workflow_id: op.workflow_id, transaction_id: op.transaction_id }, { take: null });
    return rows.length === 1 && completionObservation(rows[0], { ...op, execution_id: null, run_id: null })?.state === "done";
  }
  async validate(ship: PickupOperation, prepareId: string) {
    if (!ship.fulfillment_id || ship.state !== "SUCCEEDED" || ship.action !== "SHIP") throw handoffError();
    await new NativePickup(this.container).validate(ship, prepareId, true);
    const rows = await this.container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>
      (ContainerRegistrationKeys.QUERY).graph({ entity: "fulfillment", fields: ["id","delivered_at"], filters: { id: ship.fulfillment_id } });
    const f = z.object({ id: z.string(), delivered_at: z.coerce.date() }).parse(rows.data[0]);
    if (f.id !== ship.fulfillment_id) throw handoffError();
    return { fulfillment_id: f.id, delivered_at: f.delivered_at.toISOString() };
  }
}
