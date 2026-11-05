import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { COMPENSATION_LOCK, COMPENSATION_POLICY, compensationActivation, compensationAllowed, compensationConflict,
  compensationPage, compensationPublication, compensationState, type CompensationState } from "../modules/marketplace/driver-compensation-policy";

type Db = Knex | Knex.Transaction;
interface Decision { id: string; revision: number; effective_at: Date; recorded_at: Date; actor_id: string; reason: string;
  request_fingerprint: string; amount_minor?: string; currency?: "zar" }
interface Snapshot { id: string; commitment_id: string; delivery_id: string; driver_profile_id: string; merchant_id: string; store_id: string;
  affiliation_id: string; affiliation_revision: number; path: "MERCHANT" | "PLATFORM"; payer: string; currency: "zar";
  amount_minor: string | null; terms_id: string | null; terms_revision: number | null; effective_at: Date | null; activation_id: string;
  assigned_at: Date; snapshot_at: Date; state: CompensationState; policy_version: string; source_fingerprint: string }
export interface AssignmentCompensation { at: string; state: CompensationState; activation_id: string | null; terms_id: string | null }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decisionDto = (row: Decision) => ({ id: row.id, revision: row.revision, effective_at: row.effective_at, recorded_at: row.recorded_at,
  reason: row.reason, ...(row.amount_minor === undefined ? {} : { amount_minor: String(row.amount_minor), currency: "zar" }) });

