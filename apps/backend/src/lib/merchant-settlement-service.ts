import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { SETTLEMENT_POLICY, SETTLEMENT_TIMEZONE, settlementActivation, settlementAllowed,
  settlementAmounts, settlementConflict, settlementDecision, settlementGeneration } from "../modules/marketplace/merchant-settlement-policy";

const id = (prefix:string) => prefix+randomUUID();
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND,"Settlement resource not found.");
type Statement = {id:string;merchant_id:string;store_id:string;currency:string;policy_id:string;period_start:Date;
  period_end:Date;cutoff:Date;version:number;revision:number;status:string;superseded_by:string|null;
  finalized_at:Date|null;payable_minor:string;incoming_carry_minor:string};

// M20 owns consumption/preparation, not M19 economics or M18 compensation.
// Direct SQL is deliberate: immutable M19 and M20 records have no CRUD service.
export class MerchantSettlements {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer, db?:Knex) {
    this.db=db??container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private async authorize(actor:string,action:"VIEW"|"PREPARE") {
    if(!settlementAllowed(actor,action)) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Settlement capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
  }
  // Explicit prospective activation; no startup defaults or retrospective imports.
  async activate(actor:string,value:unknown) {
    await this.authorize(actor,"PREPARE");
    const input=financialParse(settlementActivation,value);
    return this.db.transaction(async trx=>{
      await trx.raw("select pg_advisory_xact_lock(?::bigint)",[20020001]);
      await this.authorize(actor,"PREPARE");
      const previous=await trx("settlement_period_policy").where({id:input.id}).first();
      if(previous) {
        if(new Date(previous.activation_at).toISOString()!==new Date(input.activation_at).toISOString()
          || previous.actor_id!==actor || previous.reason!==input.reason) throw settlementConflict();
        return {id:previous.id,activation_at:previous.activation_at};
      }
      const {rows:[clock]}=await trx.raw("select ?::timestamptz >= clock_timestamp() as valid",[input.activation_at]);
      if(!clock.valid || await trx("settlement_period_policy").first()) throw settlementConflict();
      await trx("settlement_period_policy").insert({id:input.id,version:SETTLEMENT_POLICY,timezone:SETTLEMENT_TIMEZONE,
        currency:"zar",activation_at:input.activation_at,actor_id:actor,reason:input.reason,tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"});
      return {id:input.id,activation_at:input.activation_at};
    });
  }
  private async merchantLock(trx:Knex.Transaction,merchant:string,store:string) {
    const m=await trx("merchant").where({id:merchant}).whereNull("deleted_at").forUpdate().first();
    if(!m || !await trx("merchant_store").where({id:store,merchant_id:merchant}).whereNull("deleted_at").first()) throw missing();
  }
  async generate(actor:string,value:unknown) {
    await this.authorize(actor,"PREPARE");
    const input=financialParse(settlementGeneration,value);
    const statement=await this.db.transaction(async trx=>{
      await this.merchantLock(trx,input.merchant_id,input.store_id);
      await this.authorize(actor,"PREPARE");
      const policy=await trx("settlement_period_policy").where({id:input.policy_id,version:SETTLEMENT_POLICY}).first();
      if(!policy) throw settlementConflict();
      const existing=await trx("merchant_period_statement").where({merchant_id:input.merchant_id,store_id:input.store_id,
        currency:"zar",period_start:input.period_start}).whereNull("superseded_by").first();
      if(existing) {
        if(existing.policy_id!==policy.id) throw settlementConflict();
        await trx.raw("select gospaza_settlement_consistent(?)",[existing.id]);
        return String(existing.id);
      }
      return this.build(trx,actor,input);
    });
    return {statement_id:statement};
  }
  private async build(trx:Knex.Transaction,actor:string,input:{merchant_id:string;store_id:string;policy_id:string;period_start:string},old?:Statement,reason?:string) {
    const {rows:[period]}=await trx.raw(`select p.*,b.*,clock_timestamp()>b.end_at as closed from settlement_period_policy p
      cross join lateral gospaza_settlement_period(p.activation_at,?::timestamptz) b where p.id=?`,[input.period_start,input.policy_id]);
    if(!period || !period.closed || new Date(period.start_at).toISOString()!==new Date(input.period_start).toISOString()
      || period.start_at<period.first_start) throw settlementConflict();
    const previous=await trx<Statement>("merchant_period_statement").where({merchant_id:input.merchant_id,store_id:input.store_id,
      currency:"zar",period_end:period.start_at}).whereNull("superseded_by").first();
    if(period.start_at>period.first_start && (!previous || previous.status!=="READY_FOR_APPROVAL" && !previous.finalized_at)) throw settlementConflict();
    // A carry cannot move on while its originating draft remains actionable.
    const carry=previous && await trx("settlement_carry_effect").where({statement_id:previous.id}).first();
    if(old && await trx("settlement_carry_claim").where({source_statement_id:old.id}).whereNotNull("statement_id").first()) throw settlementConflict();
    const statement=id("mstmt_");
    if(old) await trx("merchant_period_statement").where({id:old.id}).update({superseded_by:statement,
      superseded_at:trx.fn.now(),superseded_actor:actor,superseded_reason:reason,revision:old.revision+1});
    // Query timestamps remain in PostgreSQL: INSERT SELECT preserves microseconds.
    const sources=await trx.raw(`select p.id,p.entitlement_minor from marketplace_finance_posting p
      join order_finance_snapshot s on s.id=p.snapshot_id left join settlement_source_claim c on c.posting_id=p.id
      where s.merchant_id=? and s.store_id=? and s.currency='zar' and s.state='RESOLVED'
      and p.economic_at>=?::timestamptz and p.economic_at<?::timestamptz and p.recorded_at<=?::timestamptz
      and (c.posting_id is null or c.statement_id is null or c.statement_id=?)
      and not exists(select 1 from order_finance_exception x where x.snapshot_id=s.id) order by p.id`,
      [input.merchant_id,input.store_id,period.activation_at,period.end_at,period.end_at,old?.id??null]);
    const postingIds:string[]=sources.rows.map((p:{id:string})=>p.id);
    const amounts=settlementAmounts(sources.rows.map((p:{entitlement_minor:string})=>p.entitlement_minor),carry?.amount_minor??0);
    const {rows:[totals]}=await trx.raw(`select coalesce(sum(merchandise_minor),0) merchandise_minor,
      coalesce(sum(tax_minor),0) tax_held_minor,coalesce(sum(subsidy_minor),0) subsidy_minor,
      coalesce(sum(commission_minor),0) commission_minor from marketplace_finance_posting where id=any(?::text[])`,[postingIds]);
    const holds=await trx.raw(`select s.id snapshot_id,s.order_id,p.id posting_id,
      case when p.economic_at<?::timestamptz then 'HISTORICAL_CATCH_UP' else 'UNRESOLVED_FINANCE' end reason,
      p.entitlement_minor held_minor from order_finance_snapshot s left join marketplace_finance_posting p on p.snapshot_id=s.id
      left join settlement_source_claim c on c.posting_id=p.id
      where s.merchant_id=? and s.store_id=? and s.currency='zar' and s.recorded_at<=?::timestamptz
      and (c.posting_id is null or c.statement_id is null or c.statement_id=?)
      and ((p.economic_at<?::timestamptz and p.recorded_at<=?::timestamptz and (p.economic_at<?::timestamptz
        or exists(select 1 from order_finance_exception x where x.snapshot_id=s.id)))
        or (p.id is null and (s.state='UNRESOLVED' or exists(select 1 from order_finance_exception x where x.snapshot_id=s.id)))) order by s.id`,
      [period.activation_at,input.merchant_id,input.store_id,period.end_at,old?.id??null,period.end_at,period.end_at,period.activation_at]);
    await trx("merchant_period_statement").insert({id:statement,merchant_id:input.merchant_id,store_id:input.store_id,currency:"zar",
      policy_id:input.policy_id,policy_version:period.version,period_start:period.start_at,period_end:period.end_at,cutoff:period.end_at,version:(old?.version??0)+1,
      actor_id:actor,manifest_fingerprint:"PENDING",included_count:postingIds.length,excluded_count:holds.rows.length,...totals,...amounts});
    await trx.raw(`insert into settlement_item select ?,p.id,p.snapshot_id,s.order_id,p.economic_at,p.recorded_at,
      p.economic_at<?::timestamptz,p.merchandise_minor,p.tax_minor,p.subsidy_minor,p.commission_minor,p.entitlement_minor
      from marketplace_finance_posting p join order_finance_snapshot s on s.id=p.snapshot_id where p.id=any(?::text[])`,[statement,period.start_at,postingIds]);
    if(holds.rows.length) await trx("settlement_exclusion").insert(holds.rows.map((row:Record<string,unknown>)=>({statement_id:statement,...row})));
    for(const posting of postingIds) {
      const claim=await trx("settlement_source_claim").where({posting_id:posting}).forUpdate().first();
      if(claim) await trx("settlement_source_claim").where({posting_id:posting}).update({statement_id:statement});
      else await trx("settlement_source_claim").insert({posting_id:posting,statement_id:statement});
    }
    if(old) await trx("settlement_source_claim").where({statement_id:old.id}).update({statement_id:null});
    if(carry) {
      const claimed=await trx("settlement_carry_claim").where({source_statement_id:carry.statement_id}).forUpdate().first();
      if(claimed) {
        if(claimed.statement_id!==old?.id) throw settlementConflict();
        await trx("settlement_carry_claim").where({source_statement_id:carry.statement_id}).update({statement_id:statement});
      } else await trx("settlement_carry_claim").insert({source_statement_id:carry.statement_id,statement_id:statement});
    }
    if(amounts.outgoing_carry_minor<0) await trx("settlement_carry_effect").insert({statement_id:statement,amount_minor:amounts.outgoing_carry_minor});
    if(amounts.payable_minor>0) await trx("payable_settlement").insert({id:id("mpay_"),statement_id:statement,
      amount_minor:amounts.payable_minor,currency:"zar",status:"DRAFT"});
    await trx.raw("update merchant_period_statement set manifest_fingerprint=gospaza_settlement_manifest(id) where id=?",[statement]);
    await this.audit(trx,statement,actor,"GENERATED","generation:"+statement,digest(input),"Authoritative period generation",1);
    await trx.raw("select gospaza_settlement_consistent(?)",[statement]);
    return statement;
  }
  private async audit(trx:Knex.Transaction,statement:string,actor:string,action:string,request:string,fingerprint:string,reason:string,revision:number) {
    await trx("settlement_transition_audit").insert({id:id("msta_"),statement_id:statement,actor_id:actor,action,
      request_id:request,request_fingerprint:fingerprint,reason,revision});
  }
  async prepare(actor:string,statement:string,value:unknown) {return this.decide(actor,statement,value,false);}
  async supersede(actor:string,statement:string,value:unknown) {return this.decide(actor,statement,value,true);}
  private async decide(actor:string,statement:string,value:unknown,replace:boolean) {
    await this.authorize(actor,"PREPARE");financialParse(resourceId,statement);
    const input=financialParse(settlementDecision,value),fingerprint=digest({actor,statement,replace,...input});
    const result=await this.db.transaction(async trx=>{
      const initial=await trx<Statement>("merchant_period_statement").where({id:statement}).first();if(!initial) throw missing();
      await this.merchantLock(trx,initial.merchant_id,initial.store_id);
      await this.authorize(actor,"PREPARE");
      const replay=await trx("settlement_transition_audit").where({request_id:input.request_id}).first();
      if(replay) {if(replay.request_fingerprint!==fingerprint) throw settlementConflict();
        const prior=await trx<Statement>("merchant_period_statement").where({id:statement}).first();
        if(!prior || replace && !prior.superseded_by) throw settlementConflict();
        return replace?String(prior.superseded_by):statement;}
      const row=await trx<Statement>("merchant_period_statement").where({id:statement}).forUpdate().first();
      if(!row || row.status!=="DRAFT" || row.superseded_by || row.finalized_at || row.revision!==input.expected_revision) throw settlementConflict();
      if(replace) {
        const replacement=await this.build(trx,actor,{merchant_id:row.merchant_id,store_id:row.store_id,policy_id:row.policy_id,
          period_start:new Date(row.period_start).toISOString()},row,input.reason);
        await this.audit(trx,statement,actor,"SUPERSEDED",input.request_id,fingerprint,input.reason,row.revision+1);
        return replacement;
      }
      await trx.raw("select gospaza_settlement_consistent(?)",[statement]);
      if(await trx("settlement_item as i").join("order_finance_exception as x","x.snapshot_id","i.snapshot_id").where("i.statement_id",statement).first()) throw settlementConflict();
      const positive=BigInt(row.payable_minor)>0n;
      await trx("merchant_period_statement").where({id:statement}).update(positive?{status:"READY_FOR_APPROVAL",revision:row.revision+1}
        :{finalized_at:trx.fn.now(),revision:row.revision+1});
      if(positive) await trx("payable_settlement").where({statement_id:statement}).update({status:"READY_FOR_APPROVAL"});
      await this.audit(trx,statement,actor,positive?"READY":"FINALIZED",input.request_id,fingerprint,input.reason,row.revision+1);
      return statement;
    });
    return {statement_id:result};
  }
  async read(actor:string,statement:string) {
    await this.authorize(actor,"VIEW");financialParse(resourceId,statement);
    return this.db.transaction(async trx=>{
      const row=await trx("merchant_period_statement").where({id:statement}).first();if(!row) throw missing();
      // B platform-only projection. No proof, customer or native payment objects.
      const items=await trx("settlement_item").where({statement_id:statement}).orderBy("posting_id");
      const exclusions=await trx("settlement_exclusion").where({statement_id:statement}).orderBy("snapshot_id");
      const payable=await trx("payable_settlement").where({statement_id:statement}).first("id","status","revision","amount_minor","currency");
      await this.authorize(actor,"VIEW");
      return {statement:{id:row.id,merchant_id:row.merchant_id,store_id:row.store_id,currency:row.currency,
        policy_id:row.policy_id,policy_version:row.policy_version,period_start:row.period_start,period_end:row.period_end,cutoff:row.cutoff,
        version:row.version,revision:row.revision,status:row.status,superseded_by:row.superseded_by,
        finalized_at:row.finalized_at,included_count:row.included_count,excluded_count:row.excluded_count,
        merchandise_minor:row.merchandise_minor,tax_held_minor:row.tax_held_minor,subsidy_minor:row.subsidy_minor,
        commission_minor:row.commission_minor,current_effects_minor:row.current_effects_minor,
        incoming_carry_minor:row.incoming_carry_minor,net_minor:row.net_minor,payable_minor:row.payable_minor,
        outgoing_carry_minor:row.outgoing_carry_minor},
        items:items.map(i=>({posting_id:i.posting_id,order_id:i.order_id,economic_at:i.economic_at,recorded_at:i.recorded_at,
          prior_period:i.prior_period,merchandise_minor:i.merchandise_minor,tax_held_minor:i.tax_held_minor,
          subsidy_minor:i.subsidy_minor,commission_minor:i.commission_minor,entitlement_minor:i.entitlement_minor})),
        exclusions:exclusions.map(h=>({order_id:h.order_id,posting_id:h.posting_id,reason:h.reason,held_minor:h.held_minor})),
        payable:payable??null,tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"};
    });
  }
  // One explicit merchant/period per call; repair has the exact generation guards.
  async repair(actor:string,value:unknown) {return this.generate(actor,value);}
}
