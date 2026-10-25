import { z } from "@medusajs/framework/zod";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { IInventoryService, IWorkflowEngineService, MedusaContainer } from "@medusajs/framework/types";
import { createOrderFulfillmentWorkflow, createOrderShipmentWorkflow } from "@medusajs/medusa/core-flows";
import { pickupComponentSignature, pickupConflict } from "../modules/marketplace/pickup-policy";
import type { PickupInput, PickupOperation, PickupManifest } from "../modules/marketplace/pickup-policy";
import { completionObservation } from "./completion-native";

const number = (value: unknown) => {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string" && !value.trim()) throw pickupConflict();
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw pickupConflict(); return n;
};
const quantity = z.unknown().transform(number);
const item = z.object({ id: z.string(), detail: z.object({ fulfilled_quantity: quantity, shipped_quantity: quantity, delivered_quantity: quantity }),
  variant: z.object({ manage_inventory: z.boolean(), inventory_items: z.array(z.object({ required_quantity: quantity,
    inventory: z.object({ id: z.string() }) })) }).nullable() });
const nativeOrder = z.object({ id: z.string(), status: z.string(), items: z.array(item) });
const fulfillment = z.object({ id: z.string(), location_id: z.string(), shipping_option_id: z.string(), provider_id: z.string(),
  packed_at: z.unknown(), shipped_at: z.unknown(), delivered_at: z.unknown(), canceled_at: z.unknown(),
  metadata: z.object({ gospaza_pickup_operation: z.string() }),
  items: z.array(z.object({ line_item_id: z.string(), inventory_item_id: z.string().nullable(), quantity })) });