export class DriverCompensation {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer, db?: Knex) { this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  private async authorize(actor: string, write = false) {
    if (!compensationAllowed(actor, write)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver compensation capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    if (!compensationAllowed(actor, write)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver compensation capability required.");
  }
  private async decide(actor: string, body: unknown, activate: boolean) {
    await this.authorize(actor, true);
    const input = activate ? financialParse(compensationActivation, body) : financialParse(compensationPublication, body);
    const table = activate ? "driver_compensation_activation" : "driver_compensation_terms";
    const fingerprint = digest({ actor, kind: activate ? "ACTIVATION" : "TERMS", ...input });
    return this.db.transaction(async trx => {
      await trx.raw("select pg_advisory_xact_lock(?::bigint)", [COMPENSATION_LOCK]);
      await this.authorize(actor, true);
      const replay = await trx<Decision>(table).where({ request_id: input.request_id }).first();
      if (replay) { if (replay.request_fingerprint !== fingerprint) throw compensationConflict(); return decisionDto(replay); }
      const latest = await trx<Decision>(table).orderBy("revision", "desc").first();
      if ((latest?.revision ?? 0) !== input.expected_revision || activate && latest) throw compensationConflict();
      const rowInput = { id: (activate ? "dcact_" : "dcterm_") + randomUUID(), revision: input.expected_revision + 1,
        effective_at: input.effective_at ?? null, actor_id: actor, reason: input.reason, request_id: input.request_id,
        request_fingerprint: fingerprint, policy_version: COMPENSATION_POLICY };
      const [row] = await trx(table).insert(activate ? rowInput : { ...rowInput, scope: "PLATFORM_FLAT", payer: "GOSPAZA",
        affiliation_kind: "PLATFORM", currency: "zar", amount_minor: "amount_minor" in input ? input.amount_minor : undefined }).returning<Decision[]>("*");
      if (!row) throw compensationConflict();
      await trx.raw(`insert into driver_compensation_audit(id,kind,target_id,actor_id,recorded_at,fingerprint)
        select ?,?,id,actor_id,recorded_at,request_fingerprint from ?? where id=?`,
      ["dca_" + randomUUID(), activate ? "ACTIVATION" : "TERMS", table, row.id]);
      await this.authorize(actor, true);
      return decisionDto(row);
    });
  }
  publish(actor: string, body: unknown) { return this.decide(actor, body, false); }
  activate(actor: string, body: unknown) { return this.decide(actor, body, true); }
  async history(actor: string, body: unknown) {
    await this.authorize(actor); const page = financialParse(compensationPage, body);
    return this.db.transaction(async trx => {
      await trx.raw("select pg_advisory_xact_lock_shared(?::bigint)", [COMPENSATION_LOCK]);
      const query = trx<Decision>("driver_compensation_terms").orderBy("revision").limit(page.limit);
      if (page.after) {
        const cursor = await trx<Decision>("driver_compensation_terms").where({ id: page.after }).first();
        if (!cursor) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Compensation cursor unavailable.");
        query.where("revision", ">", cursor.revision);
      }
      const rows = await query;
      const activation = await trx<Decision>("driver_compensation_activation").first();
      const current = await trx<Decision>("driver_compensation_terms").where("effective_at", "<=", trx.raw("clock_timestamp()"))
        .orderBy("effective_at", "desc").orderBy("revision", "desc").first();
      const latest = await trx<Decision>("driver_compensation_terms").orderBy("revision", "desc").first("revision");
      await this.authorize(actor);
      return { items: rows.map(decisionDto), current: current ? decisionDto(current) : null,
        activation: activation ? decisionDto(activation) : null, revision: latest?.revision ?? 0,
        next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
    });
  }
  async resolution(actor: string, value: unknown) {
    await this.authorize(actor); const id = financialParse(resourceId, value);
    const commitment = await this.db("dispatch_commitment").where({ id }).first("id", "assigned_at", "path");
    if (!commitment) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Compensation resolution unavailable.");
    const snapshot = await this.db<Snapshot>("driver_compensation_snapshot").where({ commitment_id: id }).first();
    const exceptions = await this.db("driver_compensation_exception").where({ commitment_id: id }).orderBy("recorded_at").select("reason", "recorded_at");
    const { rows: [active] } = await this.db.raw(`select a.id from dispatch_commitment c join driver_compensation_activation a
      on a.effective_at<=c.assigned_at where c.id=?`, [id]);
    await this.authorize(actor);
    return { commitment_id: id, state: snapshot?.state ?? (commitment.assigned_at ? active ? "SNAPSHOT_MISSING" : "HISTORICAL_PREACTIVATION"
      : exceptions.some(e => e.reason === "MISSING_COMPENSATION_TERMS") ? "MISSING_COMPENSATION_TERMS" : "NOT_ASSIGNED"),
      snapshot: snapshot ? snapshotDto(snapshot) : null, exceptions };
  }
  // Inspection only: never reprice, synthesize snapshots or mutate dispatch.
  async repair(actor: string, body: unknown) {
    await this.authorize(actor, true); const page = financialParse(compensationPage, body);
    return this.db.transaction(async trx => {
      await trx.raw("select pg_advisory_xact_lock_shared(?::bigint)", [COMPENSATION_LOCK]);
      await this.authorize(actor, true);
      const query = trx("dispatch_commitment as c").whereNotNull("c.assigned_at").orderBy("c.id").limit(page.limit);
      if (page.after) query.where("c.id", ">", page.after);
      const rows = await query.select("c.id", "c.assigned_at", "c.delivery_id", "c.driver_profile_id");
      let exceptions = 0;
      for (const row of rows) {
        // Compare timestamps in SQL, preserving the assignment microseconds.
        const { rows: [selected] } = await trx.raw(`select a.id from dispatch_commitment c
          join driver_compensation_activation a on a.effective_at<=c.assigned_at where c.id=?`, [row.id]);
        const snapshot = await trx("driver_compensation_snapshot").where({ commitment_id: row.id }).first("id");
        if (!snapshot) {
          await compensationException(trx, row.id, selected ? "SNAPSHOT_MISSING" : "HISTORICAL_PREACTIVATION", selected?.id ?? null);
          exceptions++;
        } else {
          const { rows: [valid] } = await trx.raw(`select s.id from driver_compensation_snapshot s
            join dispatch_commitment c on c.id=s.commitment_id join delivery_operation d on d.id=c.delivery_id
            left join driver_compensation_terms t on t.id=s.terms_id
            where s.id=? and (s.delivery_id,s.driver_profile_id,s.affiliation_id,s.affiliation_revision,s.path,s.assigned_at,s.merchant_id,s.store_id)
              =(c.delivery_id,c.driver_profile_id,c.affiliation_id,c.affiliation_revision,c.path,c.assigned_at,d.merchant_id,d.merchant_store_id)
              and (s.path='MERCHANT' or (s.amount_minor,s.terms_revision,s.effective_at)=(t.amount_minor,t.revision,t.effective_at))`, [snapshot.id]);
          if (!valid) { await compensationException(trx, row.id, "SNAPSHOT_CONFLICT", selected?.id ?? null); exceptions++; }
        }
      }
      await this.authorize(actor, true);
      return { examined: rows.length, exceptions, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
    });
  }
}
function snapshotDto(s: Snapshot) {
  return { id: s.id, commitment_id: s.commitment_id, delivery_id: s.delivery_id, driver_profile_id: s.driver_profile_id,
    merchant_id: s.merchant_id, store_id: s.store_id, affiliation_id: s.affiliation_id, affiliation_revision: s.affiliation_revision,
    path: s.path, payer: s.payer, currency: s.currency, amount_minor: s.amount_minor === null ? null : String(s.amount_minor),
    terms_id: s.terms_id, terms_revision: s.terms_revision, effective_at: s.effective_at, activation_id: s.activation_id,
    assigned_at: s.assigned_at, snapshot_at: s.snapshot_at, policy_version: s.policy_version, state: s.state };
}
async function compensationException(db: Db, commitment: string, reason: string, activation: string | null) {
  const id = "dce_" + randomUUID();
  const inserted = await db.raw(`insert into driver_compensation_exception(id,commitment_id,delivery_id,driver_profile_id,activation_id,reason)
    select ?,c.id,c.delivery_id,c.driver_profile_id,?,? from dispatch_commitment c where c.id=?
    on conflict(commitment_id,reason) do nothing returning id`, [id, activation, reason, commitment]);
  if (inserted.rows.length) await db("driver_compensation_audit").insert({ id: "dca_" + randomUUID(), kind: "EXCEPTION", target_id: id, actor_id: null, fingerprint: reason });
}
// Called only after all existing operational locks/admission, before assigning.
// No native/Redis calls and no merchant/profile locks are acquired here.
export function lockCompensationSelection(trx: Knex.Transaction) {
  return trx.raw("select pg_advisory_xact_lock_shared(?::bigint)", [COMPENSATION_LOCK]);
}
export async function assignmentCompensation(trx: Knex.Transaction, commitment: string): Promise<AssignmentCompensation> {
  await lockCompensationSelection(trx);
  const { rows: [clock] } = await trx.raw("select clock_timestamp()::text as instant");
  const { rows: [selected] } = await trx.raw("select * from gospaza_driver_comp_selection(?::timestamptz)", [clock.instant]);
  const c = await trx("dispatch_commitment").where({ id: commitment }).first("path");
  if (!c) throw compensationConflict();
  const state = compensationState(c.path, !!selected, !!selected?.terms_id);
  if (state === "MISSING_COMPENSATION_TERMS") await compensationException(trx, commitment, state, selected.activation_id);
  return { at: clock.instant, state, activation_id: selected?.activation_id ?? null, terms_id: selected?.terms_id ?? null };
}
export async function freezeAssignmentCompensation(trx: Knex.Transaction, commitment: string, resolution: AssignmentCompensation) {
  // Preactivation work remains review-only, without manufacturing a historical
  // compensation snapshot. Repair/read support can report it separately.
  if (resolution.state === "HISTORICAL_PREACTIVATION") return;
  if (resolution.state === "MISSING_COMPENSATION_TERMS") throw compensationConflict();
  const id = "dcs_" + randomUUID();
  await trx.raw(`insert into driver_compensation_snapshot(id,commitment_id,delivery_id,driver_profile_id,merchant_id,store_id,
    affiliation_id,affiliation_revision,path,payer,currency,amount_minor,terms_id,terms_revision,effective_at,activation_id,assigned_at,state,policy_version)
    select ?,c.id,c.delivery_id,c.driver_profile_id,d.merchant_id,d.merchant_store_id,c.affiliation_id,c.affiliation_revision,c.path,
      case when c.path='PLATFORM' then 'GOSPAZA' else 'NON_GOSPAZA_PAYABLE' end,'zar',t.amount_minor,t.id,t.revision,t.effective_at,?,c.assigned_at,?,?
    from dispatch_commitment c join delivery_operation d on d.id=c.delivery_id
    left join driver_compensation_terms t on t.id=? and c.path='PLATFORM' where c.id=?`,
  [id, resolution.activation_id, resolution.state, COMPENSATION_POLICY, resolution.terms_id, commitment]);
  await trx.raw(`insert into driver_compensation_audit(id,kind,target_id,actor_id,fingerprint)
    select ?,'SNAPSHOT',id,null,source_fingerprint from driver_compensation_snapshot where id=?`, ["dca_" + randomUUID(), id]);
}
