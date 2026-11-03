import { createHash, randomUUID } from "node:crypto";
import type { FinancialAdjustmentView } from "@gospaza/contracts";
import { orderAdjustment } from "./financial-projection";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type MarketplaceService from "../modules/marketplace/service";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import { resourceId } from "../modules/marketplace/team-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { financialSources } from "../modules/marketplace/financial-sources";
import type { FinancialSource } from "../modules/marketplace/financial-sources";
import { approvalInput, goodwillInput, financialParse, financialConflict, financialPage, goodwillLimit, safeSum, settlementMethod, hasFinancialCapability } from "../modules/marketplace/financial-policy";
import type { FinancialAllocation, SettlementMethod, FinancialReason, FinancialCause, FinancialCapability } from "../modules/marketplace/financial-policy";
import { readFinancialEconomics } from "./financial-native";
import type { FinancialEconomics } from "./financial-native";
import { PickingService } from "./picking-service";
import { OrderOperationsService } from "./order-operations-service";
import { settlementTotals } from "../modules/marketplace/settlement-repository";

export interface AdjustmentRow {
  id:string; order_operation_id:string; medusa_order_id:string; merchant_id:string; merchant_store_id:string; customer_id:string|null;
  source_type:string; source_id:string; source_revision:number; reason:FinancialReason; financial_cause:FinancialCause;
  currency:"zar"; amount_minor:string|number; economic_bound_minor:string|number; allocations:FinancialAllocation[];
  economics_fingerprint:string; eligible_methods:SettlementMethod[]; default_method:SettlementMethod;
  status:"REVIEW_REQUIRED"|"APPROVED"|"ATTENTION_REQUIRED"; revision:number; approved_at:Date|null;
  request_fingerprint:string; policy_version:string; approved_by:string|null; updated_at:Date;
}
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND,"Financial resource not found.");
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class FinancialService {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer, db?:Knex) { this.db=db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  private async platform(id:string, capability:FinancialCapability) {
    if (!hasFinancialCapability(id,capability)) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Financial capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(id);
  }
  private async operation(trx:Knex.Transaction, order:string) {
    const op=await trx<OrderOperationRow>("order_operation").where({ medusa_order_id:order }).whereNull("deleted_at").forUpdate().first();
    if (!op) throw missing();
    return op;
  }
  private async boundary<T>(order:string, work:(trx:Knex.Transaction,op:OrderOperationRow)=>Promise<T>) {
    financialParse(resourceId,order);
    const initial=await this.db<OrderOperationRow>("order_operation").where({ medusa_order_id:order }).whereNull("deleted_at").first();
    if (!initial) throw missing();
    return this.db.transaction(async trx=>{
      await trx("merchant").where({ id:initial.merchant_id }).forUpdate().first();
      const op=await this.operation(trx,order);
      if (op.merchant_id!==initial.merchant_id) throw missing();
      return work(trx,op);
    });
  }
  private async economics(trx:Knex.Transaction,op:OrderOperationRow) {
    const handoff=await readOrderHandoff(trx,op.medusa_order_id);
    if (!handoff || handoff.completion_id!==op.checkout_completion_id) throw financialConflict();
    return readFinancialEconomics(this.container,handoff);
  }
  private async event(trx:Knex.Transaction,row:AdjustmentRow,action:string,actor:string|null) {
    await trx("financial_adjustment_event").insert({ id:"faevt_"+randomUUID(), adjustment_id:row.id, action,
      actor_type:actor ? "user":"system", actor_id:actor, revision:row.revision, occurred_at:await databaseTime(trx),
      evidence:JSON.stringify({ order_id:row.medusa_order_id, merchant_id:row.merchant_id, store_id:row.merchant_store_id,
        reason:row.reason, financial_cause:row.financial_cause, amount_minor:Number(row.amount_minor), currency:row.currency,
        status:row.status, method:row.default_method, revision:row.revision }) });
  }
  private async create(trx:Knex.Transaction,op:OrderOperationRow,economics:FinancialEconomics,source:FinancialSource,actor:string|null=null,request?:unknown) {
    const identity={ source_type:source.type,source_id:source.id,source_revision:source.revision,reason:source.reason };
    const fingerprint=hash(request ?? { ...identity, allocations:source.allocations, cause:source.cause });
    const prior=await trx<AdjustmentRow>("financial_adjustment").where(identity).first();
    if (prior) {
      if (prior.order_operation_id!==op.id || prior.request_fingerprint!==fingerprint) throw financialConflict();
      return prior;
    }
    const method=settlementMethod(source.reason,economics.registered), now=await databaseTime(trx);
    const inserted:AdjustmentRow[]=await trx("financial_adjustment").insert({ id:"fadj_"+randomUUID(),...identity,
      order_operation_id:op.id,medusa_order_id:op.medusa_order_id,merchant_id:op.merchant_id,merchant_store_id:op.merchant_store_id,
      customer_id:economics.customer_id, financial_cause:source.cause, currency:"zar",amount_minor:safeSum(source.allocations.map(a=>a.amount_minor)),
      economic_bound_minor:economics.paid_minor,economics_fingerprint:economics.fingerprint,
      allocations:JSON.stringify(source.allocations),
      eligible_methods:JSON.stringify([method]),default_method:method,
      status:source.review ? "REVIEW_REQUIRED":"APPROVED",revision:1,approved_at:source.review ? null:now,
      request_fingerprint:fingerprint,policy_version:"M18-B-1",
    }).returning("*");
    const row=inserted[0];
    if (!row) throw financialConflict();
    await this.event(trx,row,source.review ? "CREATED_FOR_REVIEW":"AUTOMATICALLY_APPROVED",actor);
    return row;
  }
  private async ensureLocked(trx:Knex.Transaction,op:OrderOperationRow) {
    const economics=await this.economics(trx,op);
    if (await trx("pick_session").where({order_operation_id:op.id,status:"COMPLETED"}).whereNull("deleted_at").first()) {
      await new PickingService(this.container).completedForDispatch(trx,op.merchant_id,op.merchant_store_id,op.medusa_order_id);
    }
    for (const source of await financialSources(trx,op,economics)) await this.create(trx,op,economics,source);
    return this.rows(trx,op.medusa_order_id);
  }
  // Internal ensure only; not an endpoint accepting arbitrary source references.
  async ensure(order:string) { return this.boundary(order,(trx,op)=>this.ensureLocked(trx,op)); }
  private async rows(trx:Knex.Transaction,order:string) {
    return trx<AdjustmentRow>("financial_adjustment").where({ medusa_order_id:order }).orderBy("id");
  }
  private async dto(row:AdjustmentRow, db:Knex|Knex.Transaction=this.db):Promise<FinancialAdjustmentView> {
    const totals=await settlementTotals(db,row.id);
    const credit=await db<{status:NonNullable<FinancialAdjustmentView["credit_operation_state"]>}>("store_credit_operation").where({adjustment_id:row.id}).first();
    const creditStatus:FinancialAdjustmentView["credit_status"]=!credit ? undefined:credit.status==="SETTLED" ? "CREDIT_ADDED"
      :["ATTENTION_REQUIRED","FAILED"].includes(credit.status) ? "REVIEW_PENDING":"PENDING";
    const refund=await db<{status:NonNullable<FinancialAdjustmentView["refund_operation_state"]>}>("refund_operation").where({adjustment_id:row.id}).first();
    const refundStatus:FinancialAdjustmentView["refund_status"]=!refund ? undefined:refund.status==="SETTLED" ? "SUCCEEDED"
      :refund.status==="ATTENTION_REQUIRED" ? "ATTENTION_REQUIRED":["FAILED","FAILED_NOT_CREATED"].includes(refund.status) ? "FAILED":"PENDING";
    return { id:row.id,order_id:row.medusa_order_id,reason:row.reason,financial_cause:row.financial_cause,
      currency:row.currency,amount_minor:Number(row.amount_minor), components:row.allocations.map(a=>({ component:a.component,amount_minor:a.amount_minor })),
      status:row.status,revision:row.revision,eligible_methods:row.eligible_methods,default_method:row.default_method,
      ...totals,refund_status:refundStatus,credit_status:creditStatus,unsettled_minor:Number(row.amount_minor)-totals.settled_minor,
      refund_operation_state:refund?.status,credit_operation_state:credit?.status,
      // Execution remains an explicit platform capability, never a customer or
      // merchant permission inferred from a displayed entitlement.
      execution_available:false };
  }
  private async dtos(rows:AdjustmentRow[],db:Knex|Knex.Transaction=this.db) {
    const result:FinancialAdjustmentView[]=[];
    for(const row of rows) result.push(await this.dto(row,db));
    return result;
  }
  async customer(customer:string,order:string) {
    // Reuse M11 customer/native identity checks before any ensure writes.
    await new OrderOperationsService(this.container).withCustomerOrder(customer,order,async()=>undefined);
    return this.boundary(order,async(trx,op)=>{
      const handoff=await readOrderHandoff(trx,order);
      if (!handoff || handoff.snapshot.customer_id!==customer) throw missing();
      const rows=await this.dtos(await this.ensureLocked(trx,op),trx);
      const snapshot=handoff.snapshot;
      return { adjustments:rows.map(orderAdjustment), funding:{
        gross_minor:snapshot.store_credit?.gross_minor ?? snapshot.totals.total_minor,
        store_credit_minor:snapshot.store_credit?.amount_minor ?? 0,
        original_payment_minor:snapshot.totals.total_minor } };
    });
  }
  async merchant(identity:string,order:string) {
    financialParse(resourceId,order);
    return withMerchantAuthorization(this.db,this.container.resolve<MarketplaceService>("marketplace"),identity,"MERCHANT_ORDER_VIEW",async(trx,tenant)=>{
      const owned=await trx("order_operation").where({ medusa_order_id:order,merchant_id:tenant.merchant.id,merchant_store_id:tenant.store.id }).whereNull("deleted_at").first();
      if (!owned) throw missing();
      const op=await this.operation(trx,order);
      const rows=await this.dtos(await this.ensureLocked(trx,op),trx);
      return { adjustments:rows.map(row=>({...orderAdjustment(row),financial_cause:row.financial_cause})) };
    });
  }
  async adminOrder(user:string,order:string) {
    await this.platform(user,"VIEW");
    return this.boundary(order,async(trx,op)=>{
      await this.platform(user,"VIEW");
      const adjustments=await this.dtos(await this.ensureLocked(trx,op),trx);
      const history=await trx("financial_adjustment_event").whereIn("adjustment_id",adjustments.map(a=>a.id))
        .select("adjustment_id","action","occurred_at","actor_type").orderBy("occurred_at","desc").orderBy("id","desc").limit(30);
      const dispositions=hasFinancialCapability(user,"VIEW_DISPOSITION")
        ? await trx("returned_inventory_disposition").where({order_id:order,store_id:op.merchant_store_id})
          .select("line_id","quantity","decision","status").orderBy("line_id").limit(50) : undefined;
      return {adjustments,history,dispositions};
    });
  }
  async list(user:string,value:unknown) {
    await this.platform(user,"VIEW"); const page=financialParse(financialPage,value);
    const rows=await this.db<AdjustmentRow>("financial_adjustment").orderBy("created_at","desc").orderBy("id").limit(page.limit).offset(page.offset);
    return { adjustments:await this.dtos(rows),...page };
  }
  async approve(user:string,id:string,value:unknown) {
    await this.platform(user,"APPROVE"); financialParse(resourceId,id); const input=financialParse(approvalInput,value);
    const initial=await this.db<AdjustmentRow>("financial_adjustment").where({ id }).first(); if (!initial) throw missing();
    return this.boundary(initial.medusa_order_id,async(trx,op)=>{
      await this.platform(user,"APPROVE");
      const row=await trx<AdjustmentRow>("financial_adjustment").where({ id,order_operation_id:op.id }).forUpdate().first(); if (!row) throw missing();
      if (row.status==="APPROVED") return this.dto(row,trx);
      if (row.status!=="REVIEW_REQUIRED" || row.revision!==input.expected_revision) throw financialConflict();
      const economics=await this.economics(trx,op);
      if (economics.fingerprint!==row.economics_fingerprint) throw financialConflict();
      // Unknown restricted fault is not resolved by a generic approval click.
      if (row.reason!=="GOODWILL") throw financialConflict();
      const goodwill=await trx<AdjustmentRow>("financial_adjustment").where({order_operation_id:op.id,reason:"GOODWILL"});
      if (!economics.registered || safeSum(goodwill.map(item=>Number(item.amount_minor)))>goodwillLimit(economics.paid_minor)) throw financialConflict();
      const [approved]=await trx<AdjustmentRow>("financial_adjustment").where({ id }).update({ status:"APPROVED",revision:row.revision+1,
        approved_at:await databaseTime(trx),updated_at:await databaseTime(trx),approved_by:user }).returning("*");
      if (!approved) throw financialConflict(); await this.event(trx,approved,"MANUALLY_APPROVED",user); return this.dto(approved,trx);
    });
  }
  async goodwill(user:string,order:string,value:unknown) {
    await this.platform(user,"GOODWILL_CREATE"); const input=financialParse(goodwillInput,value);
    return this.boundary(order,async(trx,op)=>{
      await this.platform(user,"GOODWILL_CREATE"); const economics=await this.economics(trx,op);
      await this.ensureLocked(trx,op);
      const existing=await trx<AdjustmentRow>("financial_adjustment").where({ source_type:"GOODWILL",source_id:input.request_id }).first();
      if (!existing) {
        const previous=await trx<AdjustmentRow>("financial_adjustment").where({ order_operation_id:op.id,reason:"GOODWILL" });
        if (safeSum(previous.map(r=>Number(r.amount_minor)).concat(input.amount_minor))>goodwillLimit(economics.paid_minor)) throw financialConflict();
      }
      const row=await this.create(trx,op,economics,{ type:"GOODWILL",id:input.request_id,revision:1,reason:"GOODWILL",cause:"POLICY",review:true,
        allocations:[{ component:"GOODWILL",economic_key:input.request_id,start_unit:0,end_unit:1,amount_minor:input.amount_minor }] },user,{ ...input,order_id:order,actor:user });
      return this.dto(row,trx);
    });
  }
}