type Observation = { state: string; run_id: string | null; execution_id: string | null };
export interface PickupNative {
  plan(orderId: string, locationId: string, items: PickupManifest): Promise<Pick<PickupInput,"components" | "reservations">>;
  run(op: PickupOperation): Promise<Observation>;
  observe(op: PickupOperation): Promise<Observation | null>;
  validate(op: PickupOperation, prepareId: string): Promise<{ fulfillment_id: string; shipped_at: string | null }>;
  absent(orderId: string): Promise<boolean>;
}
export class NativePickup implements PickupNative {
  constructor(private readonly container: MedusaContainer) {}
  private async query(entity: string, fields: string[], filters: Record<string, unknown>) {
    return (await this.container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>
      (ContainerRegistrationKeys.QUERY).graph({ entity, fields, filters })).data;
  }
  private async order(id: string) {
    const rows = await this.query("order", ["id","status","items.id","items.detail.fulfilled_quantity","items.detail.shipped_quantity","items.detail.delivered_quantity",
      "items.variant.manage_inventory","items.variant.inventory_items.required_quantity","items.variant.inventory_items.inventory.id"], { id });
    if (rows.length !== 1) throw pickupConflict();
    const parsed = nativeOrder.safeParse(rows[0]);
    if (!parsed.success || parsed.data.id !== id || parsed.data.status === "canceled") throw pickupConflict();
    return parsed.data;
  }
  async absent(orderId: string) { return (await this.query("order_fulfillment", ["order_id","fulfillment_id"], { order_id: orderId })).length === 0; }
  async plan(orderId: string, locationId: string, items: PickupManifest) {
    const order = await this.order(orderId);
    if (!await this.absent(orderId) || order.items.some(i => i.detail.fulfilled_quantity !== 0 || i.detail.shipped_quantity !== 0)) throw pickupConflict();
    const rows = await this.container.resolve<IInventoryService>(Modules.INVENTORY).listReservationItems({ line_item_id: items.map(i => i.id) }, { take: null });
    const components: PickupInput["components"] = [], reservations: PickupInput["reservations"] = [];
    for (const selected of items) {
      const line = order.items.find(i => i.id === selected.id); if (!line?.variant) throw pickupConflict();
      if (!line.variant.manage_inventory) {
        if (rows.some(r => r.line_item_id === line.id)) throw pickupConflict();
        components.push({ line_item_id: line.id, inventory_item_id: null, quantity: selected.quantity }); continue;
      }
      if (!line.variant.inventory_items.length) throw pickupConflict();
      for (const component of line.variant.inventory_items) {
        const matching = rows.filter(r => r.line_item_id === line.id && r.inventory_item_id === component.inventory.id);
        const r = matching[0], consumed = selected.quantity * component.required_quantity;
        if (matching.length !== 1 || !r || r.location_id !== locationId || !Number.isSafeInteger(consumed) || consumed <= 0 || number(r.quantity) < consumed) throw pickupConflict();
        components.push({ line_item_id: line.id, inventory_item_id: r.inventory_item_id, quantity: consumed });
        reservations.push({ id: r.id, line_item_id: line.id, inventory_item_id: r.inventory_item_id, location_id: locationId, remaining: number(r.quantity) - consumed });
      }
    }
    if (rows.length !== reservations.length) throw pickupConflict();
    return { components, reservations };
  }
  async run(op: PickupOperation): Promise<Observation> {
    const context = { transactionId: op.transaction_id };
    const outcome = op.action === "PREPARE"
      ? await createOrderFulfillmentWorkflow(this.container).run({ context, throwOnError: false, input: {
        order_id: op.input.order_id, location_id: op.input.location_id, shipping_option_id: op.input.shipping_option_id,
        items: op.input.items, no_notification: true, metadata: { gospaza_pickup_operation: op.id } } })
      : await createOrderShipmentWorkflow(this.container).run({ context, throwOnError: false, input: {
        order_id: op.input.order_id, fulfillment_id: op.input.fulfillment_id ?? "", items: op.input.items, labels: [], no_notification: true } });
    // An observed terminal return is evidence; transaction identity alone is not.
    const flow = z.object({ state: z.string() }).parse(outcome.transaction.getFlow());
    return { state: flow.state, run_id: null, execution_id: null };
  }
  async observe(op: PickupOperation): Promise<Observation | null> {
    if (op.native_state === "done") return { state: "done", run_id: op.run_id, execution_id: op.execution_id };
    const rows = await this.container.resolve<IWorkflowEngineService>(Modules.WORKFLOW_ENGINE).listWorkflowExecutions({
      workflow_id: op.workflow_id, transaction_id: op.transaction_id }, { take: null });
    if (rows.length !== 1) return null;
    const result = completionObservation(rows[0], op);
    return result ? { state: result.state, run_id: result.runId, execution_id: result.id } : null;
  }
  async validate(op: PickupOperation, prepareId: string, delivered = false) {
    const links = z.array(z.object({ order_id: z.string(), fulfillment_id: z.string() })).parse(
      await this.query("order_fulfillment", ["order_id","fulfillment_id"], { order_id: op.input.order_id }));
    const link = links[0]; if (links.length !== 1 || !link || link.order_id !== op.input.order_id) throw pickupConflict();
    const rows = await this.query("fulfillment", ["id","location_id","shipping_option_id","provider_id","packed_at","shipped_at","delivered_at","canceled_at","metadata","items.*"], { id: link.fulfillment_id });
    if (rows.length !== 1) throw pickupConflict(); const f = fulfillment.parse(rows[0]);
    if (f.id !== link.fulfillment_id || f.metadata.gospaza_pickup_operation !== prepareId || f.location_id !== op.input.location_id
      || f.shipping_option_id !== op.input.shipping_option_id || f.provider_id !== "manual_manual" || !f.packed_at || f.canceled_at || !!f.delivered_at !== delivered
      || op.input.fulfillment_id && op.input.fulfillment_id !== f.id || op.fulfillment_id && op.fulfillment_id !== f.id) throw pickupConflict();
    if (pickupComponentSignature(f.items) !== pickupComponentSignature(op.input.components)) throw pickupConflict();
    const shipped = op.action === "SHIP";
    if (shipped !== !!f.shipped_at) throw pickupConflict();
    const order = await this.order(op.input.order_id);
    for (const line of order.items) {
      const expected = op.input.items.find(i => i.id === line.id)?.quantity ?? 0;
      if (line.detail.fulfilled_quantity !== expected || line.detail.shipped_quantity !== (shipped ? expected : 0)
        || line.detail.delivered_quantity !== (delivered ? expected : 0)) throw pickupConflict();
    }
    if (op.input.items.some(i => !order.items.some(l => l.id === i.id))) throw pickupConflict();
    const current = await this.container.resolve<IInventoryService>(Modules.INVENTORY).listReservationItems({ line_item_id: op.input.items.map(i => i.id) }, { take: null });
    for (const before of op.input.reservations) {
      const matches = current.filter(r => r.line_item_id === before.line_item_id && r.inventory_item_id === before.inventory_item_id);
      if (before.remaining === 0 ? matches.length !== 0 : matches.length !== 1 || matches[0]?.id !== before.id
        || matches[0]?.location_id !== before.location_id || number(matches[0]?.quantity) !== before.remaining) throw pickupConflict();
    }
    if (current.length !== op.input.reservations.filter(r => r.remaining > 0).length) throw pickupConflict();
    return { fulfillment_id: f.id, shipped_at: f.shipped_at ? new Date(String(f.shipped_at)).toISOString() : null };
  }
}
