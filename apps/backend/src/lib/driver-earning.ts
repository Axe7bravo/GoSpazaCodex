import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { DRIVER_EARNING_POLICY, driverEarningDisposition, driverEarningPage, driverEarningSourceMatches, driverEarningsView,
  type DriverEarningEvidence } from "../modules/marketplace/driver-earning-policy";

interface Recognition { id: string; outcome: "EARNED" | "NON_GOSPAZA_PAYABLE"; source_fingerprint: string }
interface Earning { id: string; driver_profile_id: string; delivery_id: string; order_id: string; commitment_id: string; completion_id: string;
  merchant_id: string; store_id: string; amount_minor: string; currency: "zar"; payer: "GOSPAZA"; earning_type: "SUCCESSFUL_DELIVERY";
  snapshot_id: string; terms_id: string; terms_revision: number; economic_at: Date; recorded_at: Date }
export interface DriverRecognitionResult { state: string; id?: string; reason?: string }

async function source(db: Knex | Knex.Transaction, delivery: string): Promise<DriverEarningEvidence> {
  const { rows: [row] } = await db.raw("select gospaza_driver_earning_source(?) as evidence", [delivery]);
  return row.evidence;
}
async function audit(trx: Knex.Transaction, kind: string, target: string, fingerprint: string) {
  await trx("driver_earning_audit").insert({ id: "dea_" + randomUUID(), kind, target_id: target, source_fingerprint: fingerprint });
}
async function exception(trx: Knex.Transaction, delivery: string, reason: string) {
  const { rows } = await trx.raw(`insert into driver_earning_exception(id,delivery_id,reason)
    values(?,?,?) on conflict(delivery_id,reason,source_id) do nothing returning id`, ["deex_" + randomUUID(), delivery, reason]);
  if (rows[0]) await audit(trx, "EXCEPTION", rows[0].id, reason);
}
const earningDto = (e: Earning) => ({ id: e.id, driver_profile_id: e.driver_profile_id, delivery_id: e.delivery_id, order_id: e.order_id,
  commitment_id: e.commitment_id, completion_id: e.completion_id, merchant_id: e.merchant_id, store_id: e.store_id, payer: e.payer,
  earning_type: e.earning_type, amount_minor: String(e.amount_minor), currency: e.currency, snapshot_id: e.snapshot_id,
  terms_id: e.terms_id, terms_revision: e.terms_revision, economic_at: e.economic_at, recorded_at: e.recorded_at });

