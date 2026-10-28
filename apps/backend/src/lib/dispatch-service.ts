import { randomUUID } from "node:crypto";
import type { MedusaContainer, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { DispatchConfiguration, DriverAvailabilityDTO, DriverCommitmentDTO } from "@gospaza/contracts";
import { DriverService } from "../modules/marketplace/driver-service";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { resourceId } from "../modules/marketplace/team-policy";
import { geometryService } from "../modules/marketplace/location-policy";
import { dispatchConfigurationInput, dispatchConflict, dispatchLocationInput, dispatchMissing, dispatchParse,
  dispatchPolicy, dispatchRevision, dispatchTimeReady, initialPath, locationFresh, offerExpiry, pathAllowed } from "../modules/marketplace/dispatch-policy";
import type { DispatchPolicy } from "../modules/marketplace/dispatch-policy";
import type { AvailabilityRow, CommitmentRow, DeliveryRow, DispatchConfigRow } from "../modules/marketplace/dispatch-rows";
import { RedisDispatchLocations } from "./dispatch-location";
import type { DispatchLocations } from "./dispatch-location";
import { dispatchReadiness } from "./dispatch-readiness";
import { PickupService } from "./pickup-service";

type Eligibility = Awaited<ReturnType<DriverService["eligibility"]>>;
type Ready = Awaited<ReturnType<typeof dispatchReadiness>>;
type Actor = { type: "driver" | "user" | "system"; id: string | null };
const system: Actor = { type: "system", id: null };
const active = ["OFFERED", "ASSIGNED"];
const iso = (d: Date | null) => d ? new Date(d).toISOString() : null;
export class DispatchService {
  private readonly db: Knex;
  private readonly drivers: DriverService;
  private readonly locations: DispatchLocations;
  constructor(private readonly container: MedusaContainer, readonly policy: DispatchPolicy = dispatchPolicy(), locations?: DispatchLocations) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.drivers = new DriverService(container);
    this.locations = locations ?? new RedisDispatchLocations(policy);
  }
  private async audit(trx: Knex.Transaction, type: "DELIVERY" | "AVAILABILITY" | "CONFIGURATION", id: string,
    revision: number, action: string, actor: Actor, evidence: Record<string, unknown> = {}) {
    await trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: type, target_id: id, revision, action,
      actor_type: actor.type, actor_id: actor.id, occurred_at: await databaseTime(trx), evidence: JSON.stringify(evidence) });
  }
  private async store(id: string) {
    dispatchParse(resourceId, id);
    const s = await this.db<{ id: string; merchant_id: string }>("merchant_store").where({ id }).whereNull("deleted_at").first();
    return s ?? dispatchMissing();
  }
  private async user(id: string) {
    if (!id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform authentication required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(id);
  }
  async configuration(user: string, storeId: string): Promise<DispatchConfiguration> {
    await this.user(user); await this.store(storeId);
    const row = await this.db<DispatchConfigRow>("store_dispatch_configuration").where({ merchant_store_id: storeId }).first();
    return { mode: row?.mode ?? "DISABLED", revision: row?.revision ?? 0 };
  }
  async configure(user: string, storeId: string, body: unknown): Promise<DispatchConfiguration> {
    const input = dispatchParse(dispatchConfigurationInput, body);
    await this.user(user); const store = await this.store(storeId);
    return this.db.transaction(async trx => {
      await trx("merchant").where({ id: store.merchant_id }).forUpdate().first();
      await this.user(user);
      const row = await trx<DispatchConfigRow>("store_dispatch_configuration").where({ merchant_store_id: storeId }).forUpdate().first();
      if ((row?.revision ?? 0) !== input.expected_revision) return dispatchConflict();
      const revision = (row?.revision ?? 0) + 1, id = row?.id ?? "dcfg_" + randomUUID();
      if (row) await trx("store_dispatch_configuration").where({ id }).update({ mode: input.mode, revision, updated_at: await databaseTime(trx) });
      else await trx("store_dispatch_configuration").insert({ id, merchant_store_id: storeId, mode: input.mode, revision });
      await this.audit(trx, "CONFIGURATION", id, revision, "CONFIGURED", { type: "user", id: user },
        { store_id: storeId, previous: row?.mode ?? "DISABLED", mode: input.mode, reason: input.reason });
      return { mode: input.mode, revision };
    });
  }
  private commitment(db: Knex, profile: string) {
    return db<CommitmentRow>("dispatch_commitment").where({ driver_profile_id: profile }).whereIn("status", active).first();
  }
  private async availability(trx: Knex.Transaction, profile: string) {
    return trx<AvailabilityRow>("driver_availability").where({ driver_profile_id: profile }).forUpdate().first();
  }
  private matches(a: AvailabilityRow | undefined, e: Eligibility) {
    return !!a && a.intent === "ONLINE" && e.eligible && a.profile_revision === e.profile_revision
      && a.affiliation_id === e.affiliation_id && a.affiliation_revision === e.affiliation_revision;
  }
  private async own<T>(identity: string, work: (trx: Knex.Transaction, e: Eligibility, a: AvailabilityRow | undefined, c: CommitmentRow | undefined) => Promise<T>) {
    const p = await this.drivers.profileForIdentity(identity);
    const observed = await this.commitment(this.db, p.id);
    const delivery = observed ? await this.db<DeliveryRow>("delivery_operation").where({ id: observed.delivery_id }).first() : undefined;
    return this.drivers.withEligibility(p.id, delivery?.merchant_store_id, async (trx, e) => {
      const a = await this.availability(trx, p.id), c = await this.commitment(trx, p.id);
      // Never acquire a newly discovered target merchant after the driver lock.
      if ((observed?.id ?? null) !== (c?.id ?? null)) return dispatchConflict();
      return work(trx, e, a, c);
    });
  }
  private async projection(trx: Knex.Transaction, e: Eligibility, a: AvailabilityRow | undefined, c: CommitmentRow | undefined): Promise<DriverAvailabilityDTO> {
    const sample = await this.locations.get(e.profile_id), now = await databaseTime(trx);
    const fresh = !!a?.generation && sample?.generation === a.generation && locationFresh(sample.received_at, now, this.policy);
    return { intent: a?.intent ?? "OFFLINE", revision: a?.revision ?? 0, generation: a?.generation ?? null,
      effective: c ? "BUSY" : a?.intent !== "ONLINE" ? "OFFLINE" : this.matches(a, e) && fresh ? "AVAILABLE" : "UNAVAILABLE",
      location_fresh: fresh, available_since: iso(a?.available_since ?? null),
      location_expires_at: fresh && sample
        ? new Date(sample.received_at + this.policy.freshnessMs).toISOString() : null,
      location_sequence: a?.generation ? (await this.locations.sequence?.(e.profile_id, a.generation) ?? sample?.sequence ?? 0) : 0 };
  }
  async readAvailability(identity: string) { return this.own(identity, (trx, e, a, c) => this.projection(trx, e, a, c)); }
  async intent(identity: string, online: boolean, body: unknown) {
    const input = dispatchParse(dispatchRevision, body);
    return this.own(identity, async (trx, e, a, c) => {
      if ((a?.revision ?? 0) !== input.expected_revision) return dispatchConflict();
      if (online && (!e.eligible || c?.status === "OFFERED")) return dispatchConflict("DISPATCH_UNAVAILABLE");
      const now = await databaseTime(trx);
      const recent = await trx("dispatch_event").where({ target_type: "AVAILABILITY", actor_id: e.profile_id })
        .whereIn("action", ["ONLINE","OFFLINE"]).where("occurred_at", ">", new Date(now.getTime() - 60000)).count<{ count: string }>("id as count").first();
      if (Number(recent?.count ?? 0) >= 20) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Too many availability changes.");
      if (!online && c?.status === "OFFERED") {
        const d = await this.lockDelivery(trx, c.delivery_id);
        await this.closeOffer(trx, d, c, "CANCELLED", "DRIVER_OFFLINE", { type: "driver", id: e.profile_id }, now);
      }
      const id = a?.id ?? "dav_" + randomUUID(), revision = (a?.revision ?? 0) + 1;
      const generation = online ? "dgen_" + randomUUID() : a?.generation ?? null;
      if (online && generation) await this.locations.begin(e.profile_id, generation);
      const patch = { intent: online ? "ONLINE" : "OFFLINE", revision, generation,
        available_since: online ? now : null, profile_revision: e.profile_revision, affiliation_id: e.affiliation_id,
        affiliation_revision: e.affiliation_revision, updated_at: now };
      if (a) await trx("driver_availability").where({ id }).update(patch);
      else await trx("driver_availability").insert({ id, driver_profile_id: e.profile_id, ...patch });
      await this.audit(trx, "AVAILABILITY", id, revision, online ? "ONLINE" : "OFFLINE", { type: "driver", id: e.profile_id });
      return this.projection(trx, e, await this.availability(trx, e.profile_id), await this.commitment(trx, e.profile_id));
    });
  }
  async location(identity: string, body: unknown) {
    const input = dispatchParse(dispatchLocationInput, body);
    return this.own(identity, async (trx, e, a, c) => {
      if (!a || !this.matches(a, e) || a.generation !== input.generation) return dispatchConflict("DISPATCH_LOCATION_STALE");
      const old = await this.locations.get(e.profile_id), now = await databaseTime(trx);
      await this.locations.put(e.profile_id, input, now);
      // Reset fairness after a freshness gap, not on every GPS update.
      if (!old || old.generation !== a.generation || !locationFresh(old.received_at, now, this.policy)) {
        await trx("driver_availability").where({ id: a.id }).update({ available_since: now, revision: a.revision + 1, updated_at: now });
        await this.audit(trx, "AVAILABILITY", a.id, a.revision + 1, "LOCATION_AVAILABLE", { type: "driver", id: e.profile_id });
      }
      return this.projection(trx, e, await this.availability(trx, e.profile_id), c);
    });
  }
  private async lockDelivery(trx: Knex.Transaction, id: string): Promise<DeliveryRow> {
    const observed = await trx<DeliveryRow>("delivery_operation").where({ id }).first();
    if (!observed) return dispatchMissing();
    await trx("order_operation").where({ id: observed.order_operation_id }).forUpdate().first();
    await trx("pick_session").where({ id: observed.pick_session_id }).forUpdate().first();
    const row = await trx<DeliveryRow>("delivery_operation").where({ id }).forUpdate().first();
    return row ?? dispatchMissing();
  }
  private async ready(trx: Knex.Transaction, d: DeliveryRow): Promise<Ready | null> {
    try { return await dispatchReadiness(this.container, trx, d, this.policy); }
    catch (error) {
      if (MedusaError.isMedusaError(error)) return null;
      throw error; // infrastructure/invalid unexpected data never creates permission
    }
  }
  private enabled(d: DeliveryRow, r: Ready | null, now: Date) {
    return !!r?.config && r.config.mode !== "DISABLED"
      && (d.generation === 0 || r.config.revision === d.configuration_revision && r.config.mode === d.mode)
      && dispatchTimeReady(r.notBefore, now) && r.zone.id === d.service_zone_id
      && !["ATTENTION_REQUIRED","ASSIGNED"].includes(d.status);
  }
  private async change(trx: Knex.Transaction, d: DeliveryRow, patch: Partial<DeliveryRow>, action: string, actor: Actor = system, evidence: Record<string, unknown> = {}) {
    const [row] = await trx<DeliveryRow>("delivery_operation").where({ id: d.id }).update({ ...patch, revision: d.revision + 1 }).returning("*");
    if (!row) return dispatchMissing();
    await this.audit(trx, "DELIVERY", d.id, row.revision, action, actor, { ...evidence, from: d.status, to: row.status });
    return row;
  }
  private async withDelivery<T>(id: string, profile: string | undefined, work: (trx: Knex.Transaction, d: DeliveryRow, e?: Eligibility) => Promise<T>): Promise<T> {
    dispatchParse(resourceId, id);
    const observed = await this.db<DeliveryRow>("delivery_operation").where({ id }).first();
    if (!observed) return dispatchMissing();
    if (profile) return this.drivers.withEligibility(profile, observed.merchant_store_id, async (trx, e) => {
      await this.availability(trx, profile);
      return work(trx, await this.lockDelivery(trx, id), e);
    });
    return this.db.transaction(async trx => {
      await trx("merchant").where({ id: observed.merchant_id }).forUpdate().first();
      return work(trx, await this.lockDelivery(trx, id));
    });
  }
  // Internal only: there is deliberately no HTTP dispatch/ensure/candidate endpoint.
  async ensure(orderId: string) {
    dispatchParse(resourceId, orderId);
    const op = await this.db<{ id: string; merchant_id: string; merchant_store_id: string }>("order_operation").where({ medusa_order_id: orderId }).whereNull("deleted_at").first();
    if (!op) return dispatchMissing();
    return this.db.transaction(async trx => {
      await trx("merchant").where({ id: op.merchant_id }).forUpdate().first();
      const existing = await trx<DeliveryRow>("delivery_operation").where({ medusa_order_id: orderId }).first();
      if (existing) return existing;
      const scope = { ...op, medusa_order_id: orderId };
      const r = await dispatchReadiness(this.container, trx, scope, this.policy);
      const [row] = await trx<DeliveryRow>("delivery_operation").insert({ id: "delivery_" + randomUUID(), order_operation_id: op.id,
        medusa_order_id: orderId, merchant_id: op.merchant_id, merchant_store_id: op.merchant_store_id,
        pick_session_id: r.session.id, reservation_id: r.hold.id, service_zone_id: r.zone.id,
        dispatch_not_before: r.notBefore, restricted_content_present: r.restricted }).returning("*");
      if (!row) return dispatchMissing();
      await this.audit(trx, "DELIVERY", row.id, 1, "CREATED", system);
      return row;
    });
  }
  async start(id: string) {
    return this.withDelivery(id, undefined, async (trx, d) => {
      if (d.status !== "PENDING_DISPATCH") return d; // no restart of an exhausted generation
      const r = await this.ready(trx, d), now = await databaseTime(trx);
      if (!this.enabled(d, r, now) || !r?.config) return dispatchConflict("DISPATCH_NOT_READY");
      const path = initialPath(r.config.mode);
      return this.change(trx, d, { status: "SEARCHING", generation: 1, mode: r.config.mode, configuration_revision: r.config.revision,
        path, started_at: now, deadline: new Date(now.getTime() + this.policy.searchMs),
        merchant_deadline: r.config.mode === "HYBRID" ? new Date(now.getTime() + Math.min(this.policy.merchantPhaseMs, this.policy.searchMs)) : null,
        offer_ms: this.policy.offerMs, dispatch_not_before: r.notBefore, restricted_content_present: d.restricted_content_present || r.restricted }, "SEARCH_STARTED");
    });
  }
  async preflight(id: string) {
    return this.withDelivery(id, undefined, async (trx, d) => {
      if (d.status !== "PENDING_DISPATCH") return d;
      const r = await this.ready(trx, d);
      if (!r || !r.config || r.config.mode === "DISABLED")
        return this.change(trx, d, { status: "ATTENTION_REQUIRED",
          reason: r ? "DISPATCH_CONFIGURATION_DISABLED" : "DELIVERY_NO_LONGER_DISPATCHABLE" }, "ATTENTION_REQUIRED");
      return d; // Scheduled waiting is not an operational failure.
    });
  }
  private async candidateIn(trx: Knex.Transaction, d: DeliveryRow, e: Eligibility, r: Ready | null, ownOffer?: CommitmentRow) {
    const a = await this.availability(trx, e.profile_id);
    if (!r || !d.path || !pathAllowed(d.mode, d.path) || e.kind !== d.path || !this.matches(a, e)) return false;
    if (ownOffer && (a?.generation !== ownOffer.availability_generation || e.affiliation_id !== ownOffer.affiliation_id
      || e.profile_revision !== ownOffer.profile_revision || e.affiliation_revision !== ownOffer.affiliation_revision)) return false;
    const c = await this.commitment(trx, e.profile_id);
    if (c && c.id !== ownOffer?.id) return false;
    const sample = await this.locations.get(e.profile_id);
    const freshNow = await databaseTime(trx);
    if (!sample || sample.generation !== a?.generation || !locationFresh(sample.received_at, freshNow, this.policy)) return false;
    return d.path === "MERCHANT" || geometryService.contains(r.zone.geometry, sample.latitude, sample.longitude);
  }
  // Bounded discovery only. C must scan pages to exhaustion before declaring a
  // pool empty, and offer() revalidates every selected candidate under locks.
  async candidatePage(id: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return dispatchConflict();
    const d = await this.db<DeliveryRow>("delivery_operation").where({ id }).first();
    if (!d || d.status !== "SEARCHING" || !d.path) return { candidates: [], next_offset: null };
    const rows: { driver_profile_id: string; available_since: Date }[] = await this.db("driver_availability as a")
      .join("driver_affiliation as f", "f.driver_profile_id", "a.driver_profile_id")
      .where({ "a.intent": "ONLINE", "f.status": "ACTIVE", "f.kind": d.path })
      .whereNull("f.deleted_at").whereNotNull("a.available_since")
      .whereNotExists(this.db("dispatch_commitment as c").select("c.id").whereRaw("c.driver_profile_id = a.driver_profile_id")
        .where(builder => builder.whereIn("c.status", active).orWhere({ "c.delivery_id": id, "c.generation": d.generation })))
      .orderBy("a.available_since").orderBy("a.driver_profile_id").limit(50).offset(offset)
      .select("a.driver_profile_id", "a.available_since");
    const candidates: string[] = [];
    for (const row of rows) if (await this.candidate(id, row.driver_profile_id)) candidates.push(row.driver_profile_id);
    return { candidates, next_offset: rows.length === 50 ? offset + 50 : null };
  }
  async candidate(id: string, profile: string) {
    return this.withDelivery(id, profile, async (trx, d, e) => {
      if (!e || d.status !== "SEARCHING") return false;
      const r = await this.ready(trx, d), now = await databaseTime(trx);
      return this.enabled(d, r, now) && !!d.deadline && now < new Date(d.deadline)
        && !(d.path === "MERCHANT" && d.merchant_deadline && now >= new Date(d.merchant_deadline))
        && !await trx("dispatch_commitment").where({ delivery_id: id, generation: d.generation, driver_profile_id: profile }).first()
        && await this.candidateIn(trx, d, e, r);
    });
  }
  async offer(id: string, profile: string) {
    return this.withDelivery(id, profile, async (trx, d, e) => {
      const previous = await trx<CommitmentRow>("dispatch_commitment").where({ delivery_id: id, generation: d.generation, driver_profile_id: profile }).first();
      if (previous) return previous; // history never becomes a new offer
      const r = await this.ready(trx, d), now = await databaseTime(trx);
      if (!e || d.status !== "SEARCHING" || !this.enabled(d, r, now) || !d.deadline || !d.path || !d.offer_ms
        || !await this.candidateIn(trx, d, e, r)) return dispatchConflict("DISPATCH_CANDIDATE_UNAVAILABLE");
      const fresh = await databaseTime(trx);
      const expires = offerExpiry(fresh, new Date(d.deadline), d.path === "MERCHANT" && d.merchant_deadline ? new Date(d.merchant_deadline) : null, d.offer_ms);
      if (expires <= fresh) return dispatchConflict("DISPATCH_EXPIRED");
      const a = await this.availability(trx, profile);
      if (!a?.generation || !e.affiliation_id || e.affiliation_revision === null) return dispatchConflict();
      const [c] = await trx<CommitmentRow>("dispatch_commitment").insert({ id: "dcommit_" + randomUUID(), delivery_id: id, driver_profile_id: profile,
        generation: d.generation, path: d.path, status: "OFFERED", availability_generation: a.generation,
        affiliation_id: e.affiliation_id, affiliation_revision: e.affiliation_revision, profile_revision: e.profile_revision, expires_at: expires }).returning("*");
      if (!c) return dispatchMissing();
      await this.change(trx, d, { status: "OFFERED", restricted_content_present: d.restricted_content_present || !!r?.restricted }, "OFFER_CREATED", system, { commitment_id: c.id, driver_profile_id: profile });
      return c;
    });
  }
  private async closeOffer(trx: Knex.Transaction, d: DeliveryRow, c: CommitmentRow, status: "DECLINED" | "EXPIRED" | "CANCELLED", reason: string, actor: Actor, now: Date, attention = false) {
    await trx("dispatch_commitment").where({ id: c.id, status: "OFFERED" }).update({ status, revision: c.revision + 1, decided_at: now, reason, updated_at: now });
    const availability = await this.availability(trx, c.driver_profile_id);
    if (availability?.intent === "ONLINE" && reason !== "DRIVER_OFFLINE") {
      await trx("driver_availability").where({ id: availability.id }).update({ available_since: now, revision: availability.revision + 1, updated_at: now });
      await this.audit(trx, "AVAILABILITY", availability.id, availability.revision + 1, "CAPACITY_AVAILABLE", system);
    }
    return this.change(trx, d, { status: attention || !d.deadline || now >= new Date(d.deadline) ? "ATTENTION_REQUIRED" : "SEARCHING", reason },
      status, actor, { commitment_id: c.id });
  }
  async decide(identity: string, id: string, action: "ACCEPT" | "DECLINE", body: unknown) {
    dispatchParse(resourceId, id); const input = dispatchParse(dispatchRevision, body);
    const p = await this.drivers.profileForIdentity(identity);
    const observed = await this.db<CommitmentRow>("dispatch_commitment").where({ id, driver_profile_id: p.id }).first();
    if (!observed) return dispatchMissing();
    const outcome = await this.withDelivery(observed.delivery_id, p.id, async (trx, d, e) => {
      const c = await trx<CommitmentRow>("dispatch_commitment").where({ id, driver_profile_id: p.id }).forUpdate().first();
      if (!c || !e) return dispatchMissing();
      if (input.expected_revision === 1 && (action === "ACCEPT" && c.status === "ASSIGNED" || action === "DECLINE" && c.status === "DECLINED")) return { result: c };
      if (input.expected_revision !== c.revision || c.status !== "OFFERED" || d.status !== "OFFERED" || c.generation !== d.generation) return { conflict: true };
      const now = await databaseTime(trx);
      if (now >= new Date(c.expires_at) || !d.deadline || now >= new Date(d.deadline)) {
        await this.closeOffer(trx, d, c, "EXPIRED", "OFFER_EXPIRED", system, now); return { conflict: true };
      }
      if (action === "DECLINE") {
        await this.closeOffer(trx, d, c, "DECLINED", "DRIVER_DECLINED", { type: "driver", id: p.id }, now);
        return { result: await trx<CommitmentRow>("dispatch_commitment").where({ id }).first() };
      }
      const r = await this.ready(trx, d);
      if (!this.enabled(d, r, await databaseTime(trx))) {
        await this.closeOffer(trx, d, c, "CANCELLED", "READINESS_LOST", system, await databaseTime(trx), true); return { conflict: true };
      }
      const availability = await this.availability(trx, p.id);
      if (!this.matches(availability, e) || availability?.generation !== c.availability_generation || e.affiliation_id !== c.affiliation_id) {
        await this.closeOffer(trx, d, c, "CANCELLED", "ELIGIBILITY_LOST", system, await databaseTime(trx)); return { conflict: true };
      }
      if (!await this.candidateIn(trx, d, e, r, c)) return { conflict: true }; // Redis absence alone never erases commitment
      const committedAt = await databaseTime(trx);
      if (committedAt >= new Date(c.expires_at) || committedAt >= new Date(d.deadline)) {
        await this.closeOffer(trx, d, c, "EXPIRED", "OFFER_EXPIRED", system, committedAt); return { conflict: true };
      }
      const [assigned] = await trx<CommitmentRow>("dispatch_commitment").where({ id }).update({ status: "ASSIGNED", revision: c.revision + 1,
        assigned_at: committedAt, decided_at: committedAt, updated_at: committedAt }).returning("*");
      await this.change(trx, d, { status: "ASSIGNED", restricted_content_present: d.restricted_content_present || !!r?.restricted }, "ASSIGNED", { type: "driver", id: p.id }, { commitment_id: id });
      return { result: assigned };
    });
    if ("conflict" in outcome || !outcome.result) return dispatchConflict();
    return { id: outcome.result.id, status: outcome.result.status, revision: outcome.result.revision };
  }
  async current(identity: string): Promise<{ commitment: DriverCommitmentDTO | null }> {
    const profile = await this.drivers.profileForIdentity(identity);
    const current = await this.commitment(this.db, profile.id);
    if (current) await this.reconcile(current.delivery_id);
    return this.own(identity, async (trx, e, _a, c) => {
      if (!c || (c.status !== "OFFERED" && c.status !== "ASSIGNED")) return { commitment: null };
      const d = await this.lockDelivery(trx, c.delivery_id);
      const store = await trx<{ name: string }>("merchant_store").where({ id: d.merchant_store_id }).first();
      const zone = await trx<{ name: string }>("marketplace_service_zone").where({ id: d.service_zone_id }).first();
      // Read remains available on Redis loss/ineligibility. No coordinates or financial claims.
      return { commitment: { id: c.id, delivery_id: d.id, status: c.status, revision: c.revision,
        expires_at: new Date(c.expires_at).toISOString(), assigned_at: iso(c.assigned_at),
        restricted_content_present: d.restricted_content_present, attention_required: d.status === "ATTENTION_REQUIRED" || !e.eligible,
        pickup_store: store?.name, destination_area: zone?.name } };
    });
  }
  // C will call these bounded primitives; B installs no subscriber, timer or worker.
  async reconcile(id: string) {
    const delivery = await this.db<DeliveryRow>("delivery_operation").where({ id }).first();
    if (delivery?.pickup_managed) {
      await new PickupService(this.container).observe(id);
      return await this.db<DeliveryRow>("delivery_operation").where({ id }).first() ?? dispatchMissing();
    }
    const observed = await this.db<CommitmentRow>("dispatch_commitment").where({ delivery_id: id }).whereIn("status", active).first();
    return this.withDelivery(id, observed?.driver_profile_id, async (trx, d, e) => {
      const c = await trx<CommitmentRow>("dispatch_commitment").where({ delivery_id: id }).whereIn("status", active).forUpdate().first();
      if ((observed?.id ?? null) !== (c?.id ?? null)) return dispatchConflict();
      if (d.status === "ATTENTION_REQUIRED" || d.pickup_managed) return d; // M16 owns native fulfillment-aware observation.
      const r = await this.ready(trx, d), now = await databaseTime(trx);
      if (c?.status === "ASSIGNED") {
        if (!r || !e?.eligible || e.affiliation_id !== c.affiliation_id || e.affiliation_revision !== c.affiliation_revision
          || e.profile_revision !== c.profile_revision || !r.config || r.config.mode === "DISABLED") {
          return this.change(trx, d, { status: "ATTENTION_REQUIRED", reason: "ASSIGNMENT_REVIEW" }, "ATTENTION_REQUIRED");
        }
        return d;
      }
      if (c) {
        if (!this.enabled(d, r, now)) return this.closeOffer(trx, d, c, "CANCELLED", "READINESS_LOST", system, now, true);
        if (now >= new Date(c.expires_at)) return this.closeOffer(trx, d, c, "EXPIRED", "OFFER_EXPIRED", system, now);
        if (!e?.eligible) return this.closeOffer(trx, d, c, "CANCELLED", "ELIGIBILITY_LOST", system, now);
        return d;
      }
      if (d.generation && (!this.enabled(d, r, now) || !d.deadline || now >= new Date(d.deadline))) {
        return this.change(trx, d, { status: "ATTENTION_REQUIRED", reason: "SEARCH_UNAVAILABLE" }, "ATTENTION_REQUIRED");
      }
      return d;
    });
  }
  async advance(id: string, exhausted: boolean, observedRevision?: number) {
    return this.withDelivery(id, undefined, async (trx, d) => {
      if (d.status !== "SEARCHING") return d;
      // Exhaustion belongs to the observed phase, never to a newer phase
      // established by a competing worker.
      if (exhausted && observedRevision !== undefined && observedRevision !== d.revision) return d;
      const r = await this.ready(trx, d), now = await databaseTime(trx);
      if (!this.enabled(d, r, now) || !d.deadline || now >= new Date(d.deadline)) return this.change(trx, d, { status: "ATTENTION_REQUIRED", reason: "SEARCH_ENDED" }, "ATTENTION_REQUIRED");
      if (d.path === "MERCHANT" && (exhausted || d.merchant_deadline && now >= new Date(d.merchant_deadline))) {
        if (d.mode === "HYBRID") return this.change(trx, d, { path: "PLATFORM" }, "PLATFORM_FALLBACK");
        return this.change(trx, d, { status: "ATTENTION_REQUIRED", reason: "POOL_EXHAUSTED" }, "ATTENTION_REQUIRED");
      }
      if (exhausted) return this.change(trx, d, { status: "ATTENTION_REQUIRED", reason: "POOL_EXHAUSTED" }, "ATTENTION_REQUIRED");
      return d;
    });
  }
}
