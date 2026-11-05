import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { financialParse } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { settlementConflict } from "../modules/marketplace/merchant-settlement-policy";
import { approveSettlement, recordPayout, recordPayoutFailure, retryPayout, reconcilePayout, payoutDiscrepancy,
  payoutNext, exactPayout, payoutTimeValid,settlementActionAllowed, type PayoutAction, type PayoutState } from "../modules/marketplace/merchant-payout-policy";

const id=(prefix:string)=>prefix+randomUUID();
const missing=()=>new MedusaError(MedusaError.Types.NOT_FOUND,"Settlement resource not found.");
const fingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pageInput=z.object({after:resourceId.optional(),limit:z.coerce.number().int().min(1).max(25).default(20)}).strict();
type Command={action:"APPROVE";input:z.infer<typeof approveSettlement>}
  |{action:"PAY";input:z.infer<typeof recordPayout>}
  |{action:"FAIL";input:z.infer<typeof recordPayoutFailure>}
  |{action:"RETRY";input:z.infer<typeof retryPayout>}
  |{action:"RECONCILE";input:z.infer<typeof reconcilePayout>}
  |{action:"DISCREPANCY";input:z.infer<typeof payoutDiscrepancy>};
function parseCommand(action:PayoutAction,value:unknown):Command {
  switch(action) {
    case "APPROVE":return {action,input:financialParse(approveSettlement,value)};
    case "PAY":return {action,input:financialParse(recordPayout,value)};
    case "FAIL":return {action,input:financialParse(recordPayoutFailure,value)};
    case "RETRY":return {action,input:financialParse(retryPayout,value)};
    case "RECONCILE":return {action,input:financialParse(reconcilePayout,value)};
    case "DISCREPANCY":return {action,input:financialParse(payoutDiscrepancy,value)};
    default:throw new MedusaError(MedusaError.Types.INVALID_DATA,"Unsupported settlement command.");
  }
}
type Payable={id:string;statement_id:string;amount_minor:string;currency:string;status:PayoutState;revision:number};
type Action={id:string;payable_id:string;action:PayoutAction;actor_id:string;recorded_at:Date;prior_revision:number;
  new_revision:number;from_status:PayoutState;to_status:PayoutState;amount_minor:string;currency:string;request_fingerprint:string;
  request_id:string;reason:string;confirmed:boolean};

