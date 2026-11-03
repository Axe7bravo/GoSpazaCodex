import { randomUUID } from "node:crypto";
import type { MedusaContainer, ICustomerModuleService, IUserModuleService, ICartModuleService } from "@medusajs/framework/types";
import { createCartCreditLinesWorkflow, deleteCartCreditLinesWorkflow } from "@medusajs/medusa/core-flows";
import { CartFoundationService } from "./cart-service";
import { assertCheckoutMutable } from "../modules/marketplace/checkout-repository";
import { checkoutMoney, requireUnpaidCart } from "./checkout-native";
import { nativePrice } from "../modules/marketplace/catalogue-policy";
import { applicableBalance } from "../modules/store-credit/policy";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules, MathBN } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import SafeStoreCreditService from "../modules/store-credit/service";
import { financialConflict, financialMinor, financialParse, hasFinancialCapability } from "../modules/marketplace/financial-policy";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { reserveSettlement } from "../modules/marketplace/settlement-repository";
import { resourceId } from "../modules/marketplace/team-policy";
import { readFinancialEconomics } from "./financial-native";
import type { AdjustmentRow } from "./financial-service";

interface Operation {
  id:string; adjustment_id:string; settlement_id:string; order_id:string; customer_id:string; store_id:string;
  amount_minor:string|number; currency:"zar"; account_id:string|null; native_transaction_id:string|null;
  status:"CREATED"|"ISSUING"|"SETTLED"|"FAILED"|"ATTENTION_REQUIRED"; revision:number;
}
const input = z.object({ confirmed:z.literal(true) }).strict();
const unavailable = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Balance unavailable.");

