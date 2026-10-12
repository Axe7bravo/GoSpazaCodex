import { randomUUID } from "node:crypto";
import type { MerchantOrderDecision } from "@gospaza/contracts";
import type { OrderDecisionAction } from "../modules/marketplace/order-operation-policy";
import { parseOrderDecision, isOrderDecisionReplay } from "../modules/marketplace/order-operation-policy";
import { databaseTime, lockSlots, releaseRejectedOrderCapacity } from "../modules/marketplace/delivery-reservation-repository";
import type { Capability } from "../modules/marketplace/team-policy";
import type { IOrderModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type { CustomerOrder, MerchantOrderList } from "@gospaza/contracts";
import type MarketplaceService from "../modules/marketplace/service";
import { requireCapability, resourceId } from "../modules/marketplace/team-policy";
import { completedOrderHandoff, orderListInput, orderParse, orderUnavailable } from "../modules/marketplace/order-operation-policy";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import { completedOrderCandidates, insertOrderOperation, readOrderHandoff, selectHandoff } from "../modules/marketplace/order-operation-repository";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { merchantOrderDTO, readOperationalOrder } from "./order-operation-native";
import type { OperationalDelivery } from "./order-operation-native";

const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found.");
export class OrderOperationsService {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private async materialize(trx: Knex.Transaction, handoff: CompletedOrderHandoff) {
    const order = await readOperationalOrder(this.container, handoff);
    const operation = await insertOrderOperation(trx, handoff);
    return { order, operation };
  }
  async ensure(orderId: string) {
    orderParse(resourceId, orderId);
    const initial = await readOrderHandoff(this.db, orderId);
    if (!initial) return null; // An early order.placed event is only a hint.
    return this.db.transaction(async (trx) => {
      await trx("merchant").where({ id: initial.merchant_id }).forUpdate().first();
      const handoff = await readOrderHandoff(trx, orderId);
      if (!handoff) return null;
      if (handoff.merchant_id !== initial.merchant_id) throw orderUnavailable();
      return (await this.materialize(trx, handoff)).operation;
    });
  }
  private async authorized<T>(identity: string, work: (trx: Knex.Transaction, tenant: Awaited<ReturnType<MarketplaceService["resolveTenant"]>>) => Promise<T>, capability: Capability = "MERCHANT_ORDER_VIEW") {
    const marketplace = this.container.resolve<MarketplaceService>("marketplace");
    const initial = await marketplace.resolveTenant(identity);
    return this.db.transaction(async (trx) => {
      await trx("merchant").where({ id: initial.merchant.id }).forUpdate().first();
      const tenant = await marketplace.resolveTenant(identity, trx);
      if (tenant.merchant.id !== initial.merchant.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant context changed.");
      requireCapability(tenant.membership.member_type, capability);
      return work(trx, tenant);
    });
  }
  private async projection(trx: Knex.Transaction, handoff: CompletedOrderHandoff) {
    const { order, operation } = await this.materialize(trx, handoff);
    const delivery = await trx<OperationalDelivery>("delivery_slot as slot")
      .join("merchant_store as store", "store.id", "slot.merchant_store_id")
      .where({ "slot.id": handoff.slot_id, "store.id": handoff.merchant_store_id, "store.merchant_id": handoff.merchant_id })
      .select("slot.start_at", "slot.end_at", "store.name", "store.address_line_1", "store.address_line_2", "store.city", "store.province", "store.postal_code", "store.country_code").first();
    if (!delivery) throw orderUnavailable();
    return merchantOrderDTO(order, operation, delivery);
  }
  async detail(identity: string, orderId: string) {
    orderParse(resourceId, orderId);
    return this.authorized(identity, async (trx, tenant) => {
      // Tenant predicate precedes native reads and any insert.
      const handoff = await readOrderHandoff(trx, orderId, tenant);
      if (!handoff) throw missing();
      return this.projection(trx, handoff);
    });
  }
  async customerDetail(customerId: string, orderId: string): Promise<CustomerOrder> {
    orderParse(resourceId, orderId);
    // Scope the native lookup before reading/provisioning operational evidence.
    const native = this.container.resolve<IOrderModuleService>(Modules.ORDER);
    const owned = await native.listOrders({ id: orderId, customer_id: customerId }, { select: ["id"], take: 1 });
    if (!owned.length) throw missing();
    const initial = await readOrderHandoff(this.db, orderId);
    if (!initial || initial.snapshot.customer_id !== customerId) throw missing();
    return this.db.transaction(async (trx) => {
      await trx("merchant").where({ id: initial.merchant_id }).forUpdate().first();
      const handoff = await readOrderHandoff(trx, orderId);
      if (!handoff || handoff.snapshot.customer_id !== customerId || handoff.merchant_id !== initial.merchant_id) throw missing();
      // Existing native readback also validates native customer against this snapshot.
      const order = await this.projection(trx, handoff);
      return {
        id: order.id, display_id: order.display_id, created_at: order.created_at,
        operational_status: order.operational_status, currency_code: order.currency_code,
        items: order.items, totals: order.totals, delivery: order.delivery,
        store: { name: order.pickup.store_name },
      };
    });
  }
  async list(identity: string, input: unknown): Promise<MerchantOrderList> {
    const filter = orderParse(orderListInput, input);
    return this.authorized(identity, async (trx, tenant) => {
      const query = completedOrderCandidates(trx, tenant)
        .leftJoin("order_operation as op", "op.checkout_completion_id", "c.id");
      if (filter.status) query.whereRaw("coalesce(op.status, 'PENDING_ACCEPTANCE') = ?", [filter.status]);
      const count = await query.clone().count<{ count: string }>("c.id as count").first();
      const candidates: unknown[] = await selectHandoff(query)
        .orderByRaw("case when coalesce(op.status, 'PENDING_ACCEPTANCE') = 'PENDING_ACCEPTANCE' then 0 else 1 end")
        .orderBy("c.created_at", "desc").orderBy("c.id").limit(filter.limit).offset(filter.offset);
      const orders = [];
      for (const row of candidates) orders.push(await this.projection(trx, completedOrderHandoff(row)));
      return { orders, count: Number(count?.count ?? 0), limit: filter.limit, offset: filter.offset };
    });
  }

  async decide(identity: string, orderId: string, action: OrderDecisionAction, value: unknown): Promise<MerchantOrderDecision> {
    orderParse(resourceId, orderId);
    const input = parseOrderDecision(action, value);
    return this.authorized(identity, async (trx, tenant) => {
      const handoff = await readOrderHandoff(trx, orderId, tenant);
      if (!handoff) throw missing();
      // Read-time provisioning uses the same successful-checkout admission.
      await insertOrderOperation(trx, handoff);
      const operation = await trx<OrderOperationRow>("order_operation").where({
        medusa_order_id: orderId, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id,
      }).whereNull("deleted_at").forUpdate().first();
      if (!operation) throw missing();
      const result = (row: OrderOperationRow): MerchantOrderDecision => ({
        id: row.medusa_order_id, operational_status: row.status, revision: row.revision,
        accepted_at: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        rejected_at: row.rejected_at ? new Date(row.rejected_at).toISOString() : null,
        rejection_reason: row.rejection_reason,
      });
      if (isOrderDecisionReplay(operation, action, input)) return result(operation);
      // Validate before any transition; native cancellation is deliberately not used.
      await readOperationalOrder(this.container, handoff);
      await lockSlots(trx, [handoff.slot_id]);
      const now = await databaseTime(trx);
      const status = action === "accept" ? "ACCEPTED" : "REJECTED";
      const [decided] = await trx<OrderOperationRow>("order_operation").where({ id: operation.id }).update({
        status, revision: 1, accepted_at: action === "accept" ? now : null,
        rejected_at: action === "reject" ? now : null, rejection_reason: input.reason,
        decided_by_member_id: tenant.membership.id, updated_at: now,
      }).returning("*");
      if (!decided) throw orderUnavailable();
      await trx("order_decision_event").insert({
        id: "odevt_" + randomUUID(), order_operation_id: operation.id,
        merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id,
        decided_by_member_id: tenant.membership.id, from_status: "PENDING_ACCEPTANCE",
        to_status: status, reason: input.reason, decided_at: now, created_at: now, updated_at: now,
      });
      if (action === "reject") {
        await releaseRejectedOrderCapacity(trx, {
          reservationId: handoff.reservation_id, orderId, storeId: tenant.store.id,
        }, now);
      }
      return result(decided);
    }, "MERCHANT_ORDER_DECIDE");
  }

  async repairBatch(): Promise<{ examined: number; deferred: number }> {
    // Fixed-size durable keyset cursor. One poisoned candidate cannot starve
    // later receipts. Wrapping on an empty page revisits early/failed records.
    return this.db.transaction(async (cursorTrx) => {
      const cursor = await cursorTrx<{ last_completion_id: string | null }>("order_operation_repair_cursor")
        .where({ id: "completed-orders" }).forUpdate().skipLocked().first();
      if (!cursor) return { examined: 0, deferred: 0 };
      const query = completedOrderCandidates(cursorTrx)
        .whereNotExists(cursorTrx("order_operation").select("id").whereRaw("checkout_completion_id = c.id"));
      if (cursor.last_completion_id) query.where("c.id", ">", cursor.last_completion_id);
      const values: unknown[] = await query.select("c.id", "c.order_id").orderBy("c.id").limit(50);
      const rows = z.array(z.object({ id: z.string(), order_id: z.string() })).parse(values);
      let deferred = 0;
      for (const row of rows) {
        try { if (!await this.ensure(row.order_id)) deferred++; }
        catch { deferred++; } // Retained receipt will be revisited next sweep.
      }
      await cursorTrx("order_operation_repair_cursor").where({ id: "completed-orders" })
        .update({ last_completion_id: rows.at(-1)?.id ?? null });
      return { examined: rows.length, deferred };
    });
  }
}
