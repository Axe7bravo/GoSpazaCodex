import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { OrderDispatchDTO } from "@gospaza/contracts";
import type { DeliveryRow } from "../modules/marketplace/dispatch-rows";
import { OrderOperationsService } from "./order-operations-service";
import { PickupService } from "./pickup-service";
import { HandoffService } from "./handoff-service";

export class DispatchProjection {
  constructor(private readonly container: MedusaContainer) {}
  async read(actor: "merchant" | "customer", identity: string, orderId: string): Promise<OrderDispatchDTO> {
    const orders = new OrderOperationsService(this.container);
    // Existing owners establish tenant/customer authority before any delivery
    // lookup. A known order/delivery ID never grants access.
    if (actor === "merchant") await orders.detail(identity, orderId);
    else await orders.customerDetail(identity, orderId);
    const db = this.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const d = await db<DeliveryRow>("delivery_operation").where({ medusa_order_id: orderId }).first();
    if (!d || d.status === "PENDING_DISPATCH") return { status: "PREPARING" };
    if (d.status === "ATTENTION_REQUIRED") return { status: "ATTENTION_REQUIRED" };
    if (d.status === "DELIVERED") return { status: "ASSIGNED", delivery_phase: "DELIVERED" };
    if (d.picked_up_at) {
      const { state } = await new PickupService(this.container).locked(d.id, undefined,
        s => new HandoffService(this.container).presentation(s), true);
      if (state === "ATTENTION_REQUIRED") return { status: "ATTENTION_REQUIRED" };
      if (state === "IN_TRANSIT" || state === "ARRIVED" || state === "DELIVERED") return { status: "ASSIGNED", delivery_phase: state };
    }
    if (d.status !== "ASSIGNED") return { status: "FINDING_DRIVER", ...(actor === "merchant" && d.path ? { phase: d.path } : {}) };
    if (actor === "customer") return { status: "ASSIGNED" };
    const driver: { display_name: string; contact_phone: string } | undefined = await db("dispatch_commitment as c").join("driver_profile as p", "p.id", "c.driver_profile_id")
      .where({ "c.delivery_id": d.id, "c.status": "ASSIGNED" })
      .select("p.display_name", "p.contact_phone").first();
    const { pickup } = await new PickupService(this.container).presentation(d.id);
    return { status: "ASSIGNED", ...(pickup ? { pickup_state: pickup.state } : {}), ...(driver ? { driver: { name: driver.display_name, phone: driver.contact_phone } } : {}) };
  }
}
