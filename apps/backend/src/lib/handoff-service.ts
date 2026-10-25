import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { HandoffDTO, HandoffCodeDTO } from "@gospaza/contracts";
import { PickupService, type PickupScope } from "./pickup-service";
import { NativePickup } from "./pickup-native";
import { NativeHandoff } from "./handoff-native";
import { DriverService } from "../modules/marketplace/driver-service";
import { RedisDispatchLocations } from "./dispatch-location";
import { dispatchPolicy } from "../modules/marketplace/dispatch-policy";
import { OrderOperationsService } from "./order-operations-service";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { dispatchMissing, dispatchParse } from "../modules/marketplace/dispatch-policy";
import type { DeliveryRow } from "../modules/marketplace/dispatch-rows";
import type { PickupOperation } from "../modules/marketplace/pickup-policy";
import { handoffCode, handoffCompliance, handoffError, handoffGuess, handoffNonce, handoffPolicy as policy,
  handoffRevision, handoffSecret, handoffKeyId, matchesHandoff, type DeliveryCompletion, type HandoffGeneration } from "../modules/marketplace/handoff-policy";

export class HandoffService {
  private readonly db: Knex;
  private readonly pickup: PickupService;
  private readonly native: NativeHandoff;
  constructor(private readonly container: MedusaContainer, native?: NativeHandoff, private readonly time: typeof databaseTime = databaseTime) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.pickup = new PickupService(container); this.native = native ?? new NativeHandoff(container);
  }
  private generations(s: PickupScope) { return s.trx<HandoffGeneration>("handoff_generation").where({ delivery_id: s.d.id }).orderBy("number").forUpdate(); }
  private operation(s: PickupScope) { return s.trx<DeliveryCompletion>("delivery_completion").where({ delivery_id: s.d.id }).forUpdate().first(); }
  private async throttle(s: PickupScope, scope: string) {
    const now = await this.time(s.trx);
    const row = await s.trx<{ started_at: Date; count: number }>("handoff_rate").where({ delivery_id: s.d.id, scope }).forUpdate().first();
    const fresh = row && now.getTime() - new Date(row.started_at).getTime() < 60000;
    if (fresh && row.count >= 60) throw handoffError("HANDOFF_RATE_LIMITED");
    await s.trx("handoff_rate").insert({ delivery_id: s.d.id, scope, started_at: fresh ? row.started_at : now, count: fresh ? row.count + 1 : 1 })
      .onConflict(["delivery_id", "scope"]).merge();
  }
  private async rate(id: string, identity: string | undefined, scope: string) {
    // Commit admission separately so a later stale revision/native-readback
    // rejection cannot roll the endpoint throttle back. Ownership is checked
    // before this transaction, and checked again by the mutation transaction.
    await this.pickup.locked(id, identity, async s => {
      if (scope === "driver-verify" && await this.operation(s)) return;
      await this.throttle(s, scope);
    }, true);
  }
  private async event(s: PickupScope, action: string, patch: Partial<DeliveryRow> = {}, actor = "system", customerId?: string) {
    const now = await this.time(s.trx), revision = s.d.revision + 1;
    await s.trx("delivery_operation").where({ id: s.d.id }).update({ ...patch, revision, updated_at: now });
    await s.trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: s.d.id,
      revision, action, actor_type: actor === "system" ? "system" : "driver", actor_id: actor === "system" ? null : s.c.driver_profile_id,
      occurred_at: now, evidence: JSON.stringify({ commitment_id: s.c.id, ...(customerId ? { customer_id: customerId } : {}) }) });
    Object.assign(s.d, patch, { revision });
  }
  private async shipment(s: PickupScope, validate = true) {
    if (s.d.status !== "ASSIGNED" || !s.d.picked_up_at || !s.d.native_fulfillment_id || s.c.status !== "ASSIGNED"
      || !s.e.eligible || s.e.affiliation_id !== s.c.affiliation_id || s.e.kind !== s.c.path) throw handoffError();
    const ops = await s.trx<PickupOperation>("pickup_operation").where({ delivery_id: s.d.id }).orderBy("action").forUpdate();
    const prepare = ops.find(o => o.action === "PREPARE"), ship = ops.find(o => o.action === "SHIP");
    if (!prepare || !ship || prepare.state !== "SUCCEEDED" || ship.state !== "SUCCEEDED"
      || ship.fulfillment_id !== s.d.native_fulfillment_id || ship.input.commitment_id !== s.c.id
      || ship.input.driver_profile_id !== s.c.driver_profile_id || ship.input.order_id !== s.d.medusa_order_id) throw handoffError();
    if (validate) await new NativePickup(this.container).validate(ship, prepare.id);
    return { ship, prepare };
  }
  private dto(s: PickupScope, op?: DeliveryCompletion): HandoffDTO {
    return { delivery_id: s.d.id, revision: s.d.revision,
      state: s.d.status === "DELIVERED" ? "DELIVERED" : s.d.status === "ATTENTION_REQUIRED" || op && op.state !== "SUCCEEDED" ? "ATTENTION_REQUIRED"
        : s.d.arrived_at ? "ARRIVED" : s.d.picked_up_at ? "IN_TRANSIT" : "UNAVAILABLE",
      arrived_at: s.d.arrived_at ? new Date(s.d.arrived_at).toISOString() : null,
      delivered_at: s.d.delivered_at ? new Date(s.d.delivered_at).toISOString() : null,
      compliance_required: handoffCompliance(s.d.restricted_content_present) === "REQUIRED" };
  }
  private async generate(s: PickupScope, previous: HandoffGeneration[], customerId?: string) {
    const secret = handoffSecret(), now = await this.time(s.trx), number = previous.length + 1;
    if (previous.some(g => g.key_id !== handoffKeyId(secret))) throw handoffError();
    if (number > policy.generations || s.d.handoff_failures >= policy.deliveryFailures) throw handoffError();
    // Even an accidental six-digit collision must not revive an old visible code.
    const oldCodes = previous.map(g => handoffCode(secret, s.d.id, g.nonce, g.number));
    let nonce = handoffNonce();
    while (oldCodes.includes(handoffCode(secret, s.d.id, nonce, number))) nonce = handoffNonce();
    await s.trx("handoff_generation").where({ delivery_id: s.d.id, state: "ACTIVE" }).update({ state: "SUPERSEDED", updated_at: now });
    await s.trx("handoff_generation").insert({ id: "hgen_" + randomUUID(), delivery_id: s.d.id, number, nonce, key_id: handoffKeyId(secret),
      state: "ACTIVE", failed_attempts: 0, created_at: now, expires_at: new Date(now.getTime() + policy.lifetimeMs) });
    await this.event(s, number === 1 ? "HANDOFF_GENERATED" : "HANDOFF_REGENERATED", {}, "system", customerId);
  }
  async arrive(identity: string, id: string, body: unknown) {
    const input = dispatchParse(handoffRevision, body);
    await this.pickup.locked(id, identity, async s => {
      if (s.d.arrived_at) return; // exact physical action replay never issues another code
      if (s.d.revision !== input.expected_revision) throw handoffError();
      await this.shipment(s);
      const previous = await this.generations(s); if (previous.length || await this.operation(s)) throw handoffError();
      await this.event(s, "ARRIVED", { arrived_at: await this.time(s.trx) }, "driver");
      await this.generate(s, previous);
    }, true);
    return this.read(identity, id);
  }
  async ownedDelivery(customer: string, orderId: string): Promise<string> {
    await new OrderOperationsService(this.container).customerDetail(customer, orderId);
    const d = await this.db<DeliveryRow>("delivery_operation").where({ medusa_order_id: orderId }).first();
    return d?.id ?? dispatchMissing();
  }
  async customerCode(customer: string, orderId: string, regenerate?: unknown): Promise<HandoffCodeDTO> {
    const id = await this.ownedDelivery(customer, orderId);
    const input = regenerate === undefined ? undefined : dispatchParse(handoffRevision, regenerate);
    await this.rate(id, undefined, "customer-code");
    return this.pickup.locked(id, undefined, async (s): Promise<HandoffCodeDTO> => {
      const rows = await this.generations(s), current = rows.at(-1), op = await this.operation(s);
      if (!s.d.arrived_at || s.d.status !== "ASSIGNED" || s.c.status !== "ASSIGNED" || op || !current)
        return { state: "UNAVAILABLE", code: null, expires_at: null, revision: s.d.revision };
      await this.shipment(s);
      const now = await this.time(s.trx);
      if (input) {
        if (s.d.revision !== input.expected_revision || rows.length >= policy.generations || s.d.handoff_failures >= policy.deliveryFailures
          || now.getTime() - new Date(current.created_at).getTime() < policy.cooldownMs) throw handoffError();
        await this.generate(s, rows, customer);
      }
      const active = input ? (await this.generations(s)).at(-1) : current;
      const regeneration = {
        can_regenerate: !!active && active.number < policy.generations && s.d.handoff_failures < policy.deliveryFailures
          && now.getTime() >= new Date(active.created_at).getTime() + policy.cooldownMs,
        regenerate_at: active && active.number < policy.generations ? new Date(new Date(active.created_at).getTime() + policy.cooldownMs).toISOString() : null,
        compliance_required: handoffCompliance(s.d.restricted_content_present) === "REQUIRED",
      };
      if (!active || active.state !== "ACTIVE" || now >= new Date(active.expires_at))
        return { ...regeneration, state: rows.length >= policy.generations ? "UNAVAILABLE" : "EXPIRED", code: null, expires_at: active ? new Date(active.expires_at).toISOString() : null, revision: s.d.revision };
      const secret = handoffSecret(); if (active.key_id !== handoffKeyId(secret)) throw handoffError();
      return { ...regeneration, state: "AVAILABLE", code: handoffCode(secret, id, active.nonce, active.number),
        expires_at: new Date(active.expires_at).toISOString(), revision: s.d.revision };
    }, true);
  }
  async verify(identity: string, id: string, body: unknown) {
    const input = dispatchParse(handoffGuess, body);
    await this.rate(id, identity, "driver-verify");
    const outcome = await this.pickup.locked(id, identity, async s => {
      const rows = await this.generations(s), current = rows.at(-1), existing = await this.operation(s);
      if (existing) return { operation: existing, dispatch: false }; // consumed authorization: readback only
      const { ship } = await this.shipment(s);
      if (!s.d.arrived_at || s.d.revision !== input.expected_revision) throw handoffError();
      if (handoffCompliance(s.d.restricted_content_present) !== "SATISFIED") return { error: "HANDOFF_COMPLIANCE_REQUIRED" };
      const now = await this.time(s.trx);
      if (!current || current.state !== "ACTIVE" || now >= new Date(current.expires_at)
        || current.failed_attempts >= policy.generationFailures || s.d.handoff_failures >= policy.deliveryFailures) return { error: "HANDOFF_UNAVAILABLE" };
      const secret = handoffSecret(); if (current.key_id !== handoffKeyId(secret)) throw handoffError();
      if (!matchesHandoff(handoffCode(secret, id, current.nonce, current.number), input.code)) {
        const failed = current.failed_attempts + 1, lifetime = s.d.handoff_failures + 1;
        await s.trx("handoff_generation").where({ id: current.id }).update({ failed_attempts: failed,
          state: failed === policy.generationFailures ? "EXHAUSTED" : "ACTIVE", updated_at: now });
        await this.event(s, lifetime === policy.deliveryFailures ? "HANDOFF_LIMIT_EXHAUSTED" : failed === policy.generationFailures ? "HANDOFF_GENERATION_EXHAUSTED" : "HANDOFF_GUESS_REJECTED",
          { handoff_failures: lifetime, ...(lifetime === policy.deliveryFailures ? { status: "ATTENTION_REQUIRED" as const, reason: "HANDOFF_LIMIT_EXHAUSTED" } : {}) }, "driver");
        return { error: "HANDOFF_UNAVAILABLE" }; // committed counters, error thrown outside transaction
      }
      await s.trx("handoff_generation").where({ id: current.id }).update({ state: "CONSUMED", updated_at: now });
      const operation: DeliveryCompletion = { id: "delop_" + randomUUID(), delivery_id: id, commitment_id: s.c.id,
        generation_id: current.id, ship_operation_id: ship.id, workflow_id: "mark-order-fulfillment-as-delivered-workflow",
        transaction_id: "gospaza-delivered-" + randomUUID(), state: "DISPATCHED", dispatched_at: now, receipt: null };
      await s.trx("delivery_completion").insert(operation);
      await this.event(s, "HANDOFF_VERIFIED", {}, "driver");
      await this.event(s, "DELIVERY_COMPLETION_DISPATCHED");
      return { operation, dispatch: true, ship };
    }, true);
    if ("error" in outcome) throw handoffError(outcome.error);
    if (outcome.dispatch && outcome.ship) {
      let done = false;
      try { done = await this.native.run(outcome.operation, outcome.ship) === "done"; } catch { /* never replay */ }
      if (done) await this.db("delivery_completion").where({ id: outcome.operation.id }).whereNot({ state: "SUCCEEDED" }).update({ native_done: true });
    }
    await this.observe(id);
    return this.read(identity, id);
  }
  async observe(id: string) {
    await this.pickup.locked(id, undefined, async s => {
      await this.generations(s); const op = await this.operation(s);
      if (!op || op.state === "SUCCEEDED") return;
      let receipt: DeliveryCompletion["receipt"] = null;
      try {
        const { ship, prepare } = await this.shipment(s, false);
        const saved = await s.trx<{ native_done: boolean }>("delivery_completion").where({ id: op.id }).first();
        if (saved?.native_done || await this.native.terminal(op)) receipt = await this.native.validate(ship, prepare.id);
      } catch { /* incompatible or unavailable native evidence retains capacity */ }
      if (!receipt) {
        if (op.state !== "RECOVERY_REQUIRED") {
          await s.trx("delivery_completion").where({ id: op.id }).update({ state: "RECOVERY_REQUIRED" });
          await this.event(s, "DELIVERY_COMPLETION_RECOVERY_REQUIRED");
        }
        return;
      }
      const now = await this.time(s.trx);
      await s.trx("delivery_completion").where({ id: op.id }).update({ state: "SUCCEEDED", native_done: true, receipt: JSON.stringify(receipt), updated_at: now });
      await s.trx("dispatch_commitment").where({ id: s.c.id, status: "ASSIGNED" }).update({ status: "COMPLETED", revision: s.c.revision + 1, updated_at: now });
      await this.event(s, "NATIVE_DELIVERED_PROVEN");
      await this.event(s, "DELIVERED", { status: "DELIVERED", delivered_at: now });
    }, true);
    // Terminal SQL state already revokes access. Cleanup is best effort and
    // generation-scoped; failure cannot reopen capacity or expose later trips.
    await this.pickup.locked(id, undefined, async s => {
      if (s.d.status === "DELIVERED" && s.d.tracking_generation)
        await new RedisDispatchLocations(dispatchPolicy(), "tracking").clear(s.c.id, s.d.tracking_generation);
    }, true);
  }
  async read(identity: string, id: string): Promise<HandoffDTO> {
    // Authenticate before attempting repair on a caller-supplied known ID.
    await this.pickup.locked(id, identity, async () => {}, true);
    await this.observe(id);
    return this.pickup.locked(id, identity, s => this.presentation(s), true);
  }
  /** Actor ownership must be established before entering this shared locked projection. */
  async presentation(s: PickupScope): Promise<HandoffDTO> {
      const generations = await this.generations(s), last = generations.at(-1), op = await this.operation(s);
      const result = this.dto(s, op);
      if (result.state === "ARRIVED" && last && generations.length >= policy.generations
        && (last.state !== "ACTIVE" || await this.time(s.trx) >= new Date(last.expires_at))) result.state = "ATTENTION_REQUIRED";
      if (result.state !== "DELIVERED" && (!s.e.eligible || s.e.affiliation_id !== s.c.affiliation_id)) result.state = "ATTENTION_REQUIRED";
      return result;
  }
  async latest(identity: string): Promise<{ handoff: HandoffDTO | null }> {
    const profile = await new DriverService(this.container).profileForIdentity(identity);
    const row = await this.db<{ delivery_id: string }>("dispatch_commitment")
      .where({ driver_profile_id: profile.id }).whereIn("status", ["ASSIGNED", "COMPLETED"])
      .orderByRaw("case when status='ASSIGNED' then 0 else 1 end").orderBy("updated_at", "desc").orderBy("id").first();
    return { handoff: row ? await this.read(identity, row.delivery_id) : null };
  }
  async runBatch() {
    const due = await this.db<DeliveryCompletion>("delivery_completion").whereNot({ state: "SUCCEEDED" })
      .where("next_due_at", "<=", this.db.raw("clock_timestamp()" )).orderBy("next_due_at").limit(25);
    for (const op of due) {
      await this.observe(op.delivery_id);
      await this.db("delivery_completion").where({ id: op.id }).whereNot({ state: "SUCCEEDED" })
        .update({ next_due_at: this.db.raw("clock_timestamp() + interval '60 seconds'") });
    }
  }
}
