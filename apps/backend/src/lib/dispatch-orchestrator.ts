import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { DispatchService } from "./dispatch-service";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import type { DeliveryRow } from "../modules/marketplace/dispatch-rows";

interface Work { delivery_id: string; scan_offset: number; observed_revision: number | null }
// This table schedules observations only. Delivery/commitment transactions remain
// the sole business authority; losing a worker never loses or releases capacity.
export class DispatchOrchestrator {
  private readonly db: Knex;
  private readonly dispatch: DispatchService;
  constructor(container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.dispatch = new DispatchService(container);
  }
  async ensure(orderId: string) {
    const delivery = await this.dispatch.ensure(orderId);
    await this.db("dispatch_work").insert({ delivery_id: delivery.id }).onConflict("delivery_id").ignore();
    return delivery;
  }
  async repair() {
    return this.db.transaction(async trx => {
      const cursor = await trx<{ last_id: string | null }>("dispatch_repair_cursor")
        .where({ id: "completed-picking" }).forUpdate().skipLocked().first();
      if (!cursor) return;
      // Bounded owner evidence discovery, not readiness authority. ensure() calls
      // the existing Picking/M10/native handoffs before creating a delivery.
      const query = trx("pick_session as p").join("order_operation as o", "o.id", "p.order_operation_id")
        .where({ "p.status": "COMPLETED", "o.status": "ACCEPTED" })
        .whereNull("p.deleted_at").whereNull("o.deleted_at");
      if (cursor.last_id) query.where("p.id", ">", cursor.last_id);
      const rows: { id: string; medusa_order_id: string }[] = await query
        .select("p.id", "o.medusa_order_id").orderBy("p.id").limit(25);
      for (const row of rows) {
        try { await this.ensure(row.medusa_order_id); }
        catch { /* Retained owner evidence is revisited after cursor wrap. */ }
      }
      await trx("dispatch_repair_cursor").where({ id: "completed-picking" })
        .update({ last_id: rows.at(-1)?.id ?? null });
    });
  }
  async runBatch(deliveryIds?: string[]) {
    if (!deliveryIds) await this.repair();
    let processed = 0;
    for (let i = 0; i < 25; i++) {
      const found = await this.db.transaction(async trx => {
        const query = trx<Work>("dispatch_work").where("next_due_at", "<=", trx.raw("clock_timestamp()"));
        if (deliveryIds) query.whereIn("delivery_id", deliveryIds);
        const work = await query
          .orderBy("next_due_at").orderBy("delivery_id").forUpdate().skipLocked().first();
        if (!work) return false;
        try {
          const result = await this.pass(work);
          await trx("dispatch_work").where({ delivery_id: work.delivery_id }).update(result);
        } catch {
          // No exception/provider payload is persisted. Re-observe the same
          // durable generation, never replay a driver decision or release.
          const now = await databaseTime(trx);
          await trx("dispatch_work").where({ delivery_id: work.delivery_id })
            .update({ next_due_at: new Date(now.getTime() + 5000), last_error: "OBSERVATION_DEFERRED" });
        }
        return true;
      });
      if (!found) break;
      processed++;
    }
    return { processed };
  }
  private async pass(work: Work) {
    let d = await this.dispatch.reconcile(work.delivery_id);
    d = await this.dispatch.preflight(d.id);
    if (d.status === "PENDING_DISPATCH") {
      // start() uses fresh database time and owns the scheduled boundary.
      try { d = await this.dispatch.start(d.id); }
      catch (error) {
        if (!MedusaError.isMedusaError(error)) throw error;
        return this.schedule(d, 0);
      }
    }
    d = await this.dispatch.advance(d.id, false);
    let offset = work.observed_revision === d.revision ? work.scan_offset : 0;
    // Bound per-record work. A partial page scan is never pool exhaustion.
    for (let page = 0; page < 4 && d.status === "SEARCHING"; page++) {
      const result = await this.dispatch.candidatePage(d.id, offset);
      for (const candidate of result.candidates) {
        try {
          await this.dispatch.offer(d.id, candidate);
          return this.schedule(await this.dispatch.reconcile(d.id), 0);
        } catch (error) {
          if (!MedusaError.isMedusaError(error)) throw error;
          // Discovery can lose to another commitment; observe current state.
          const current = await this.dispatch.reconcile(d.id);
          if (current.revision !== d.revision) return this.schedule(current, 0);
        }
      }
      if (result.next_offset === null) {
        d = await this.dispatch.advance(d.id, true, d.revision);
        offset = 0;
      } else {
        offset = result.next_offset;
        if (offset > 10000) return this.schedule(d, 0);
      }
    }
    return this.schedule(d, offset);
  }
  private async schedule(d: DeliveryRow, offset: number) {
    const now = await this.db.transaction(databaseTime);
    let due = new Date(now.getTime() + 5000);
    if (d.status === "ATTENTION_REQUIRED" || d.status === "DELIVERED") due = new Date("9999-01-01T00:00:00Z");
    else if (d.status === "ASSIGNED") due = new Date(now.getTime() + 60000);
    else if (d.status === "PENDING_DISPATCH" && d.dispatch_not_before && new Date(d.dispatch_not_before) > now)
      due = new Date(d.dispatch_not_before);
    return { next_due_at: due, observed_revision: d.revision, scan_offset: offset, last_error: null };
  }
}
