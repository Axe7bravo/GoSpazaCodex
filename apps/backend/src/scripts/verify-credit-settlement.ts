import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Context, DAL, ExecArgs, IAuthModuleService } from "@medusajs/framework/types";
import type { EntityManager } from "@medusajs/framework/mikro-orm/postgresql";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { Modules } from "@medusajs/framework/utils";
import verifyOrderOperations from "./verify-order-operations";
import { OrderOperationsService } from "../lib/order-operations-service";
import { FinancialService } from "../lib/financial-service";
import { StoreCreditSettlement } from "../lib/store-credit-settlement";
import type SafeStoreCreditService from "../modules/store-credit/service";

// Real native balance + B-approved goodwill + C1 shared reservation. Run all
// financial fixture records under an enclosing PostgreSQL rollback, including
// native transaction readback. Never delete financial history for cleanup.
export default async function verifyCreditSettlement(args:ExecArgs) {
  await verifyOrderOperations(args,async f=>{
    const {container,second}=f.fixture;
    const native=container.resolve<SafeStoreCreditService>("store_credit");
    const auth=await container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(f.platform.identity);
    const user=String(auth.app_metadata?.user_id ?? ""); assert.ok(user);
    const order=await f.complete("c2b-credit",second.variantId,6);
    await new OrderOperationsService(container).ensure(order.orderId);
    f.expect(await f.http(order.person.cookie,"GET","/store/gospaza/balance?customer_id="+f.a.person.id),400);
    f.expect(await f.http(f.ownerA.cookie,"GET","/store/gospaza/balance"),401);
    f.expect(await f.http(order.person.cookie,"POST","/admin/gospaza/financial-adjustments/fadj_foreign/store-credit",{confirmed:true}),401);
    const keys=["FINANCIAL_APPROVE_USER_IDS","FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_ISSUE_STORE_CREDIT_USER_IDS","FINANCIAL_GOODWILL_MAX_BPS"];
    const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    const repository=(native as unknown as {baseRepository_:DAL.RepositoryService}).baseRepository_;
    const rollback=new Error("C2B verification rollback");
    try {
      for(const k of keys.slice(0,3)) process.env[k]=user;
      process.env.FINANCIAL_GOODWILL_MAX_BPS="10000";
      await assert.rejects(repository.transaction<EntityManager>(async manager=>{
        const context:Context<EntityManager>={manager,transactionManager:manager};
        const trx=manager.getTransactionContext<Knex.Transaction>(); assert.ok(trx);
        const finance=new FinancialService(container,trx);
        const created=await finance.goodwill(user,order.orderId,{request_id:"c2b_"+randomUUID(),amount_minor:6342,reason:"CUSTOMER_CARE",confirmed:true});
        const adjustment=await finance.approve(user,created.id,{expected_revision:created.revision,confirmed:true});
        assert.deepEqual(adjustment.eligible_methods,["STORE_CREDIT"]);
        let lose=true;
        const scoped=Object.create(native) as SafeStoreCreditService;
        scoped.customerAccount=(customer,create)=>native.customerAccount(customer,create,context);
        scoped.retrieveAccountStats=(query)=>native.retrieveAccountStats(query,context);
        scoped.issueSettlement=async(account,customer,id,minor)=>{
          const result=await native.issueSettlement(account,customer,id,minor,context);
          if(lose) {lose=false;throw new Error("Lost native credit response");}
          return result;
        };
        const service=new StoreCreditSettlement(container,trx,scoped);
        await assert.rejects(service.issue(user,created.id,{confirmed:true,amount_minor:1}));
        assert.equal((await service.issue(user,created.id,{confirmed:true})).status,"ATTENTION_REQUIRED");
        const reservation=await trx("financial_settlement").where({adjustment_id:created.id}).first();
        assert.equal(reservation.state,"RESERVED");
        assert.equal((await service.balance(order.person.id)).balance_minor,6342);
        assert.equal((await service.balance(f.a.person.id)).balance_minor,0);
        await assert.rejects(trx.transaction(async t=>{await t("financial_settlement").insert({
          id:"fset_"+randomUUID(),adjustment_id:created.id,method:"ORIGINAL_PAYMENT",currency:"zar",amount_minor:1,state:"RESERVED"});}),/Settlement eligibility/);
        assert.equal((await service.issue(user,created.id,{confirmed:true})).status,"SETTLED");
        assert.equal((await service.issue(user,created.id,{confirmed:true})).status,"SETTLED");
        const row=await trx("store_credit_operation").where({adjustment_id:created.id}).first();
        assert.ok(row.native_transaction_id);
        const transactions=await trx("store_credit_account_transaction").where({reference:"gospaza-financial-settlement",reference_id:row.id});
        assert.equal(transactions.length,1); assert.equal(transactions[0].id,row.native_transaction_id);
        assert.equal((await trx("financial_settlement").where({id:reservation.id}).first()).state,"SETTLED");
        await assert.rejects(trx.transaction(async t=>{await t("store_credit_operation_event").where({operation_id:row.id}).delete();}),/append only/);
        await trx.raw("set constraints all immediate");
        throw rollback;
      },{isolationLevel:"read committed"}),err=>err===rollback);
    } finally {
      for(const k of keys) {if(before[k]===undefined) delete process.env[k];else process.env[k]=before[k];}
    }
  });
  console.log("C2B settlement verification passed: R63.42 issued once, response loss recovered, shared reservation settled.");
}
