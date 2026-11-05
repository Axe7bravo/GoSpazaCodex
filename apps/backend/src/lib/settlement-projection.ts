import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type { MerchantSettlementDetail, PlatformSettlementDetail, PlatformSettlementSummary, SettlementSummary,
  SettlementAction, SettlementPage, SettlementState } from "@gospaza/contracts";
import { resourceId } from "../modules/marketplace/team-policy";
import { financialParse } from "../modules/marketplace/financial-policy";
import { settlementAllowed } from "../modules/marketplace/merchant-settlement-policy";
import { payoutNext,settlementActionAllowed } from "../modules/marketplace/merchant-payout-policy";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import type MarketplaceService from "../modules/marketplace/service";

const pageInput=z.object({after:resourceId.optional(),limit:z.coerce.number().int().min(1).max(25).default(20)}).strict();
const iso=(value:Date|string)=>new Date(value).toISOString();
const missing=()=>new MedusaError(MedusaError.Types.NOT_FOUND,"Statement unavailable.");
interface Source {id:string;merchant_id:string;store_id:string;currency:"zar";period_start:Date;period_end:Date;timezone:"Africa/Johannesburg";status:"DRAFT"|"READY_FOR_APPROVAL";
  finalized_at:Date|null;superseded_by:string|null;included_count:number;excluded_count:number;policy_version:string;revision:number;store_name:string;
  merchandise_minor:string;tax_held_minor:string;subsidy_minor:string;commission_minor:string;current_effects_minor:string;incoming_carry_minor:string;
  net_minor:string;payable_minor:string;outgoing_carry_minor:string;payment_id:string|null;payment_status:SettlementState|null;payment_revision:number|null;
  paid_at:Date|null;reconciled_at:Date|null;attention_required:boolean}
