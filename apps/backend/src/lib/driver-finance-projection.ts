import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type { DriverEarningSummary, DriverEarningsPage, DriverPaymentSummary, PlatformEarning, PlatformPayment, DriverFinanceCapabilities } from "@gospaza/contracts";
import { DriverService } from "../modules/marketplace/driver-service";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { driverPaymentAllowed, driverPaymentPage } from "../modules/marketplace/driver-payment-policy";
import { compensationAllowed } from "../modules/marketplace/driver-compensation-policy";

const platformPage = driverPaymentPage.extend({ driver: resourceId.optional() }).strict();
const iso = (value: Date | string) => new Date(value).toISOString();
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Driver financial record unavailable.");
interface Earning { id: string; driver_profile_id: string; delivery_id: string; order_id: string; amount_minor: string; currency: "zar";
  earning_type: "SUCCESSFUL_DELIVERY"; payer_classification: "PLATFORM"; economic_at: Date; recorded_at: Date; snapshot_id: string; terms_revision: number }
interface Payment { id: string; driver_profile_id: string; amount_minor: string; currency: "zar"; initial_outcome: "PAID" | "UNKNOWN";
  external_transfer_id: string; transferred_at: Date }
export class DriverFinanceProjection {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer, db?: Knex) { this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  async capabilities(actor: string): Promise<DriverFinanceCapabilities> {
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    return { view: driverPaymentAllowed(actor, "VIEW"), manage: compensationAllowed(actor, true),
      record: driverPaymentAllowed(actor, "RECORD"), reconcile: driverPaymentAllowed(actor, "RECONCILE") };
  }
  private async platform(actor: string) {
    if (!(await this.capabilities(actor)).view) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Driver earnings read capability required.");
  }
  private async own(identity: string) {
    // Existing native identity → DriverProfile boundary deliberately has no
    // ACTIVE/dispatch/affiliation eligibility predicate. Recheck per request.
    return new DriverService(this.container).profileForIdentity(identity);
  }
  private async summary(db: Knex.Transaction, payment: Payment): Promise<DriverPaymentSummary> {
    const resolution = await db("driver_payment_resolution").where({ payment_id: payment.id }).first("outcome");
    const reconciled = !!await db("driver_payment_reconciliation").where({ payment_id: payment.id }).first("payment_id");
    const discrepancy = !!await db("driver_payment_discrepancy").where({ payment_id: payment.id }).first("id");
    const count = await db("driver_payment_item").where({ payment_id: payment.id }).count("* as n").first();
    return { id: payment.id, amount_minor: String(payment.amount_minor), currency: "zar", earning_count: Number(count?.n ?? 0),
      payment_date: iso(payment.transferred_at), reference: "Transfer …" + payment.external_transfer_id.slice(-6),
      state: reconciled ? "RECONCILED" : resolution?.outcome === "CONFIRMED_NOT_PAID" ? "CONFIRMED_NOT_PAID"
        : payment.initial_outcome === "PAID" || resolution?.outcome === "CONFIRMED_PAID" ? "PAYMENT_RECORDED" : "UNDER_REVIEW",
      attention_required: discrepancy || payment.initial_outcome === "UNKNOWN" && !resolution };
  }
  private async earning(db: Knex.Transaction, row: Earning): Promise<DriverEarningSummary> {
    const allocation = await db("driver_payment_allocation").where({ earning_id: row.id }).first("payment_id");
    const hold = allocation ?? await db("driver_payment_hold").where({ earning_id: row.id }).first("payment_id");
    const payment = hold ? await db<Payment>("driver_payment").where({ id: hold.payment_id }).first() : undefined;
    const summary = payment ? await this.summary(db, payment) : null;
    const attention = !!await db("driver_earning_exception").where({ delivery_id: row.delivery_id }).first("id");
    return { id: row.id, delivery_reference: row.delivery_id, order_reference: row.order_id, economic_at: iso(row.economic_at),
      amount_minor: String(row.amount_minor), currency: "zar", earning_type: "SUCCESSFUL_DELIVERY", attention_required: attention || !!summary?.attention_required,
      payment_state: allocation ? summary?.state === "RECONCILED" ? "RECONCILED" : "PAYMENT_RECORDED" : hold ? "RESERVED" : "UNPAID", payment: summary };
  }
  private async platformEarning(db: Knex.Transaction, row: Earning): Promise<PlatformEarning> {
    const exceptions = await db("driver_earning_exception").where({ delivery_id: row.delivery_id }).orderBy("recorded_at").limit(25).select("reason", "recorded_at");
    return { ...await this.earning(db, row), driver_profile_id: row.driver_profile_id, payer: "GOSPAZA", payer_classification: row.payer_classification, recorded_at: iso(row.recorded_at),
      recognition_exceptions: exceptions.map(ex => ({ reason: String(ex.reason), recorded_at: iso(ex.recorded_at) })),
      snapshot: { id: row.snapshot_id, amount_minor: String(row.amount_minor), currency: "zar", terms_revision: row.terms_revision } };
  }
  async reviews(actor: string, query: unknown) {
    await this.platform(actor); const page = financialParse(platformPage, query);
    const q = this.db("driver_earning_exception").orderBy("id").limit(page.limit);
    if (page.after) q.where("id", ">", page.after); if (page.driver) q.where({ driver_profile_id: page.driver });
    const rows = await q.select("id", "driver_profile_id", "delivery_id", "reason", "recorded_at"); await this.platform(actor);
    return { items: rows.map(row => ({ id: String(row.id), driver_profile_id: row.driver_profile_id ? String(row.driver_profile_id) : null,
      delivery_reference: String(row.delivery_id), reason: String(row.reason), recorded_at: iso(row.recorded_at) })),
      next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
  }
  async driverList(identity: string, query: unknown): Promise<DriverEarningsPage> {
    const profile = await this.own(identity), page = financialParse(driverPaymentPage, query);
    return this.db.transaction(async trx => {
      const q = trx<Earning>("driver_earning").where({ driver_profile_id: profile.id }).orderBy("id").limit(page.limit);
      if (page.after) q.where("id", ">", page.after);
      const rows = await q, items: DriverEarningSummary[] = [];
      for (const row of rows) items.push(await this.earning(trx, row));
      const { rows: [totals] } = await trx.raw(`select
        coalesce(sum(e.amount_minor) filter(where a.earning_id is null and h.earning_id is null and not exists
          (select 1 from driver_earning_exception ex where ex.delivery_id=e.delivery_id)),0)::text as unpaid_minor,
        coalesce(sum(e.amount_minor) filter(where a.earning_id is null and h.earning_id is not null),0)::text as reserved_minor
        from driver_earning e left join driver_payment_allocation a on a.earning_id=e.id
        left join driver_payment_hold h on h.earning_id=e.id where e.driver_profile_id=?`, [profile.id]);
      const reviewRows = await trx("driver_earning_exception as ex").where({ "ex.driver_profile_id": profile.id })
        .whereNotExists(trx("driver_earning as e").select("e.id").whereRaw("e.delivery_id=ex.delivery_id"))
        .distinct("ex.delivery_id").orderBy("ex.delivery_id").limit(25);
      if ((await this.own(identity)).id !== profile.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required.");
      return { items, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null,
        unpaid_minor: totals.unpaid_minor, reserved_minor: totals.reserved_minor,
        reviews: reviewRows.map(row => ({ delivery_reference: String(row.delivery_id), state: "EARNING_UNDER_REVIEW" as const })) };
    }, { isolationLevel: "repeatable read" });
  }
  async driverEarning(identity: string, id: string) {
    const profile = await this.own(identity); financialParse(resourceId, id);
    return this.db.transaction(async trx => {
      const row = await trx<Earning>("driver_earning").where({ id, driver_profile_id: profile.id }).first();
      if (!row) throw missing();
      const result = await this.earning(trx, row);
      if ((await this.own(identity)).id !== profile.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required."); return result;
    }, { isolationLevel: "repeatable read" });
  }
  async driverPayment(identity: string, id: string) {
    const profile = await this.own(identity); financialParse(resourceId, id);
    return this.db.transaction(async trx => {
      const row = await trx<Payment>("driver_payment").where({ id, driver_profile_id: profile.id }).first();
      if (!row) throw missing();
      const result = await this.summary(trx, row);
      if ((await this.own(identity)).id !== profile.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required."); return result;
    }, { isolationLevel: "repeatable read" });
  }
  async driverPayments(identity: string, query: unknown) {
    const profile = await this.own(identity), page = financialParse(driverPaymentPage, query);
    return this.db.transaction(async trx => {
      const q = trx<Payment>("driver_payment").where({ driver_profile_id: profile.id }).orderBy("id").limit(page.limit);
      if (page.after) q.where("id", ">", page.after);
      const rows = await q, items: DriverPaymentSummary[] = [];
      for (const row of rows) items.push(await this.summary(trx, row));
      if ((await this.own(identity)).id !== profile.id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required.");
      return { items, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
    }, { isolationLevel: "repeatable read" });
  }
  async earnings(actor: string, query: unknown) {
    await this.platform(actor); const page = financialParse(platformPage, query);
    return this.db.transaction(async trx => {
      const q = trx<Earning>("driver_earning").orderBy("id").limit(page.limit);
      if (page.after) q.where("id", ">", page.after); if (page.driver) q.where({ driver_profile_id: page.driver });
      const rows = await q, items: PlatformEarning[] = [];
      for (const row of rows) items.push(await this.platformEarning(trx, row));
      await this.platform(actor);
      return { items, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
    }, { isolationLevel: "repeatable read" });
  }
  async earningDetail(actor: string, id: string) {
    await this.platform(actor); financialParse(resourceId, id);
    return this.db.transaction(async trx => {
      const row = await trx<Earning>("driver_earning").where({ id }).first(); if (!row) throw missing();
      const result = await this.platformEarning(trx, row); await this.platform(actor); return result;
    }, { isolationLevel: "repeatable read" });
  }
  private async platformPayment(db: Knex.Transaction, row: Payment): Promise<PlatformPayment> {
    const discrepancies = await db("driver_payment_discrepancy").where({ payment_id: row.id }).distinct("category").orderBy("category").limit(6);
    return { ...await this.summary(db, row), driver_profile_id: row.driver_profile_id, discrepancies: discrepancies.map(r => String(r.category)) };
  }
  async payments(actor: string, query: unknown) {
    await this.platform(actor); const page = financialParse(platformPage, query);
    return this.db.transaction(async trx => {
      const q = trx<Payment>("driver_payment").orderBy("id").limit(page.limit);
      if (page.after) q.where("id", ">", page.after); if (page.driver) q.where({ driver_profile_id: page.driver });
      const rows = await q, items: PlatformPayment[] = [];
      for (const row of rows) items.push(await this.platformPayment(trx, row));
      await this.platform(actor);
      return { items, next_after: rows.length === page.limit ? rows.at(-1)?.id ?? null : null };
    }, { isolationLevel: "repeatable read" });
  }
  async paymentDetail(actor: string, id: string) {
    await this.platform(actor); financialParse(resourceId, id);
    return this.db.transaction(async trx => {
      const row = await trx<Payment>("driver_payment").where({ id }).first(); if (!row) throw missing();
      const sources = await trx<Earning>("driver_earning as e").join("driver_payment_item as i", "i.earning_id", "e.id").where({ "i.payment_id": id }).orderBy("e.id").select<Earning[]>("e.*");
      const earnings: PlatformEarning[] = [];
      for (const source of sources) earnings.push(await this.platformEarning(trx, source));
      const payment = await this.platformPayment(trx, row); await this.platform(actor); return { payment, earnings };
    }, { isolationLevel: "repeatable read" });
  }
}
export const driverFinanceEmpty = z.object({}).strict();
