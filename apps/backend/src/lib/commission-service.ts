import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { commissionConfigurationAllowed, commissionHistoryInput, commissionPublication, COMMISSION_POLICY, commissionBasis, discountAttribution } from "../modules/marketplace/commission-policy";
import { financialParse, financialConflict, hasFinancialCapability, safeSum } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { readFinancialOrder } from "./financial-native";
import { checkoutMoney } from "./checkout-native";

export interface CommissionRule {
  id: string; scope_key: string; merchant_id: string|null; decision: "SET"|"CLEAR";
  basis_points: number|null; revision: number; effective_at: Date; recorded_at: Date;
  actor_id: string; reason: string; request_id: string; request_fingerprint: string;
}
interface Snapshot {
  id: string; order_id: string; order_operation_id: string; completion_id: string;
  merchant_id: string; store_id: string; currency: "zar"; order_created_at: Date|null;
  rule_id: string|null; merchant_decision_id: string|null; basis_points: number|null;
  policy_version: string; evidence: unknown; fingerprint: string|null; state: "RESOLVED"|"UNRESOLVED";
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Commission resource not found.");
const publicationLock = (db: Knex.Transaction) => db.raw("select pg_advisory_xact_lock(?::bigint)", [19019001]);

// Published timestamps are database-generated under this same lock. Holding it
// while selecting avoids observing an in-flight earlier publication as absent.
export async function resolveCommission(db: Knex.Transaction, merchant: string|undefined, created: Date) {
  await db.raw("select pg_advisory_xact_lock_shared(?::bigint)", [19019001]);
  const latest = (scope: string) => db<CommissionRule>("commission_rule")
    .where({ scope_key: scope }).where("effective_at", "<=", created).orderBy("effective_at", "desc").first();
  const decision = merchant ? await latest("MERCHANT:" + merchant) : undefined;
  const rule = decision?.decision === "SET" ? decision : await latest("PLATFORM");
  return { rule: rule ?? null, merchantDecision: decision ?? null };
}

export class CommissionService {
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer, db?: Knex, private readonly observeOrder = readFinancialOrder) {
    this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private async authorize(actor: string, write = false) {
    const allowed = write ? commissionConfigurationAllowed(actor)
      : hasFinancialCapability(actor, "VIEW") || commissionConfigurationAllowed(actor);
    if (!allowed) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Commission capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
  }
  async publish(actor: string, value: unknown) {
    await this.authorize(actor, true);
    const input = financialParse(commissionPublication, value);
    const fingerprint = digest({ actor, ...input });
    return this.db.transaction(async trx => {
      await publicationLock(trx);
      await this.authorize(actor, true);
      const previous = await trx<CommissionRule>("commission_rule").where({ request_id: input.request_id }).first();
      if (previous) {
        if (previous.request_fingerprint !== fingerprint) throw financialConflict();
        return this.ruleProjection(previous);
      }
      if (input.merchant_id && !await trx("merchant").where({ id: input.merchant_id }).whereNull("deleted_at").first()) throw missing();
      const scope = input.scope === "PLATFORM" ? "PLATFORM" : "MERCHANT:" + input.merchant_id;
      const latest = await trx<CommissionRule>("commission_rule").where({ scope_key: scope }).orderBy("revision", "desc").first();
      if ((latest?.revision ?? 0) !== input.expected_revision) throw financialConflict();
      if (input.effective_at) {
        const check = await trx.raw("select ?::timestamptz >= clock_timestamp() as valid", [input.effective_at]);
        if (!check.rows[0]?.valid) throw financialConflict();
        if (await trx("commission_rule").where({scope_key:scope,effective_at:input.effective_at}).first()) throw financialConflict();
      }
      const [row] = await trx("commission_rule").insert({
        id: "crule_" + randomUUID(), scope_key: scope, merchant_id: input.merchant_id ?? null,
        decision: input.decision, basis_points: input.basis_points ?? null, revision: input.expected_revision + 1,
        effective_at: input.effective_at ?? null,
        actor_id: actor, reason: input.reason, request_id: input.request_id, request_fingerprint: fingerprint,
      }).returning<CommissionRule[]>("*");
      if (!row) throw financialConflict();
      // Copy the timestamp inside PostgreSQL, retaining its microsecond precision.
      await trx.raw(`insert into commission_rule_audit(rule_id,actor_id,recorded_at,request_fingerprint)
        select id,actor_id,recorded_at,request_fingerprint from commission_rule where id=?`, [row.id]);
      return this.ruleProjection(row);
    });
  }
  private ruleProjection(row: CommissionRule) {
    return { id: row.id, merchant_id: row.merchant_id, decision: row.decision, basis_points: row.basis_points,
      revision: row.revision, effective_at: row.effective_at, recorded_at: row.recorded_at, reason: row.reason };
  }
  async history(actor: string, query: unknown) {
    await this.authorize(actor);
    const page = financialParse(commissionHistoryInput, query);
    return this.db.transaction(async trx=>{
    await trx.raw("select pg_advisory_xact_lock_shared(?::bigint)",[19019001]);
    const {rows:[clock]}=await trx.raw("select clock_timestamp() as instant");
    const scope=page.merchant_id ? "MERCHANT:"+page.merchant_id : "PLATFORM";
    const {rule:effective,merchantDecision}=await resolveCommission(trx,page.merchant_id,clock.instant);
    const current=page.merchant_id?merchantDecision:effective;
    const latest=await trx<CommissionRule>("commission_rule").where({scope_key:scope}).orderBy("revision","desc").first("revision");
    const rows = await trx<CommissionRule>("commission_rule")
      .where({ scope_key: page.merchant_id ? "MERCHANT:" + page.merchant_id : "PLATFORM" })
      .orderBy("revision", "desc").limit(page.limit).offset(page.offset);
    await this.authorize(actor);
    return {items:rows.map(row=>({...this.ruleProjection(row),timing:row.id===current?.id?"CURRENT":
      row.effective_at>clock.instant?"FUTURE":"HISTORICAL"})),effective:effective?this.ruleProjection(effective):null,
      revision:latest?.revision??0,can_publish:commissionConfigurationAllowed(actor),limit:page.limit,offset:page.offset};
    });
  }
  private async exception(trx: Knex.Transaction, snapshot: string, reason: string, source: string) {
    await trx("order_finance_exception").insert({ id: "fexc_" + randomUUID(), snapshot_id: snapshot, reason, source_id: source })
      .onConflict(["snapshot_id", "reason", "source_id"]).ignore();
  }
  // Internal domain command. Caller supplies only the native Order identity.
  // Existing M10/M11 records prove the relationship; no client economics.
  async ensure(order: string) {
    financialParse(resourceId, order);
    const initial = await this.db<OrderOperationRow>("order_operation").where({ medusa_order_id: order }).whereNull("deleted_at").first();
    if (!initial) throw missing();
    return this.db.transaction(async trx => {
      await trx("merchant").where({ id: initial.merchant_id }).forUpdate().first();
      const operation = await trx<OrderOperationRow>("order_operation").where({ id: initial.id }).whereNull("deleted_at").forUpdate().first();
      if (!operation || operation.merchant_id !== initial.merchant_id || operation.medusa_order_id !== order) throw missing();
      const existing = await trx<Snapshot>("order_finance_snapshot").where({ order_id: order }).first();
      let created: Date|null = null;
      let evidence: unknown = null;
      let fingerprint: string|null = null;
      const reasons: string[] = [];
      try {
        const handoff = await readOrderHandoff(trx, order);
        if (!handoff || handoff.completion_id !== operation.checkout_completion_id
          || handoff.merchant_id !== operation.merchant_id || handoff.merchant_store_id !== operation.merchant_store_id)
          throw financialConflict();
        const { order: native, economics } = await this.observeOrder(this.container, handoff);
        created = new Date(native.created_at);
        if (!Number.isFinite(created.getTime())) { created = null; throw financialConflict(); }
        const discounts = (native.items ?? []).map(item => ({ line_id: item.id, discount_minor: checkoutMoney(item.discount_total ?? 0) }))
          .sort((a,b)=>a.line_id.localeCompare(b.line_id));
        const shippingDiscounts = (native.shipping_methods ?? []).map(item => ({ shipping_id: item.id, discount_minor: checkoutMoney(item.discount_total ?? 0) }));
        // Native adjustments establish the discount, not its commercial sponsor.
        // The repository has no immutable sponsor declaration to consume yet.
        const nativeDiscount = checkoutMoney(native.discount_total);
        if (nativeDiscount !== handoff.snapshot.totals.discount_total_minor) reasons.push("ECONOMIC_EVIDENCE_MISMATCH");
        const adjustmentsPresent = (native.items ?? []).some(item=>item.adjustments?.length)
          || (native.shipping_methods ?? []).some(item=>item.adjustments?.length);
        const discountObserved = Math.max(nativeDiscount, handoff.snapshot.totals.discount_total_minor,
          safeSum([...discounts, ...shippingDiscounts].map(item=>item.discount_minor)));
        const attribution = adjustmentsPresent && !discountObserved ? null : discountAttribution(discountObserved, []);
        if (!attribution) reasons.push("UNKNOWN_PROMOTION_SPONSORSHIP");
        const amounts = {
            merchandise_net_minor: safeSum(economics.lines.map(line => line.net_minor)),
            merchandise_tax_minor: safeSum(economics.lines.map(line => line.tax_minor)),
            shipping_net_minor: economics.shipping_net_minor, shipping_tax_minor: economics.shipping_tax_minor,
            external_minor: handoff.snapshot.totals.total_minor,
            credit_minor: handoff.snapshot.store_credit?.amount_minor ?? 0,
        };
        evidence = {
          native_economics_fingerprint: economics.fingerprint,
          lines: economics.lines, discounts, shipping_discounts: shippingDiscounts, native_discount_minor: nativeDiscount,
          components: { ...amounts, merchant_discount_minor: attribution?.merchant_discount_minor ?? null,
            platform_subsidy_minor: attribution?.platform_subsidy_minor ?? null },
          basis_minor: attribution ? commissionBasis({ ...amounts, ...attribution }) : null,
        };
        fingerprint = digest({ order, created: created.toISOString(), completion: handoff.completion_id, evidence });
      } catch (error) {
        // Infrastructure failures remain retryable failures; only a classified
        // authoritative financial conflict is durable mismatch evidence.
        if (!MedusaError.isMedusaError(error) || (error.code !== "FINANCIAL_EVIDENCE_CONFLICT" && error.code !== "ORDER_EVIDENCE_MISMATCH")) throw error;
        reasons.push("ECONOMIC_EVIDENCE_MISMATCH");
      }
      if (existing) {
        if (fingerprint !== existing.fingerprint || existing.order_created_at?.getTime() !== created?.getTime())
          await this.exception(trx, existing.id, "ECONOMIC_EVIDENCE_MISMATCH", operation.checkout_completion_id);
        return this.snapshotProjection(trx, existing);
      }
      const { rule, merchantDecision } = created ? await resolveCommission(trx, operation.merchant_id, created)
        : { rule:null, merchantDecision:null };
      if (created && !rule) reasons.push("MISSING_COMMISSION_TERMS");
      const row: Snapshot = {
        id: "ofs_" + randomUUID(), order_id: order, order_operation_id: operation.id,
        completion_id: operation.checkout_completion_id, merchant_id: operation.merchant_id, store_id: operation.merchant_store_id,
        currency: "zar", order_created_at: created, rule_id: rule?.id ?? null,
        merchant_decision_id: merchantDecision?.id ?? null, basis_points: rule?.basis_points ?? null,
        policy_version: COMMISSION_POLICY, evidence, fingerprint, state: reasons.length ? "UNRESOLVED" : "RESOLVED",
      };
      await trx("order_finance_snapshot").insert({ ...row, evidence: evidence === null ? null : JSON.stringify(evidence) });
      for (const reason of reasons) await this.exception(trx, row.id, reason, operation.checkout_completion_id);
      return this.snapshotProjection(trx, row);
    });
  }
  private async snapshotProjection(db: Knex|Knex.Transaction, row: Snapshot) {
    const exceptions = await db("order_finance_exception").where({ snapshot_id: row.id }).orderBy("recorded_at").select("reason", "recorded_at");
    const terms = row.rule_id ? await db<CommissionRule>("commission_rule").where({id:row.rule_id}).first("revision","effective_at") : null;
    return { order_id: row.order_id, merchant_id: row.merchant_id, store_id: row.store_id, currency: row.currency,
      state: exceptions.length ? "UNRESOLVED" : row.state, original_state: row.state,
      order_created_at: row.order_created_at, rule_id: row.rule_id, merchant_decision_id: row.merchant_decision_id,
      rule_revision: terms?.revision ?? null, rule_effective_at: terms?.effective_at ?? null,
      basis_points: row.basis_points, policy_version: row.policy_version, evidence: row.evidence, exceptions };
  }
  async preparePlatformRead(actor: string, order: string) {
    if (!hasFinancialCapability(actor,"VIEW")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Financial read capability required.");
    await this.authorize(actor);
    const id = financialParse(resourceId,order);
    const saved = await this.db<Snapshot>("order_finance_snapshot").where({order_id:id}).first("id");
    if(!saved) await this.ensure(id);
    if (!hasFinancialCapability(actor,"VIEW")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Financial read capability required.");
  }
  async provisionPage(after?: string) {
    const query = this.db("order_operation as o").whereNull("o.deleted_at")
      .whereNotExists(this.db("order_finance_snapshot as s").select("s.id").whereRaw("s.order_operation_id=o.id"));
    if (after) query.where("o.id", ">", financialParse(resourceId, after));
    const rows: {id:string; medusa_order_id:string}[] = await query.select("o.id","o.medusa_order_id").orderBy("o.id").limit(25);
    let unresolved = 0;
    const deferred: string[] = [];
    for (const row of rows) {
      try { if ((await this.ensure(row.medusa_order_id)).state === "UNRESOLVED") unresolved++; }
      catch { deferred.push(row.id); } // Receipts remain discoverable on the next sweep.
    }
    return { examined: rows.length, unresolved, deferred, next_cursor: rows.length === 25 ? rows.at(-1)?.id : null };
  }
}