const boundedReference=(value:string)=>"…"+value.slice(-6);
export class SettlementProjection {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer,db?:Knex) {this.db=db??container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);}
  private async platform(actor:string) {
    if(!settlementAllowed(actor,"VIEW")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Settlement read capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    if(!settlementAllowed(actor,"VIEW")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Settlement read capability required.");
  }
  private sources(trx:Knex.Transaction) {
    return trx("merchant_period_statement as s").join("merchant_store as store","store.id","s.store_id")
      .join("settlement_period_policy as policy","policy.id","s.policy_id")
      .leftJoin("payable_settlement as p","p.statement_id","s.id")
      .leftJoin("merchant_payout_receipt as receipt","receipt.payable_id","p.id")
      .leftJoin("merchant_payout_reconciliation as review","review.payable_id","p.id")
      .leftJoin("merchant_settlement_command as reviewed","reviewed.id","review.command_id")
      .select("s.*","policy.timezone as timezone","store.name as store_name","p.id as payment_id","p.status as payment_status","p.revision as payment_revision",
        "receipt.transferred_at as paid_at","reviewed.recorded_at as reconciled_at",
        trx.raw("exists(select 1 from merchant_settlement_discrepancy d where d.payable_id=p.id and d.status='OPEN') as attention_required"));
  }
  private summary(s:Source):SettlementSummary {
    return {id:s.id,store_name:s.store_name,period_start:iso(s.period_start),period_end:iso(s.period_end),timezone:s.timezone,currency:s.currency,
      statement_status:s.status,finalized:!!s.finalized_at,superseded:!!s.superseded_by,included_count:s.included_count,excluded_count:s.excluded_count,
      merchandise_minor:String(s.merchandise_minor),tax_held_minor:String(s.tax_held_minor),subsidy_minor:String(s.subsidy_minor),commission_minor:String(s.commission_minor),
      current_effects_minor:String(s.current_effects_minor),incoming_carry_minor:String(s.incoming_carry_minor),net_minor:String(s.net_minor),
      payable_minor:String(s.payable_minor),outgoing_carry_minor:String(s.outgoing_carry_minor),payable_id:s.payment_id,payment_status:s.payment_status,
      paid_at:s.paid_at?iso(s.paid_at):null,reconciled_at:s.reconciled_at?iso(s.reconciled_at):null,attention_required:!!s.attention_required};
  }
  private async detail(trx:Knex.Transaction,s:Source):Promise<MerchantSettlementDetail> {
    const statement=this.summary(s);
    const items=await trx("settlement_item").where({statement_id:s.id}).orderBy("posting_id");
    const holds=await trx("settlement_exclusion").where({statement_id:s.id}).orderBy("snapshot_id");
    const receipt=s.payment_id?await trx("merchant_payout_receipt as r").join("merchant_payout_identity as i","i.id","r.identity_id")
      .where("r.payable_id",s.payment_id).first("r.amount_minor","r.currency","r.transferred_at","i.external_transfer_id"):undefined;
    return {statement,items:items.map(i=>({order_id:String(i.order_id),economic_at:iso(i.economic_at),prior_period:!!i.prior_period,entitlement_minor:String(i.entitlement_minor)})),
      holds:holds.map(h=>({order_id:String(h.order_id),category:h.reason==="HISTORICAL_CATCH_UP"?"HISTORICAL_REVIEW":"FINANCIAL_REVIEW",held_minor:h.held_minor==null?null:String(h.held_minor)})),
      payment:receipt?{amount_minor:String(receipt.amount_minor),currency:"zar",transferred_at:iso(receipt.transferred_at),external_reference:boundedReference(String(receipt.external_transfer_id))}:null,
      tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"};
  }
  async platformList(actor:string,value:unknown):Promise<SettlementPage<PlatformSettlementSummary>> {
    await this.platform(actor);const page=financialParse(pageInput,value);
    return this.db.transaction(async trx=>{
      const query=this.sources(trx).whereNull("s.superseded_by").orderBy("s.id").limit(page.limit);
      if(page.after) query.where("s.id",">",page.after);
      const rows:Source[]=await query;const items:PlatformSettlementSummary[]=[];
      for(const s of rows) items.push({...this.summary(s),merchant_id:s.merchant_id,store_id:s.store_id});
      await this.platform(actor);return {items,next_after:rows.length===page.limit?rows[rows.length-1]?.id??null:null};
    },{isolationLevel:"repeatable read"});
  }
  async platformDetail(actor:string,id:string):Promise<PlatformSettlementDetail> {
    await this.platform(actor);financialParse(resourceId,id);
    return this.db.transaction(async trx=>{
      const s:Source|undefined=await this.sources(trx).where("s.id",id).first();if(!s) throw missing();
      const common=await this.detail(trx,s),actions:SettlementAction[]=[];
      if(!s.superseded_by && !s.finalized_at) {
        if(s.status==="DRAFT" && settlementAllowed(actor,"PREPARE")) actions.push("PREPARE","SUPERSEDE");
        if(s.payment_status && !common.statement.attention_required) {
          for(const action of ["APPROVE","PAY","FAIL","RETRY","RECONCILE"] as const) {
            if(!settlementActionAllowed(actor,action)) continue;
            try {payoutNext(s.payment_status,action);actions.push(action);} catch(error) {
              if(!MedusaError.isMedusaError(error)||error.type!==MedusaError.Types.CONFLICT) throw error;
            }
          }
        }
      }
      const preparation=await trx("settlement_transition_audit").where({statement_id:id}).orderBy("recorded_at").select("action","actor_id","recorded_at");
      const commands=s.payment_id?await trx("merchant_settlement_command").where({payable_id:s.payment_id}).orderBy("recorded_at"):[];
      const failures=s.payment_id?await trx("merchant_payout_failure").where({payable_id:s.payment_id}).orderBy("recorded_at"):[];
      const discrepancies=s.payment_id?await trx("merchant_settlement_discrepancy").where({payable_id:s.payment_id}).orderBy("recorded_at"):[];
      await this.platform(actor);
      return {...common,statement:{...common.statement,merchant_id:s.merchant_id,store_id:s.store_id},policy_version:s.policy_version,
        statement_revision:s.revision,payable_revision:s.payment_revision,actions:actions.filter(a=>a==="PREPARE"||a==="SUPERSEDE"?settlementAllowed(actor,"PREPARE"):settlementActionAllowed(actor,a)),
        can_read_evidence:settlementActionAllowed(actor,"EVIDENCE"),
        approved_amount_minor:commands.some(c=>c.action==="APPROVE")?String(s.payable_minor):null,
        history:[...preparation,...commands].map(a=>({action:String(a.action),actor_id:String(a.actor_id),recorded_at:iso(a.recorded_at)})),
        failures:failures.map(f=>({id:String(f.id),category:String(f.failure_category),attempted_at:iso(f.attempted_at)})),
        discrepancies:discrepancies.map(d=>({id:String(d.id),category:String(d.category),status:"OPEN",recorded_at:iso(d.recorded_at)}))};
    },{isolationLevel:"repeatable read"});
  }
  async merchantList(identity:string,value:unknown):Promise<SettlementPage<SettlementSummary>> {
    const page=financialParse(pageInput,value);
    return withMerchantAuthorization(this.db,this.container.resolve<MarketplaceService>("marketplace"),identity,"MERCHANT_SETTLEMENT_VIEW",async(trx,tenant)=>{
      const query=this.sources(trx).where({"s.merchant_id":tenant.merchant.id,"s.store_id":tenant.store.id}).whereNull("s.superseded_by").orderBy("s.id").limit(page.limit);
      if(page.after) query.where("s.id",">",page.after);
      const rows:Source[]=await query;const items=rows.map(s=>this.summary(s));
      return {items,next_after:rows.length===page.limit?rows[rows.length-1]?.id??null:null};
    });
  }
  async merchantDetail(identity:string,id:string):Promise<MerchantSettlementDetail> {
    financialParse(resourceId,id);
    return withMerchantAuthorization(this.db,this.container.resolve<MarketplaceService>("marketplace"),identity,"MERCHANT_SETTLEMENT_VIEW",async(trx,tenant)=>{
      const s:Source|undefined=await this.sources(trx).where({"s.id":id,"s.merchant_id":tenant.merchant.id,"s.store_id":tenant.store.id}).first();
      if(!s) throw missing();return this.detail(trx,s);
    });
  }
}