// Records operational assertions only. No bank/provider/payment API is called.
export class MerchantPayouts {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer,db?:Knex) {this.db=db??container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);}
  private allowed(actor:string,action:PayoutAction|"VIEW"|"EVIDENCE") {
    return settlementActionAllowed(actor,action);
  }
  private async authorize(actor:string,action:PayoutAction|"VIEW"|"EVIDENCE") {
    if(!this.allowed(actor,action)) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Settlement action capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor);
    if(!this.allowed(actor,action)) throw new MedusaError(MedusaError.Types.FORBIDDEN,"Settlement action capability required.");
  }
  private async lock(trx:Knex.Transaction,payable:string) {
    const initial=await trx<Payable>("payable_settlement").where({id:payable}).first();if(!initial) throw missing();
    const source=await trx("merchant_period_statement").where({id:initial.statement_id}).first();if(!source) throw missing();
    await trx("merchant").where({id:source.merchant_id}).forUpdate().first();
    const statement=await trx("merchant_period_statement").where({id:source.id}).forUpdate().first();
    const row=await trx<Payable>("payable_settlement").where({id:payable}).forUpdate().first();
    if(!row || !statement || statement.superseded_by || statement.status!=="READY_FOR_APPROVAL") throw settlementConflict();
    return {row,statement};
  }
  async execute(actor:string,payable:string,action:PayoutAction,value:unknown) {
    await this.authorize(actor,action);financialParse(resourceId,payable);
    const command=parseCommand(action,value),input=command.input;
    const digest=fingerprint({actor,payable,action,input});
    try {
      return await this.db.transaction(async trx=>{
        const {row,statement}=await this.lock(trx,payable);
        await this.authorize(actor,action);
        const replay=await trx<Action>("merchant_settlement_command").where({request_id:input.request_id}).first();
        if(replay) {if(replay.request_fingerprint!==digest) throw settlementConflict();return this.result(trx,replay,row);}
        if(row.revision!==input.expected_revision) throw settlementConflict();
        const next=payoutNext(row.status,action);
        if(["APPROVE","PAY","RETRY","RECONCILE"].includes(action)) {
          if(await trx("merchant_settlement_discrepancy").where({payable_id:payable,status:"OPEN"}).first()) throw settlementConflict();
          await trx.raw("select gospaza_settlement_consistent(?)",[row.statement_id]);
        }
        let approval:Action|undefined;
        if(action==="PAY" || action==="FAIL") {
          approval=await trx<Action>("merchant_settlement_command").where({payable_id:payable}).whereIn("action",["APPROVE","RETRY"]).orderBy("new_revision","desc").first();
          if(!approval) throw settlementConflict();
          const actual=command.action==="PAY"?command.input.transferred_at:command.action==="FAIL"?command.input.attempted_at:null;
          const {rows:[time]}=await trx.raw("select recorded_at,clock_timestamp() as current_at from merchant_settlement_command where id=?",[approval.id]);
          // Millisecond preflight uses database time; the receipt trigger also
          // compares exact PostgreSQL timestamp precision before persistence.
          if(!actual || !time || !payoutTimeValid(actual,time.recorded_at,time.current_at)) throw settlementConflict();
        }
        if(command.action==="PAY") exactPayout(command.input.amount_minor,row.amount_minor,command.input.currency,row.currency);
        if(command.action==="RETRY") {
          const failure=await trx("merchant_payout_failure as f").join("merchant_settlement_command as a","a.id","f.command_id")
            .where({"f.id":command.input.failed_attempt_id,"f.payable_id":payable,"a.new_revision":row.revision}).first("f.id");
          if(!failure) throw settlementConflict();
        }
        if(command.action==="RECONCILE") {
          exactPayout(command.input.amount_minor,row.amount_minor,command.input.currency,row.currency);
          const e=command.input;
          const match=await trx("merchant_payout_receipt as r").join("merchant_payout_identity as i","i.id","r.identity_id")
            .where({"r.id":e.receipt_id,"r.payable_id":payable,"r.beneficiary_reference":e.beneficiary_reference,
              "r.amount_minor":e.amount_minor,"r.currency":e.currency,"r.transferred_at":e.transferred_at,
              "i.channel":e.channel,"i.origin_reference":e.origin_reference,"i.external_transfer_id":e.external_transfer_id}).first("r.id");
          if(!match) throw settlementConflict();
        }
        const [audit]=await trx<Action>("merchant_settlement_command").insert({id:id("mscmd_"),payable_id:payable,action,
          actor_id:actor,prior_revision:row.revision,new_revision:row.revision+(action==="DISCREPANCY"?0:1),from_status:row.status,
          to_status:next,request_id:input.request_id,request_fingerprint:digest,reason:input.reason,confirmed:input.confirmed,
          amount_minor:row.amount_minor,currency:row.currency}).returning("*");
        if(!audit) throw settlementConflict();
        let identity:string|null=null;
        if((command.action==="PAY" || command.action==="FAIL") && command.input.external_transfer_id) {
          identity=id("mtid_");
          await trx("merchant_payout_identity").insert({id:identity,payable_id:payable,command_id:audit.id,channel:command.input.channel,
            origin_reference:command.input.origin_reference,external_transfer_id:command.input.external_transfer_id});
        }
        if(command.action==="PAY") {
          if(!approval) throw settlementConflict();
          await trx("merchant_payout_receipt").insert({id:id("mreceipt_"),payable_id:payable,statement_id:statement.id,
            merchant_id:statement.merchant_id,store_id:statement.store_id,command_id:audit.id,approval_command_id:approval.id,
            identity_id:identity,amount_minor:row.amount_minor,currency:row.currency,beneficiary_reference:command.input.beneficiary_reference,
            transferred_at:command.input.transferred_at,evidence_reference:command.input.evidence_reference??null});
        } else if(command.action==="FAIL") {
          if(!approval) throw settlementConflict();
          await trx("merchant_payout_failure").insert({id:id("mfail_"),payable_id:payable,command_id:audit.id,approval_command_id:approval.id,
            identity_id:identity,beneficiary_reference:command.input.beneficiary_reference,channel:command.input.channel,
            origin_reference:command.input.origin_reference,attempted_at:command.input.attempted_at,
            failure_category:command.input.failure_category,nonreceipt_confirmed:true,evidence_reference:command.input.evidence_reference});
        } else if(command.action==="RETRY") await trx("merchant_payout_retry").insert({command_id:audit.id,
          failed_attempt_id:command.input.failed_attempt_id,review_reference:command.input.review_reference});
        else if(command.action==="RECONCILE") await trx("merchant_payout_reconciliation").insert({command_id:audit.id,payable_id:payable,
          receipt_id:command.input.receipt_id,review_reference:command.input.review_reference});
        else if(command.action==="DISCREPANCY") await trx("merchant_settlement_discrepancy").insert({id:id("mdisc_"),payable_id:payable,
          command_id:audit.id,category:command.input.category,evidence_reference:command.input.evidence_reference});
        if(action!=="DISCREPANCY") await trx("payable_settlement").where({id:payable}).update({status:next,revision:row.revision+1});
        return this.result(trx,audit,{...row,status:next,revision:audit.new_revision});
      });
    } catch(error) {
      if(error && typeof error==="object" && "code" in error && error.code==="23514" && "constraint" in error
        && error.constraint==="merchant_payout_time") throw settlementConflict();
      if(error && typeof error==="object" && "code" in error && error.code==="23505" && "constraint" in error
        && ["merchant_payout_transfer_unique","merchant_payout_receipt_payable_id_key","merchant_settlement_command_request_id_key","merchant_settlement_one_transition"].includes(String(error.constraint))) throw settlementConflict();
      throw error;
    }
  }
  private async result(trx:Knex.Transaction,audit:Action,current:Payable) {
    const receipt=await trx("merchant_payout_receipt").where({command_id:audit.id}).first("id");
    const failed=await trx("merchant_payout_failure").where({command_id:audit.id}).first("id");
    const discrepancy=await trx("merchant_settlement_discrepancy").where({command_id:audit.id}).first("id");
    const attention=await trx("merchant_settlement_discrepancy").where({payable_id:audit.payable_id,status:"OPEN"}).first("id");
    return {payable_id:audit.payable_id,recorded_status:audit.to_status,recorded_revision:audit.new_revision,
      current_status:current.status,current_revision:current.revision,receipt_id:receipt?.id??null,
      failed_attempt_id:failed?.id??null,discrepancy_id:discrepancy?.id??null,attention_required:!!attention};
  }
  async read(actor:string,payable:string) {
    await this.authorize(actor,"VIEW");financialParse(resourceId,payable);
    return this.db.transaction(async trx=>{
      const row=await trx<Payable>("payable_settlement").where({id:payable}).first();if(!row) throw missing();
      const statement=await trx("merchant_period_statement").where({id:row.statement_id}).first("merchant_id","store_id");
      const history=await trx("merchant_settlement_command").where({payable_id:payable}).orderBy("recorded_at").select("action","actor_id","recorded_at","prior_revision","new_revision");
      const receipt=await trx("merchant_payout_receipt").where({payable_id:payable}).first("id","amount_minor","currency","transferred_at","recorded_at");
      const failures=await trx("merchant_payout_failure").where({payable_id:payable}).orderBy("recorded_at").select("id","failure_category","attempted_at","recorded_at");
      const discrepancies=await trx("merchant_settlement_discrepancy").where({payable_id:payable}).orderBy("recorded_at").select("id","category","status","recorded_at");
      const reconciliation=await trx("merchant_payout_reconciliation as r").join("merchant_settlement_command as a","a.id","r.command_id")
        .where("r.payable_id",payable).first("r.receipt_id","a.actor_id","a.recorded_at");
      await this.authorize(actor,"VIEW");
      return {payable:{id:row.id,statement_id:row.statement_id,merchant_id:statement?.merchant_id,store_id:statement?.store_id,
        amount_minor:row.amount_minor,currency:row.currency,status:row.status,revision:row.revision},history,receipt:receipt??null,failures,
        reconciliation:reconciliation??null,discrepancies};
    });
  }
  async evidence(actor:string,payable:string) {
    await this.authorize(actor,"EVIDENCE");financialParse(resourceId,payable);
    return this.db.transaction(async trx=>{
      if(!await trx("payable_settlement").where({id:payable}).first("id")) throw missing();
      const receipt=await trx("merchant_payout_receipt as r").join("merchant_payout_identity as i","i.id","r.identity_id")
        .where("r.payable_id",payable).first("r.id","r.amount_minor","r.currency","r.beneficiary_reference","r.transferred_at","r.evidence_reference","i.channel","i.origin_reference","i.external_transfer_id");
      const failures=await trx("merchant_payout_failure as f").leftJoin("merchant_payout_identity as i","i.id","f.identity_id")
        .where("f.payable_id",payable).orderBy("f.recorded_at").select("f.id","f.beneficiary_reference","f.channel","f.origin_reference","f.attempted_at",
          "f.failure_category","f.nonreceipt_confirmed","f.evidence_reference","i.external_transfer_id");
      const discrepancies=await trx("merchant_settlement_discrepancy").where({payable_id:payable}).select("id","category","status","evidence_reference","recorded_at");
      const reviews=await trx("merchant_payout_retry as r").join("merchant_settlement_command as a","a.id","r.command_id")
        .where("a.payable_id",payable).orderBy("a.recorded_at").select("r.failed_attempt_id","r.review_reference","a.actor_id","a.recorded_at");
      const reconciliation=await trx("merchant_payout_reconciliation as r").join("merchant_settlement_command as a","a.id","r.command_id")
        .where("r.payable_id",payable).first("r.receipt_id","r.review_reference","a.actor_id","a.recorded_at","a.reason");
      const approvals=await trx("merchant_settlement_command").where({payable_id:payable}).whereIn("action",["APPROVE","RETRY"])
        .orderBy("new_revision").select("action","actor_id","recorded_at","reason","amount_minor","currency");
      await this.authorize(actor,"EVIDENCE");return {receipt:receipt??null,failures,discrepancies,approvals,reviews,reconciliation:reconciliation??null};
    });
  }
  async attention(actor:string,value:unknown) {
    await this.authorize(actor,"VIEW");const page=financialParse(pageInput,value);
    const query=this.db("payable_settlement as p").where(builder=>builder.whereIn("p.status",["APPROVED","FAILED","PAID"])
      .orWhereExists(this.db("merchant_settlement_discrepancy as d").select("d.id").whereRaw("d.payable_id=p.id")))
      .orderBy("p.id").limit(page.limit).select("p.id","p.statement_id","p.status","p.revision","p.amount_minor","p.currency");
    if(page.after) query.where("p.id",">",page.after);
    const items=await query;await this.authorize(actor,"VIEW");
    return {items,next_after:items.length===page.limit?items[items.length-1]?.id??null:null};
  }
}
