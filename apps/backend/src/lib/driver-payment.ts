import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { DRIVER_PAYMENT_POLICY, driverPaymentAllowed, driverPaymentCanReconcile, driverPaymentConflict,
  driverPaymentDiscrepancy, driverPaymentEvidenceValid, driverPaymentPage, driverPaymentTotal, nonpaymentDriverPayment,
  reconcileDriverPayment, recordDriverPayment, resolveDriverPayment, type DriverPaymentAction,
  type PayableDriverEarning } from "../modules/marketplace/driver-payment-policy";

interface Earning extends PayableDriverEarning { delivery_id: string }
interface Payment { id: string; driver_profile_id: string; payer: string; currency: string; amount_minor: string;
  initial_outcome: "PAID" | "UNKNOWN"; beneficiary_reference: string; channel: string; origin_reference: string;
  external_transfer_id: string; transferred_at: string | Date; recorded_at: Date; command_id: string;
  observed_amount_minor: number; policy_version: string }
interface Command { id: string; payment_id: string; payload: Record<string, unknown>; action: string }
const id = (prefix: string) => prefix + randomUUID();
// Parsed schemas have stable fields; jsonb equality also ignores object key order.
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => same(x[k], y[k]));
  }
  return a === b;
};

export class DriverPayments {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer, db?: Knex) { this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  private async authorize(actor: string, action: DriverPaymentAction | "VIEW" | "EVIDENCE") {
    if (!driverPaymentAllowed(actor, action)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver payment capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    if (!driverPaymentAllowed(actor, action)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver payment capability required.");
  }
  private async lock(trx: Knex.Transaction, driver: string, earningIds: string[]) {
    // Same Finance-only driver namespace as C. Never acquire operational locks.
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?::text,0))", ["gospaza:driver-finance:" + driver]);
    return trx<Earning>("driver_earning").whereIn("id", earningIds).orderByRaw('id collate "C"').forUpdate();
  }
  private async earningAttention(trx: Knex.Transaction, rows: Earning[]) {
    return !!await trx("driver_earning_exception").whereIn("delivery_id", rows.map(r => r.delivery_id)).first("id");
  }
  private async replay(trx: Knex.Transaction, actor: string, action: DriverPaymentAction, payload: Record<string, unknown>, payment?: string) {
    const previous = await trx<Command>("driver_payment_command").where({ actor_id: actor, request_id: payload.request_id }).first();
    if (!previous) return null;
    if (previous.action !== action || payment && previous.payment_id !== payment || !same(previous.payload, payload)) throw driverPaymentConflict();
    return { payment_id: previous.payment_id, command_id: previous.id };
  }
  private async command(trx: Knex.Transaction, actor: string, payment: string, action: DriverPaymentAction, payload: Record<string, unknown>) {
    const command = id("dpc_");
    await trx("driver_payment_command").insert({ id: command, payment_id: payment, actor_id: actor, request_id: payload.request_id, action, payload });
    return command;
  }
  private async allocate(trx: Knex.Transaction, payment: Payment, rows: Earning[], command: string) {
    await trx("driver_payment_allocation").insert(rows.map(row => ({ earning_id: row.id, payment_id: payment.id,
      driver_profile_id: payment.driver_profile_id, payer: payment.payer, currency: payment.currency,
      amount_minor: row.amount_minor, command_id: command })));
  }
  private async conflictBoundary<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      // Only our unique financial identities become conflicts; never hide arbitrary SQL errors.
      const e = error as { code?: string; constraint?: string };
      if (e.code === "23505" && e.constraint?.startsWith("driver_payment")) throw driverPaymentConflict();
      throw error;
    }
  }
  async record(actor: string, outcome: "RECORD" | "UNKNOWN", body: unknown) {
    await this.authorize(actor, outcome);
    const input = financialParse(recordDriverPayment, body);
    const preview = await this.db<Earning>("driver_earning").whereIn("id", input.earning_ids).orderByRaw('id collate "C"');
    driverPaymentTotal(preview);
    const driver = preview[0]?.driver_profile_id;
    if (!driver || preview.length !== input.earning_ids.length) throw driverPaymentConflict();
    return this.conflictBoundary(() => this.db.transaction(async trx => {
      const rows = await this.lock(trx, driver, input.earning_ids);
      await this.authorize(actor, outcome);
      const replay = await this.replay(trx, actor, outcome, input);
      if (replay) return replay;
      if (rows.length !== input.earning_ids.length || rows.some(r => r.driver_profile_id !== driver)) throw driverPaymentConflict();
      const { rows: [clock] } = await trx.raw("select clock_timestamp() as instant");
      if (!driverPaymentEvidenceValid(rows, input.amount_minor, input.currency, input.transferred_at, clock.instant)
        || await this.earningAttention(trx, rows)
        || await trx("driver_payment_hold").whereIn("earning_id", input.earning_ids).first("earning_id")
        || await trx("driver_payment_allocation").whereIn("earning_id", input.earning_ids).first("earning_id")) throw driverPaymentConflict();
      const paymentId = id("dpay_"), command = await this.command(trx, actor, paymentId, outcome, input);
      const [payment] = await trx<Payment>("driver_payment").insert({ id: paymentId, driver_profile_id: driver, payer: "GOSPAZA", currency: "zar",
        amount_minor: String(driverPaymentTotal(rows)), observed_amount_minor: input.amount_minor,
        initial_outcome: outcome === "RECORD" ? "PAID" : "UNKNOWN", beneficiary_reference: input.beneficiary_reference,
        channel: input.channel, origin_reference: input.origin_reference, external_transfer_id: input.external_transfer_id,
        transferred_at: input.transferred_at, command_id: command, policy_version: DRIVER_PAYMENT_POLICY }).returning("*");
      if (!payment) throw driverPaymentConflict();
      await trx("driver_payment_item").insert(rows.map(row => ({ payment_id: paymentId, earning_id: row.id, amount_minor: row.amount_minor })));
      await trx("driver_payment_hold").insert(rows.map(row => ({ payment_id: paymentId, earning_id: row.id })));
      if (outcome === "RECORD") await this.allocate(trx, payment, rows, command);
      await this.authorize(actor, outcome);
      return { payment_id: paymentId, command_id: command };
    }));
  }
  async execute(actor: string, paymentId: string, action: Exclude<DriverPaymentAction, "RECORD" | "UNKNOWN">, body: unknown) {
    await this.authorize(actor, action); financialParse(resourceId, paymentId);
    const input = action === "RECONCILE" ? financialParse(reconcileDriverPayment, body)
      : action === "DISCREPANCY" ? financialParse(driverPaymentDiscrepancy, body)
      : action === "CONFIRMED_NOT_PAID" ? financialParse(nonpaymentDriverPayment, body) : financialParse(resolveDriverPayment, body);
    const preview = await this.db<Payment>("driver_payment").where({ id: paymentId }).first();
    if (!preview) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Driver payment unavailable.");
    const items = await this.db("driver_payment_item").where({ payment_id: paymentId }).orderByRaw('earning_id collate "C"');
    return this.conflictBoundary(() => this.db.transaction(async trx => {
      const rows = await this.lock(trx, preview.driver_profile_id, items.map(r => String(r.earning_id)));
      const payment = await trx<Payment>("driver_payment").where({ id: paymentId }).forUpdate().first();
      if (!payment || rows.length !== items.length) throw driverPaymentConflict();
      await this.authorize(actor, action);
      const replay = await this.replay(trx, actor, action, input, paymentId);
      if (replay) return replay;
      const resolution = await trx("driver_payment_resolution").where({ payment_id: paymentId }).first();
      const paid = payment.initial_outcome === "PAID" || resolution?.outcome === "CONFIRMED_PAID";
      const blocked = !!await trx("driver_payment_discrepancy").where({ payment_id: paymentId }).first("id");
      if (action === "CONFIRMED_PAID" || action === "CONFIRMED_NOT_PAID") {
        if (payment.initial_outcome !== "UNKNOWN" || resolution || blocked || action === "CONFIRMED_PAID" && await this.earningAttention(trx, rows))
          throw driverPaymentConflict();
      } else if (action === "RECONCILE") {
        if (!driverPaymentCanReconcile(paid, blocked, await this.earningAttention(trx, rows))
          || await trx("driver_payment_reconciliation").where({ payment_id: paymentId }).first()
          || !("earning_ids" in input) || !same(input.earning_ids, rows.map(r => r.id))
          || input.driver_profile_id !== payment.driver_profile_id || BigInt(input.amount_minor) !== BigInt(payment.amount_minor)
          || input.currency !== payment.currency || input.beneficiary_reference !== payment.beneficiary_reference
          || input.channel !== payment.channel || input.origin_reference !== payment.origin_reference
          || input.external_transfer_id !== payment.external_transfer_id || input.transferred_at !== new Date(payment.transferred_at).toISOString()) throw driverPaymentConflict();
      }
      const command = await this.command(trx, actor, paymentId, action, input);
      if (action === "CONFIRMED_PAID" || action === "CONFIRMED_NOT_PAID") {
        await trx("driver_payment_resolution").insert({ payment_id: paymentId, outcome: action, command_id: command });
        if (action === "CONFIRMED_PAID") await this.allocate(trx, payment, rows, command);
        else await trx("driver_payment_hold").where({ payment_id: paymentId }).delete();
      } else if (action === "RECONCILE") await trx("driver_payment_reconciliation").insert({ payment_id: paymentId, command_id: command });
      else {
        if (!("category" in input)) throw driverPaymentConflict();
        await trx("driver_payment_discrepancy").insert({ id: id("dpd_"), payment_id: paymentId, category: input.category, command_id: command });
      }
      await this.authorize(actor, action);
      return { payment_id: paymentId, command_id: command };
    }));
  }
  // Ordinary earnings viewers receive no transfer/beneficiary/audit evidence.
  async selection(actor: string, driver: string, query: unknown = {}) {
    await this.authorize(actor, "VIEW"); financialParse(resourceId, driver);
    const page = financialParse(driverPaymentPage, query);
    return this.db.transaction(async trx => {
      const base = trx("driver_earning as e").leftJoin("driver_payment_allocation as a", "a.earning_id", "e.id")
        .leftJoin("driver_payment_hold as h", "h.earning_id", "e.id").where({ "e.driver_profile_id": driver, "e.payer": "GOSPAZA", "e.currency": "zar" });
      const classified = base.clone().select("e.id", "e.amount_minor", "e.currency", "e.payer", "e.economic_at")
        .select(trx.raw("exists(select 1 from driver_earning_exception ex where ex.delivery_id=e.delivery_id) as attention_required"))
        .select(trx.raw(`case when a.earning_id is not null then 'ALLOCATED' when h.earning_id is not null then 'RESERVED'
          when exists(select 1 from driver_earning_exception ex where ex.delivery_id=e.delivery_id) then 'ATTENTION_REQUIRED' else 'UNPAID' end as state`));
      const { rows: totals } = await trx.raw(`select state,sum(amount_minor)::text as amount_minor from (?) classified group by state`, [classified.clone()]);
      if (page.after) classified.where("e.id", ">", page.after);
      const items = await classified.orderBy("e.id").limit(page.limit);
      await this.authorize(actor, "VIEW");
      return { driver_profile_id: driver, payer: "GOSPAZA", currency: "zar", totals,
        items: items.map(row => ({ ...row, amount_minor: String(row.amount_minor) })),
        next_after: items.length === page.limit ? items.at(-1)?.id ?? null : null };
    }, { isolationLevel: "repeatable read" });
  }
  async evidence(actor: string, paymentId: string) {
    await this.authorize(actor, "EVIDENCE"); financialParse(resourceId, paymentId);
    return this.db.transaction(async trx => {
      const payment = await trx<Payment>("driver_payment").where({ id: paymentId }).first();
      if (!payment) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Driver payment unavailable.");
      const items = await trx("driver_payment_item").where({ payment_id: paymentId }).orderByRaw('earning_id collate "C"').select("earning_id", "amount_minor");
      const resolution = await trx("driver_payment_resolution").where({ payment_id: paymentId }).first("outcome");
      const reconciliation = await trx("driver_payment_reconciliation").where({ payment_id: paymentId }).first("command_id");
      const discrepancies = await trx("driver_payment_discrepancy").where({ payment_id: paymentId }).orderBy("id").limit(25).select("id", "category");
      await this.authorize(actor, "EVIDENCE");
      return { payment_id: payment.id, driver_profile_id: payment.driver_profile_id, payer: payment.payer, currency: payment.currency,
        amount_minor: String(payment.amount_minor), beneficiary_reference: payment.beneficiary_reference, channel: payment.channel,
        origin_reference: payment.origin_reference, external_transfer_id: payment.external_transfer_id, transferred_at: payment.transferred_at,
        recorded_at: payment.recorded_at, state: reconciliation ? "RECONCILED" : resolution?.outcome ?? payment.initial_outcome,
        items, discrepancies, attention_required: discrepancies.length > 0 || !resolution && payment.initial_outcome === "UNKNOWN" };
    }, { isolationLevel: "repeatable read" });
  }
  // Bounded, read-only recovery inventory. No bank outcome is inferred.
  async attention(actor: string, query: unknown = {}) {
    await this.authorize(actor, "EVIDENCE");
    const page = financialParse(driverPaymentPage, query);
    const q = this.db("driver_payment as p").leftJoin("driver_payment_resolution as r", "r.payment_id", "p.id")
      .leftJoin("driver_payment_reconciliation as rc", "rc.payment_id", "p.id").orderBy("p.id").limit(page.limit);
    if (page.after) q.where("p.id", ">", page.after);
    const rows = await q.select("p.id").select(this.db.raw(`case when exists(select 1 from driver_payment_discrepancy ds where ds.payment_id=p.id)
      then 'DISCREPANCY' when p.initial_outcome='UNKNOWN' and r.payment_id is null then 'UNKNOWN_OUTCOME'
      when rc.payment_id is null and (p.initial_outcome='PAID' or r.outcome='CONFIRMED_PAID') then 'AWAITING_RECONCILIATION' else 'RECORDED' end as state`));
    const items = [];
    for (const row of rows) {
      let integrity = "CONSISTENT";
      try { await this.db.raw("select gospaza_driver_payment_consistent(?)", [row.id]); } catch (error) {
        const e = error as { code?: string; message?: string };
        if (e.code !== "23514" || !e.message || !/(?:^| - )Driver payment (?:missing|recording audit|whole earning manifest|resolution audit|allocation reservation consistency|action audit|reconciliation audit|discrepancy audit)$/.test(e.message)) throw error;
        integrity = "REVIEW_REQUIRED";
      }
      items.push({ payment_id: row.id, state: row.state, integrity });
    }
    await this.authorize(actor, "EVIDENCE");
    return { items, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
  }
}