export class StoreCreditSettlement {
  private readonly db:Knex;
  private readonly native:SafeStoreCreditService;
  constructor(private readonly container:MedusaContainer, db?:Knex, native?:SafeStoreCreditService) {
    this.db=db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.native=native ?? container.resolve<SafeStoreCreditService>("store_credit");
  }
  private async registered(customer:string) {
    const record=await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(customer);
    if(record.id!==customer || record.has_account!==true) throw unavailable();
  }
  async balance(customer:string) {
    await this.registered(customer);
    const account=await this.native.customerAccount(customer,false);
    const stats=account ? await this.native.retrieveAccountStats({ account_id:account }):null;
    return { currency:"zar", balance_minor:stats ? financialMinor(MathBN.convert(stats.balance).toFixed()):0 };
  }
  async apply(customer:string,body:unknown) {
    const intent=financialParse(z.object({use_balance:z.boolean()}).strict(),body);
    await this.registered(customer);
    return new CartFoundationService(this.container,customer).withCurrent(undefined,async({cart,context,valid})=>{
      if(!valid) throw financialConflict();
      await assertCheckoutMutable(this.db,context.id);
      await requireUnpaidCart(this.container,cart.id);
      const carts=this.container.resolve<ICartModuleService>(Modules.CART);
      const read=()=>carts.retrieveCart(cart.id,{select:["id","customer_id","currency_code","completed_at","total"],
        relations:["credit_lines","items","items.tax_lines","items.adjustments","shipping_methods","shipping_methods.tax_lines","shipping_methods.adjustments"]});
      const before=await read();
      if(before.completed_at || before.customer_id!==customer || before.currency_code!=="zar") throw financialConflict();
      const lines=before.credit_lines ?? [], account=await this.native.customerAccount(customer,false);
      if(lines.length>1 || lines.some(l=>l.reference!=="store-credit" || l.reference_id!==account)) throw financialConflict();
      const old=lines[0] ? checkoutMoney(lines[0].amount):0;
      const gross=checkoutMoney(before.total)+old;
      if(!Number.isSafeInteger(gross)) throw financialConflict();
      const stats=account && intent.use_balance ? await this.native.retrieveAccountStats({account_id:account}):null;
      const applied=intent.use_balance ? applicableBalance(gross,stats ? financialMinor(MathBN.convert(stats.balance).toFixed()):0):0;
      if(old!==applied) {
        const amount=Number(nativePrice(applied));
        if(checkoutMoney(amount)!==applied) throw financialConflict();
        if(lines.length) await deleteCartCreditLinesWorkflow(this.container).run({input:{id:lines.map(l=>l.id)}});
        if(applied && account) await createCartCreditLinesWorkflow(this.container).run({input:[{cart_id:cart.id,
          amount,reference:"store-credit",reference_id:account,metadata:{}}]});
      }
      const after=await read();
      if(checkoutMoney(after.total)!==gross-applied || (after.credit_lines?.length ?? 0)!==(applied ? 1:0)
        || (applied && (!after.credit_lines?.[0] || after.credit_lines[0].reference_id!==account || checkoutMoney(after.credit_lines[0].amount)!==applied))) throw financialConflict();
      return {currency:"zar",gross_minor:gross,applied_minor:applied,external_payable_minor:gross-applied};
    });
  }
  private async authorize(actor:string) {
    if(!hasFinancialCapability(actor,"ISSUE_STORE_CREDIT")) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Financial capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
  }
  private async audit(trx:Knex.Transaction,row:Operation,actor:string) {
    await trx("store_credit_operation_event").insert({operation_id:row.id,revision:row.revision,status:row.status,actor_id:actor});
  }
  private async transition(trx:Knex.Transaction,row:Operation,actor:string,patch:Record<string,unknown>) {
    const [next]=await trx("store_credit_operation").where({id:row.id,revision:row.revision})
      .update({...patch,revision:row.revision+1,updated_at:trx.fn.now()}).returning("*");
    if(!next) throw financialConflict();
    await this.audit(trx,next,actor);
    return next as Operation;
  }
  private async locked<T>(initial:Operation,work:(trx:Knex.Transaction,row:Operation)=>Promise<T>) {
    return this.db.transaction(async trx=>{
      await trx("financial_adjustment").where({id:initial.adjustment_id}).forUpdate().first();
      await trx("financial_settlement").where({id:initial.settlement_id}).forUpdate().first();
      const row=await trx<Operation>("store_credit_operation").where({id:initial.id}).forUpdate().first();
      if(!row) throw financialConflict();
      return work(trx,row);
    });
  }
  async issue(actor:string,id:string,body:unknown) {
    await this.authorize(actor); financialParse(resourceId,id); financialParse(input,body);
    const operation=await this.db.transaction(async trx=>{
      const adjustment=await trx<AdjustmentRow>("financial_adjustment").where({id}).forUpdate().first();
      if(!adjustment || !adjustment.customer_id || adjustment.status!=="APPROVED" || !adjustment.eligible_methods.includes("STORE_CREDIT")) throw financialConflict();
      const previous=await trx<Operation>("store_credit_operation").where({adjustment_id:id}).first();
      if(previous) return previous;
      const handoff=await readOrderHandoff(trx,adjustment.medusa_order_id);
      if(!handoff || handoff.snapshot.customer_id!==adjustment.customer_id) throw financialConflict();
      const economics=await readFinancialEconomics(this.container,handoff);
      if(!economics.registered || economics.customer_id!==adjustment.customer_id || economics.fingerprint!==adjustment.economics_fingerprint) throw financialConflict();
      const settlement=await reserveSettlement(trx,adjustment,"STORE_CREDIT",Number(adjustment.amount_minor));
      const [row]=await trx<Operation>("store_credit_operation").insert({id:"scop_"+randomUUID(),adjustment_id:id,settlement_id:settlement,
        order_id:adjustment.medusa_order_id,customer_id:adjustment.customer_id,store_id:adjustment.merchant_store_id,
        amount_minor:adjustment.amount_minor,currency:"zar",status:"CREATED",revision:1}).returning("*");
      if(!row) throw financialConflict();
      await this.audit(trx,row,actor);
      return row;
    });
    const projection=(row:Operation)=>({ adjustment_id:row.adjustment_id,status:row.status,currency:row.currency,amount_minor:Number(row.amount_minor) });
    if(operation.status==="SETTLED" || operation.status==="FAILED") return projection(operation);
    let account:string|null;
    try {
      await this.registered(operation.customer_id);
      account=operation.account_id ?? await this.native.customerAccount(operation.customer_id,true);
    } catch {
      return projection(await this.locked(operation,async(trx,row)=>row.status==="CREATED" || row.status==="ISSUING"
        ? this.transition(trx,row,actor,{status:"ATTENTION_REQUIRED",attention_reason:"ACCOUNT_EVIDENCE_UNAVAILABLE"}):row));
    }
    if(!account) throw financialConflict();
    const issuing=await this.locked(operation,async(trx,row)=>{
      if(row.account_id && row.account_id!==account) throw financialConflict();
      if(row.status==="CREATED" || row.status==="ATTENTION_REQUIRED" && !row.account_id)
        return this.transition(trx,row,actor,{account_id:account,status:"ISSUING",attention_reason:null});
      return row;
    });
    if(issuing.status==="SETTLED" || issuing.status==="FAILED") return projection(issuing);
    let transaction:string;
    try {
      transaction=await this.native.issueSettlement(account,issuing.customer_id,issuing.id,Number(issuing.amount_minor));
    } catch {
      return projection(await this.locked(issuing,async(trx,row)=>row.status==="ISSUING"
        ? this.transition(trx,row,actor,{status:"ATTENTION_REQUIRED",attention_reason:"NATIVE_CREDIT_UNCONFIRMED"}):row));
    }
    return projection(await this.locked(issuing,async(trx,row)=>{
      if(row.status==="SETTLED") {
        if(row.native_transaction_id!==transaction) throw financialConflict();
        return row;
      }
      if(!await trx("financial_settlement").where({id:row.settlement_id,state:"RESERVED"}).update({state:"SETTLED",updated_at:trx.fn.now()})) throw financialConflict();
      return this.transition(trx,row,actor,{status:"SETTLED",attention_reason:null,native_transaction_id:transaction,settled_at:trx.fn.now()});
    }));
  }
}