export class DriverEarnings {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer, db?: Knex) { this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  // Internal event/CLI primitive, deliberately without an HTTP mutation route.
  async recognize(order: string): Promise<DriverRecognitionResult> {
    financialParse(resourceId, order);
    const delivery = await this.db("delivery_operation").where({ medusa_order_id: order }).whereNull("deleted_at").first("id");
    if (!delivery) return { state: "NO_DELIVERY" };
    const observed = await source(this.db, delivery.id);
    return this.db.transaction(async trx => {
      // Finance-only namespaced locks; never acquire merchant, eligibility,
      // OrderOperation, Delivery or handoff row locks from this transaction.
      if (observed.driver_profile_id) await trx.raw("select pg_advisory_xact_lock(hashtextextended(?::text,0))", ["gospaza:driver-finance:" + observed.driver_profile_id]);
      await trx.raw("select pg_advisory_xact_lock(hashtextextended(?::text,0))", ["gospaza:driver-recognition:" + delivery.id]);
      const current = await source(trx, delivery.id);
      if (current.driver_profile_id !== observed.driver_profile_id) return { state: "PENDING", reason: "SOURCE_CHANGED" };
      const previous = await trx<Recognition>("driver_earning_recognition").where({ delivery_id: delivery.id }).first();
      const existing = previous ? await trx<Earning>("driver_earning").where({ recognition_id: previous.id }).first() : undefined;
      if (previous && (current.state !== "READY" || !driverEarningSourceMatches(previous.source_fingerprint, current.source_fingerprint))) {
        await exception(trx, delivery.id, "SOURCE_CONFLICT");
        return { state: "UNRESOLVED", reason: "SOURCE_CONFLICT", ...(existing ? { id: existing.id } : {}) };
      }
      if (current.state === "UNRESOLVED") {
        if (!current.reason) throw new Error("Missing driver earning exception reason.");
        await exception(trx, delivery.id, current.reason); return { state: "UNRESOLVED", reason: current.reason };
      }
      const outstanding = await trx("driver_earning_exception").where({ delivery_id: delivery.id }).orderBy("recorded_at").first("reason");
      if (outstanding) return { state: "UNRESOLVED", reason: String(outstanding.reason), ...(existing ? { id: existing.id } : {}) };
      if (previous) {
        if (previous.outcome === "EARNED" && !existing) throw new Error("Driver earning persistence requires review.");
        return { state: previous.outcome, id: existing?.id ?? previous.id };
      }
      const result = driverEarningDisposition(current);
      if (result.state !== "EARNED" && result.state !== "NON_GOSPAZA_PAYABLE")
        return { state: result.state, ...(result.reason ? { reason: result.reason } : {}) };
      const eventId = current.event_id, sourceRevision = current.source_revision;
      if (!current.completion_id || !current.commitment_id || !current.driver_profile_id || !current.snapshot?.id || !current.source_fingerprint || !eventId || sourceRevision === undefined)
        throw new Error("Incomplete authoritative driver earning source.");
      const recognition = "der_" + randomUUID();
      await trx("driver_earning_recognition").insert({ id: recognition, delivery_id: delivery.id, completion_id: current.completion_id,
        commitment_id: current.commitment_id, driver_profile_id: current.driver_profile_id, snapshot_id: current.snapshot.id,
        outcome: result.state, source_fingerprint: current.source_fingerprint, policy_version: DRIVER_EARNING_POLICY });
      await audit(trx, "RECOGNITION", recognition, current.source_fingerprint);
      if (result.state === "NON_GOSPAZA_PAYABLE") return { state: result.state, id: recognition };
      const id = "dearn_" + randomUUID();
      // Copy exact cents/timestamps inside PostgreSQL. No financial value comes
      // from event data, current terms, shipping prices or JavaScript arithmetic.
      await trx.raw(`insert into driver_earning(id,recognition_id,driver_profile_id,delivery_id,order_id,commitment_id,completion_id,
        merchant_id,store_id,payer_classification,payer,earning_type,amount_minor,currency,snapshot_id,terms_id,terms_revision,terms_policy_version,
        policy_version,event_id,source_revision,economic_at,source_fingerprint)
        select ?,r.id,r.driver_profile_id,r.delivery_id,d.medusa_order_id,r.commitment_id,r.completion_id,d.merchant_id,d.merchant_store_id,
          s.path,s.payer,'SUCCESSFUL_DELIVERY',s.amount_minor,s.currency,s.id,s.terms_id,s.terms_revision,s.policy_version,?,?,?,d.delivered_at,r.source_fingerprint
        from driver_earning_recognition r join driver_compensation_snapshot s on s.id=r.snapshot_id join delivery_operation d on d.id=r.delivery_id where r.id=?`,
      [id, DRIVER_EARNING_POLICY, eventId, sourceRevision, recognition]);
      await audit(trx, "EARNING", id, current.source_fingerprint);
      return { state: "EARNED", id };
    });
  }
  async repair(body: unknown = {}) {
    const page = financialParse(driverEarningPage, body);
    // Include existing results in the bounded sweep to validate replay/source
    // integrity; missing recognition is created through the identical primitive.
    const query = this.db("delivery_completion as c").join("delivery_operation as d", "d.id", "c.delivery_id")
      .where({ "c.state": "SUCCEEDED", "c.native_done": true, "d.status": "DELIVERED" }).whereNull("c.deleted_at").whereNull("d.deleted_at")
      .orderBy("c.id").limit(page.limit);
    if (page.after) query.where("c.id", ">", page.after);
    if (page.through) query.where("c.id", "<=", page.through);
    const rows = await query.select("c.id", "d.medusa_order_id");
    const items: { completion_id: string; result: DriverRecognitionResult }[] = [], deferred: string[] = [];
    for (const row of rows) {
      try { items.push({ completion_id: String(row.id), result: await this.recognize(row.medusa_order_id) }); }
      catch { deferred.push(String(row.id)); } // Discoverable next pass; never fabricate success or retry handoff.
    }
    return { examined: rows.length, items, deferred, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
  }
  private async authorize(actor: string) {
    if (!driverEarningsView(actor)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver earnings read capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    if (!driverEarningsView(actor)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver earnings read capability required.");
  }
  async forOrder(actor: string, order: string) {
    await this.authorize(actor); financialParse(resourceId, order);
    return this.db.transaction(async trx => {
      const delivery = await trx("delivery_operation").where({ medusa_order_id: order }).whereNull("deleted_at").first("id");
      if (!delivery) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Driver earning source unavailable.");
      const recognition = await trx<Recognition>("driver_earning_recognition").where({ delivery_id: delivery.id }).first();
      const earning = await trx<Earning>("driver_earning").where({ delivery_id: delivery.id }).first();
      const exceptions = await trx("driver_earning_exception").where({ delivery_id: delivery.id }).orderBy("recorded_at").limit(25).select("reason", "recorded_at");
      const observed = await source(trx, delivery.id);
      await this.authorize(actor);
      return { state: exceptions.length ? "UNRESOLVED" : recognition?.outcome ?? (observed.state === "READY" ? "PENDING_RECOGNITION" : observed.state),
        earning: earning ? earningDto(earning) : null, exceptions, attention_required: exceptions.length > 0 };
    }, { isolationLevel: "repeatable read" });
  }
}
