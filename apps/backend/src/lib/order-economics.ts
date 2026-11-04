import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { AdminOrderEconomics, MerchantOrderEconomics } from "@gospaza/contracts";
import { saleLifecycle } from "./marketplace-recognition";
import { CommissionService } from "./commission-service";
import { hasFinancialCapability, safeSum } from "../modules/marketplace/financial-policy";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import type MarketplaceService from "../modules/marketplace/service";

const iso=(date:Date|string)=>new Date(date).toISOString();
export class OrderEconomics {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer) { this.db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  private async project(trx:Knex.Transaction,id:string,tenant?:{merchant:{id:string};store:{id:string}}) {
    const query=trx("order_operation").where({medusa_order_id:id}).whereNull("deleted_at");
    if(tenant) query.where({merchant_id:tenant.merchant.id,merchant_store_id:tenant.store.id});
    const op=await query.forUpdate().first();
    if(!op) throw new MedusaError(MedusaError.Types.NOT_FOUND,"Order unavailable.");
    const s=await trx("order_finance_snapshot").where({order_operation_id:op.id,merchant_id:op.merchant_id,store_id:op.merchant_store_id,order_id:id})
      .select("id","basis_points","rule_id","state",trx.raw("evidence->>'basis_minor' as original_basis")).first();
    const p=s && await trx("marketplace_finance_posting").where({snapshot_id:s.id})
      .first("merchandise_minor","tax_minor","subsidy_minor","commission_minor","entitlement_minor","economic_at","recorded_at");
    const exceptions=s ? await trx("order_finance_exception").where({snapshot_id:s.id}).orderBy("recorded_at").select("reason","recorded_at"):[];
    const lifecycle=p?{state:"DELIVERED" as const}:await saleLifecycle(trx,this.container,op,false,!!s);
    const state:MerchantOrderEconomics["state"]=lifecycle.state==="KNOWN_ZERO"?"KNOWN_ZERO":
      exceptions.length || s?.state==="UNRESOLVED"?"UNRESOLVED":p?"EARNED":s?"RESOLVED":"PENDING";
    const posted=p?{
        merchandise_minor:Number(p.merchandise_minor),tax_minor:Number(p.tax_minor),subsidy_minor:Number(p.subsidy_minor),
        basis_minor:safeSum([Number(p.merchandise_minor),Number(p.subsidy_minor)]),
        commission_minor:Number(p.commission_minor),entitlement_minor:Number(p.entitlement_minor),economic_at:iso(p.economic_at),
      }:null;
    const merchant:MerchantOrderEconomics={
      order_id:id,currency:"zar",state,basis_points:s?.basis_points??null,
      zero_reason:lifecycle.state==="KNOWN_ZERO"?lifecycle.reason:null,
      earned:state==="EARNED"?posted:null,
    };
    return {merchant,s,p,op,exceptions,posted};
  }
  async merchant(identity:string,id:string) {
    return withMerchantAuthorization(this.db,this.container.resolve<MarketplaceService>("marketplace"),identity,"MERCHANT_ORDER_VIEW",
      async(trx,tenant)=>(await this.project(trx,id,tenant)).merchant);
  }
  async platform(actor:string,id:string):Promise<AdminOrderEconomics> {
    await new CommissionService(this.container).preparePlatformRead(actor,id);
    return this.db.transaction(async trx=>{
      const {merchant,s,p,op,exceptions,posted}=await this.project(trx,id);
      const rule=s?.rule_id && await trx("commission_rule").where({id:s.rule_id}).first("effective_at","revision");
      if(!hasFinancialCapability(actor,"VIEW")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Finance read required.");
      return {...merchant,merchant_id:op.merchant_id,store_id:op.merchant_store_id,snapshot_state:s?.state??null,
        rule_id:s?.rule_id??null,rule_revision:rule?.revision??null,rule_effective_at:rule?iso(rule.effective_at):null,
        evidence:{basis_minor:s?.original_basis==null?null:Number(s.original_basis)},recorded_at:p?iso(p.recorded_at):null,
        posting:posted?{kind:"DELIVERY_RECOGNITION",amounts:posted,recorded_at:iso(p.recorded_at)}:null,
        exceptions:exceptions.map(e=>({reason:e.reason,recorded_at:iso(e.recorded_at)}))};
    });
  }
}
