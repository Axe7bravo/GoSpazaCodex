import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { DriverPickupDTO } from "@gospaza/contracts";
import { DriverService } from "../modules/marketplace/driver-service";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { dispatchMissing, dispatchParse, dispatchPolicy } from "../modules/marketplace/dispatch-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import type { CommitmentRow, DeliveryRow } from "../modules/marketplace/dispatch-rows";
import { physicalManifest, pickupCommand, pickupConflict, pickupFingerprint, pickupInput } from "../modules/marketplace/pickup-policy";
import type { PickupOperation, PickupInput } from "../modules/marketplace/pickup-policy";
import { dispatchReadiness } from "./dispatch-readiness";
import { NativePickup } from "./pickup-native";
import type { PickupNative } from "./pickup-native";

type Eligibility = Awaited<ReturnType<DriverService["eligibility"]>>;
export type PickupScope = { trx: Knex.Transaction; d: DeliveryRow; c: CommitmentRow; e: Eligibility };
type Scope = PickupScope;
export class PickupService {
  private readonly db: Knex;
  private readonly drivers: DriverService;
  private readonly native: PickupNative;
  constructor(private readonly container: MedusaContainer, native?: PickupNative) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.drivers = new DriverService(container); this.native = native ?? new NativePickup(container);
  }
  async locked<T>(id: string, identity: string | undefined, work: (s: Scope) => Promise<T>, includeCompleted = false) {
    dispatchParse(resourceId, id);
    const actor = identity ? await this.drivers.profileForIdentity(identity) : null;
    const observed = await this.db<DeliveryRow>("delivery_operation").where({ id }).first();
    const statuses = includeCompleted ? ["ASSIGNED", "COMPLETED", "RETURNED"] : ["ASSIGNED"];
    const assigned = await this.db<CommitmentRow>("dispatch_commitment").where({ delivery_id: id }).whereIn("status", statuses).first();
    if (!observed || !assigned || actor && actor.id !== assigned.driver_profile_id) return dispatchMissing();
    return this.drivers.withEligibility(assigned.driver_profile_id, observed.merchant_store_id, async (trx, e) => {
      // Same prefix as M15: merchant -> profile -> affiliation -> availability -> order -> picking -> delivery -> commitment.
      await trx("driver_availability").where({ driver_profile_id: assigned.driver_profile_id }).forUpdate().first();
      await trx("order_operation").where({ id: observed.order_operation_id }).forUpdate().first();
      await trx("pick_session").where({ id: observed.pick_session_id }).forUpdate().first();
      const d = await trx<DeliveryRow>("delivery_operation").where({ id }).forUpdate().first();
      const c = await trx<CommitmentRow>("dispatch_commitment").where({ id: assigned.id }).whereIn("status", statuses).forUpdate().first();
      if (!d || !c || c.delivery_id !== d.id || c.driver_profile_id !== e.profile_id) return dispatchMissing();
      return work({ trx, d, c, e });
    });
  }
  private operations(trx: Knex.Transaction, id: string) {
    return trx<PickupOperation>("pickup_operation").where({ delivery_id: id }).orderBy("action").forUpdate();
  }
  private async change(s: Scope, patch: Partial<DeliveryRow>, action: string, operationId?: string, driver = false) {
    const now = await databaseTime(s.trx), revision = s.d.revision + 1;
    await s.trx("delivery_operation").where({ id: s.d.id }).update({ ...patch, revision, updated_at: now });
    await s.trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: s.d.id, revision,
      action, actor_type: driver ? "driver" : "system", actor_id: driver ? s.c.driver_profile_id : null, occurred_at: now,
      evidence: JSON.stringify({ ...(operationId ? { operation_id: operationId } : {}), commitment_id: s.c.id }) });
    Object.assign(s.d, patch, { revision });
  }
  private async attention(s: Scope, reason: string) {
    if (s.d.status !== "ATTENTION_REQUIRED") await this.change(s, { pickup_managed: true, status: "ATTENTION_REQUIRED", reason }, "PICKUP_ATTENTION");
  }
  // One business predicate for preparation, pickup and finalization. Native side-effect
  // readback belongs to the adapter, not a second picking/accounting implementation.
  async evaluatePickupReadiness(s: Scope, fulfillmentId = s.d.native_fulfillment_id) {
    const { trx, d, c, e } = s;
    if (d.status !== "ASSIGNED" || d.picked_up_at || !e.eligible || e.affiliation_id !== c.affiliation_id || e.kind !== c.path
      || !await this.drivers.activeStore(d.merchant_store_id, trx)) throw pickupConflict();
    const ready = await dispatchReadiness(this.container, trx, d, dispatchPolicy(), fulfillmentId ?? undefined);
    if (!ready.config || ready.config.mode === "DISABLED" || ready.zone.id !== d.service_zone_id) throw pickupConflict();
    const state = ready.picking;
    if (state.session.id !== d.pick_session_id || state.operation.id !== d.order_operation_id || state.handoff.reservation_id !== d.reservation_id) throw pickupConflict();
    const store = await trx<{ medusa_stock_location_id: string | null }>("merchant_store").where({ id: d.merchant_store_id, merchant_id: d.merchant_id }).first();
    if (!store?.medusa_stock_location_id) throw pickupConflict();
    return { items: physicalManifest(state.physical), location_id: store.medusa_stock_location_id,
      shipping_option_id: state.handoff.snapshot.shipping_option_id, picking_fingerprint: state.session.source_lines_fingerprint,
      financial_review_required: state.financial_review_required };
  }
  private dto(s: Scope, ops: PickupOperation[], ready = false): DriverPickupDTO {
    const ship = ops.find(o => o.action === "SHIP");
    return { delivery_id: s.d.id, revision: s.d.revision, restricted_content_present: s.d.restricted_content_present,
      picked_up_at: s.d.picked_up_at ? new Date(s.d.picked_up_at).toISOString() : null,
      state: s.d.status === "ATTENTION_REQUIRED" || ops.some(o => o.state === "RECOVERY_REQUIRED") ? "ATTENTION_REQUIRED"
        : s.d.picked_up_at ? "IN_TRANSIT" : ship ? "PICKUP_PENDING" : ready ? "PICKUP_READY" : "PREPARING" };
  }
  private async designate(s: Scope, action: PickupOperation["action"], input: PickupInput) {
    const id = "pkop_" + randomUUID();
    const [row] = await s.trx<PickupOperation>("pickup_operation").insert({ id, delivery_id: s.d.id, action, state: "DISPATCHED",
      workflow_id: action === "PREPARE" ? "create-order-fulfillment" : "create-order-shipment", transaction_id: "gospaza-" + id,
      input: s.trx.raw("?::jsonb", [JSON.stringify(input)]), input_fingerprint: pickupFingerprint(input), dispatched_at: await databaseTime(s.trx) }).returning("*");
    if (!row) throw pickupConflict();
    await this.change(s, { pickup_managed: true }, action === "PREPARE" ? "FULFILLMENT_DISPATCHED" : "PICKUP_REQUESTED", id, action === "SHIP");
    return row;
  }
  async prepare(id: string) {
    const claimed = await this.locked(id, undefined, async s => {
      const ops = await this.operations(s.trx, id);
      if (ops.length || s.d.status !== "ASSIGNED" || s.d.picked_up_at) return null;
      try {
        const ready = await this.evaluatePickupReadiness(s);
        if (!ready.items.length) { await this.attention(s, "NO_PHYSICAL_ITEMS_TO_DELIVER"); return null; }
        const plan = await this.native.plan(s.d.medusa_order_id, ready.location_id, ready.items);
        return await this.designate(s, "PREPARE", { ...ready, ...plan, order_id: s.d.medusa_order_id, commitment_id: s.c.id,
          driver_profile_id: s.c.driver_profile_id, expected_revision: s.d.revision, fulfillment_id: null });
      } catch (error) {
        if (!MedusaError.isMedusaError(error)) throw error;
        await this.attention(s, "PICKUP_READINESS_LOST"); return null;
      }
    });
    if (claimed) await this.dispatch(claimed);
    else await this.observe(id);
  }
  private async dispatch(op: PickupOperation) {
    // The only native dispatch site. Claim is already committed; no catch path invokes again.
    let result: Awaited<ReturnType<PickupNative["run"]>> | null = null;
    try { result = await this.native.run(op); } catch { /* unknown is never permission to replay */ }
    const returned = result;
    if (returned) await this.locked(op.delivery_id, undefined, async s => {
      const current = (await this.operations(s.trx, op.delivery_id)).find(o => o.id === op.id);
      if (!current || current.state === "SUCCEEDED") return;
      await s.trx("pickup_operation").where({ id: op.id }).update({ native_state: returned.state, updated_at: await databaseTime(s.trx) });
    });
    await this.observe(op.delivery_id);
  }
  async observe(id: string) {
    if (await this.db("delivery_completion").where({ delivery_id: id }).first()) {
      const { HandoffService } = await import("./handoff-service.js");
      return new HandoffService(this.container).observe(id);
    }
    return this.locked(id, undefined, async s => {
      if (await s.trx("restricted_return").where({ delivery_id: id }).first()) return;
      const ops = await this.operations(s.trx, id), prepare = ops.find(o => o.action === "PREPARE"), ship = ops.find(o => o.action === "SHIP");
      const op = ship ?? prepare;
      if (!op) return;
      if (op.state === "SUCCEEDED") {
        // No return to dispatch readiness after fulfillment. In-flight exceptions
        // retain both physical pickup evidence and the occupied assignment.
        if (!s.e.eligible || s.e.affiliation_id !== s.c.affiliation_id) await this.attention(s, "PICKUP_DRIVER_REVIEW");
        if (s.d.picked_up_at) {
          try { await this.native.validate(op, prepare?.id ?? ""); }
          catch { await this.attention(s, "PICKUP_NATIVE_REVIEW"); }
        }
        if (!s.d.picked_up_at && s.d.status === "ASSIGNED") {
          try { await this.evaluatePickupReadiness(s); await this.native.validate(op, prepare?.id ?? ""); }
          catch { await this.attention(s, "PICKUP_READINESS_LOST"); }
        }
        return;
      }
      let evidence: Awaited<ReturnType<PickupNative["validate"]>> | null = null;
      let observed: Awaited<ReturnType<PickupNative["observe"]>> = null;
      try { observed = await this.native.observe(op); } catch { /* unavailable execution history is not permission */ }
      if (observed) await s.trx("pickup_operation").where({ id: op.id }).update({ native_state: observed.state,
        run_id: observed.run_id, execution_id: observed.execution_id, updated_at: await databaseTime(s.trx) });
      if (observed?.state === "done" && prepare) {
        try { evidence = await this.native.validate(op, prepare.id); } catch { /* incomplete readback stays fail closed */ }
      }
      if (!evidence) {
        if (op.state !== "RECOVERY_REQUIRED") {
          await s.trx("pickup_operation").where({ id: op.id }).update({ state: "RECOVERY_REQUIRED", updated_at: await databaseTime(s.trx) });
          await this.change(s, {}, "PICKUP_RECOVERY_REQUIRED", op.id);
        }
        return;
      }
      // Native completion can be recorded even if eligibility changed during the
      // call. It never creates permission to publish pickup after invalidation.
      let valid = true;
      try { await this.evaluatePickupReadiness(s, evidence.fulfillment_id); } catch { valid = false; }
      await s.trx("pickup_operation").where({ id: op.id }).update({ state: "SUCCEEDED", native_state: "done",
        fulfillment_id: evidence.fulfillment_id, terminal_receipt: JSON.stringify(evidence), updated_at: await databaseTime(s.trx) });
      // M15 attention is irreversible. Retain native evidence on the operation
      // without rewriting the terminal Delivery or claiming physical pickup.
      if (s.d.status === "ATTENTION_REQUIRED") return;
      if (op.action === "PREPARE") await this.change(s, { native_fulfillment_id: evidence.fulfillment_id }, "FULFILLMENT_PREPARED", op.id);
      else if (valid) await this.change(s, { picked_up_at: await databaseTime(s.trx) }, "PICKED_UP", op.id, true);
      else await this.change(s, {}, "NATIVE_SHIPMENT_OBSERVED", op.id);
      if (!valid) await this.attention(s, "PICKUP_READINESS_LOST");
    });
  }
  async read(identity: string, id?: string): Promise<{ pickup: DriverPickupDTO | null }> {
    const profile = await this.drivers.profileForIdentity(identity);
    const current = await this.db<CommitmentRow>("dispatch_commitment").where({ driver_profile_id: profile.id, status: "ASSIGNED", ...(id ? { delivery_id: dispatchParse(resourceId,id) } : {}) }).first();
    if (!current) { if (id) return dispatchMissing(); return { pickup: null }; }
    return this.presentation(current.delivery_id, identity);
  }
  // Internal presentation contract. HTTP callers must establish actor ownership
  // first; this shares the same readiness predicate as the driver read.
  async presentation(id: string, identity?: string): Promise<{ pickup: DriverPickupDTO | null }> {
    await this.observe(id);
    return this.locked(id, identity, async s => {
      // Completion can win during observation. A completed commitment is no
      // longer a current pickup, but its historical ownership remains intact.
      if (s.c.status === "COMPLETED" || s.c.status === "RETURNED") return { pickup: null };
      const ops = await this.operations(s.trx, s.d.id), prepare = ops.find(o => o.action === "PREPARE");
      let ready = false;
      if (!s.d.picked_up_at && !ops.some(o => o.action === "SHIP") && prepare?.state === "SUCCEEDED" && s.d.status === "ASSIGNED") {
        try { await this.evaluatePickupReadiness(s); await this.native.validate(prepare, prepare.id); ready = true; }
        catch { await this.attention(s, "PICKUP_READINESS_LOST"); }
      }
      return { pickup: this.dto(s, ops, ready) };
    }, true);
  }
  async pickup(identity: string, id: string, body: unknown) {
    const input = dispatchParse(pickupCommand, body);
    const outcome = await this.locked(id, identity, async s => {
      const ops = await this.operations(s.trx, id), prepare = ops.find(o => o.action === "PREPARE"), ship = ops.find(o => o.action === "SHIP");
      if (ship) {
        if (ship.input.expected_revision !== input.expected_revision) return { conflict: true };
        return { claimed: null }; // restore original result, never run again
      }
      if (s.d.revision !== input.expected_revision || s.d.status !== "ASSIGNED" || !prepare || prepare.state !== "SUCCEEDED" || !s.d.native_fulfillment_id) return { conflict: true };
      try {
        const ready = await this.evaluatePickupReadiness(s);
        if (pickupFingerprint(ready.items) !== pickupFingerprint(prepare.input.items) || ready.picking_fingerprint !== prepare.input.picking_fingerprint) throw pickupConflict();
        await this.native.validate(prepare, prepare.id);
        return { claimed: await this.designate(s, "SHIP", { ...pickupInput.parse(prepare.input), fulfillment_id: s.d.native_fulfillment_id, expected_revision: input.expected_revision }) };
      } catch (error) {
        if (!MedusaError.isMedusaError(error)) throw error;
        await this.attention(s, "PICKUP_READINESS_LOST"); return { conflict: true };
      }
    });
    if ("conflict" in outcome) throw pickupConflict();
    if (outcome.claimed) await this.dispatch(outcome.claimed);
    return this.read(identity, id);
  }
  async runBatch() {
    // Bounded repair uses the same prepare/observe paths. No transient event is required.
    const ids: { id: string }[] = await this.db("delivery_operation as d").where({ "d.status": "ASSIGNED" })
      .whereNotExists(this.db("pickup_work as w").select("delivery_id").whereRaw("w.delivery_id=d.id")).orderBy("d.id").limit(25).select("d.id");
    for (const row of ids) await this.db("pickup_work").insert({ delivery_id: row.id }).onConflict("delivery_id").ignore();
    for (let i = 0; i < 25; i++) {
      const found = await this.db.transaction(async trx => {
        const work = await trx<{ delivery_id: string }>("pickup_work").where("next_due_at","<=",trx.raw("clock_timestamp()"))
          .orderBy("next_due_at").forUpdate().skipLocked().first();
        if (!work) return false;
        try { await this.prepare(work.delivery_id); } catch { /* next pass observes durable state; no blind dispatch */ }
        await trx("pickup_work").where({ delivery_id: work.delivery_id }).update({ next_due_at: new Date((await databaseTime(trx)).getTime() + 60000) });
        return true;
      });
      if (!found) break;
    }
  }
}
