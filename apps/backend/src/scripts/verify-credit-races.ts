import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type SafeStoreCreditService from "../modules/store-credit/service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { FinancialService } from "../lib/financial-service";
import { StoreCreditSettlement } from "../lib/store-credit-settlement";
import { RefundService } from "../lib/refund-service";
import { PaymentInitiationService } from "../lib/payment-initiation-service";
import { checkoutMoney } from "../lib/checkout-native";
import type { AdjustmentRow } from "../lib/financial-service";
import { reserveSettlement } from "../modules/marketplace/settlement-repository";
import { ensureCommerce } from "../lib/commerce";
import { nativeProducts } from "../lib/catalogue-native";
import { createCatalogueProductWorkflow } from "../workflows/create-catalogue-product";
import { reviewFixtureGrocery } from "./fixtures/restricted-commerce";
import { withRetainedCheckoutAfterReconciliation } from "./verify-payment-reconciliation";

export default async function verifyCreditRaces(args:ExecArgs) {
  if(process.env.REFUND_RECOVERY_WORKER_ENABLED==="true") throw new Error("Disable refund recovery in both verifier and backend.");
  await withRetainedCheckoutAfterReconciliation(args,async f=>{
    const {container,second}=f.fixture;
    // Select Medusa's child-scope signature alongside the inherited Awilix overload.
    const scopes: { createScope(): MedusaContainer } = container;
    const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const native=container.resolve<SafeStoreCreditService>("store_credit");
    assert.equal(native.gospazaSafeStoreCredit,"M18-C2A");
    const finance=new FinancialService(container), orders=new OrderOperationsService(container);
    const balance=new StoreCreditSettlement(container);
    const token=randomUUID(), topology=await ensureCommerce(container,second.merchantId);
    const {result:productId}=await createCatalogueProductWorkflow(container).run({input:{
      merchantId:second.merchantId,channelId:topology.channelId,locationId:topology.locationId,
      product:{title:"Credit race "+token,description:"",status:"published",requires_age_verification:false,
        variants:[{title:"Default",sku:token,price_minor:10000,stocked_quantity:24}]}
    }});
    await reviewFixtureGrocery(container,productId);
    const [product]=await nativeProducts(container,[productId]);
    const variant=product?.variants[0]; assert.ok(variant);
    const user=await container.resolve<IUserModuleService>(Modules.USER).createUsers({email:token+"@example.invalid"});
    const grants=["FINANCIAL_APPROVE_USER_IDS","FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_ISSUE_STORE_CREDIT_USER_IDS","FINANCIAL_EXECUTE_REFUND_USER_IDS"];
    const original=new Map([...grants,"FINANCIAL_GOODWILL_MAX_BPS"].map(k=>[k,process.env[k]] as const));
    const goodwill=async(order:string,minor:number)=>{
      const row=await finance.goodwill(user.id,order,{request_id:"race_"+randomUUID(),amount_minor:minor,reason:"CUSTOMER_CARE",confirmed:true});
      return finance.approve(user.id,row.id,{expected_revision:row.revision,confirmed:true});
    };
    const execute={action:"EXECUTE",reason:"APPROVED_ADJUSTMENT",confirmed:true};
    try {
      for(const key of grants) process.env[key]=user.id;
      process.env.FINANCIAL_GOODWILL_MAX_BPS="10000";
      for(const applied of [8000,5000]) {
        const source=await f.complete("race-source-"+applied,variant.id);
        await orders.ensure(source.orderId);
        const issue=async(minor:number)=>{
          const row=await goodwill(source.orderId,minor);
          assert.equal((await balance.issue(user.id,row.id,{confirmed:true})).status,"SETTLED");
        };
        // The server applies the whole available balance. Stage a genuine first
        // credit, freeze that amount, then issue the remainder before racing Pay.
        await issue(applied);
        const account=await native.customerAccount(source.person.id,false); assert.ok(account);
        const spent=new Map<string,number>();
        const paidCarts=new Set<string>();
        for(let round=0;round<(applied===5000 ? 2:1);round++) {
          const result=await f.complete("race-pay-"+applied+"-"+round,variant.id,1,undefined,undefined,{
            customer:source.person,
            async beforeQuote(person) {
              assert.deepEqual(f.expect(await f.http(person.cookie,"POST","/store/gospaza/balance",{use_balance:true})),
                {currency:"zar",gross_minor:10000,applied_minor:applied,external_payable_minor:10000-applied});
            },
            async firstPay(person,input,checkoutPostCount) {
              if(round===0) await issue(10000-applied);
              assert.equal((await balance.balance(person.id)).balance_minor,round===0 ? 10000:5000);
              const pay=()=>new PaymentInitiationService(scopes.createScope(),person.id).initiate(input);
              const beforePosts=checkoutPostCount();
              const results=await Promise.allSettled([pay(),pay()]);
              let ready=0;
              for(const result of results) {
                if(result.status==="fulfilled") {
                  assert.equal(result.value.state,"ready");
                  assert.equal(result.value.attempt_id,input.attempt_id);
                  ready++;
                } else {
                  const error:unknown=result.reason;
                  if(!MedusaError.isMedusaError(error) || error.type!==MedusaError.Types.CONFLICT || error.code!=="CHECKOUT_ALREADY_PROCESSING") throw result.reason;
                }
              }
              assert.ok(ready>=1,"one Pay must succeed; an admitted replay may read the same result");
              assert.equal(checkoutPostCount()-beforePosts,1,"one actual Yoco checkout POST, including replays");
              const [attempt]=await db("checkout_attempt").where({id:input.attempt_id});
              assert.equal(attempt.snapshot.store_credit.amount_minor,applied);
              assert.equal(attempt.snapshot.cart_id,person.cartId);
              assert.ok(!paidCarts.has(person.cartId),"the next legitimate checkout needs a new current cart");
              paidCarts.add(person.cartId);
              const receipts=await db("checkout_credit_redemption").where({attempt_id:input.attempt_id});
              assert.equal(receipts.length,1);
              const [receipt]=receipts;
              assert.equal(receipt.account_id,account);
              assert.equal(Number(receipt.amount_minor),applied);
              assert.equal(Number(receipt.external_minor),10000-applied);
              assert.ok(!spent.has(input.attempt_id));
              spent.set(input.attempt_id,applied);
              const debits=await db("store_credit_account_transaction").where({account_id:account,type:"debit"});
              assert.equal(debits.length,spent.size);
              for(const debit of debits) {
                assert.equal(debit.reference,"gospaza-checkout");
                assert.equal(checkoutMoney(debit.amount),spent.get(debit.reference_id));
              }
              assert.equal(debits.find(d=>d.reference_id===input.attempt_id)?.id,receipt.native_debit_id);
              assert.equal((await balance.balance(person.id)).balance_minor,10000-spent.size*applied);
              const operations=await db("provider_operation").where({checkout_attempt_id:input.attempt_id});
              assert.equal(operations.length,1);
              assert.equal(JSON.parse(operations[0].request_json).amount,10000-applied);
            }
          });
          const completions=await db("checkout_completion").where({checkout_attempt_id:result.attemptId});
          assert.equal(completions.length,1);
          assert.equal(completions[0].order_id,result.orderId);
          assert.equal(completions[0].terminal_receipt.gross_minor,10000);
          assert.equal(completions[0].terminal_receipt.store_credit_minor,applied);
          assert.equal(completions[0].terminal_receipt.amount_minor,10000-applied);
        }
      }

      for(const method of ["STORE_CREDIT","ORIGINAL_PAYMENT"] as const) {
        const source=await f.complete("race-method-"+method,variant.id);
        await orders.ensure(source.orderId);
        if(method==="ORIGINAL_PAYMENT") {
          const owner=await db("merchant_member").where({merchant_id:second.merchantId,member_type:"OWNER"}).first();
          await orders.decide(owner.auth_identity_id,source.orderId,"reject",{expected_revision:0,confirmed:true});
        }
        const adjustment=method==="STORE_CREDIT" ? await goodwill(source.orderId,10000):(await finance.ensure(source.orderId))[0];
        assert.ok(adjustment);
        assert.equal(adjustment.status,"APPROVED");
        assert.equal(Number(adjustment.amount_minor),10000);
        assert.deepEqual(adjustment.eligible_methods,[method]);
        const id=adjustment.id;
        const economics=()=>db("financial_adjustment").where({id}).first();
        const before=await economics();
        const constraints=await db.raw("select pg_get_expr(conbin,conrelid) as expression from pg_constraint where conrelid='financial_adjustment'::regclass and contype='c'");
        assert.ok(constraints.rows.some((c:{expression:string})=>/^\(*eligible_methods\s*=\s*jsonb_build_array\(default_method\)\)*$/.test(c.expression)),
          "The single-method alternative requires the installed database to enforce it.");
        let sends=0;
        const refund=new RefundService(scopes.createScope(),{send:async()=>{sends++;return {kind:"UNKNOWN"};}});
        const credit=new StoreCreditSettlement(scopes.createScope());
        const reservations=()=>db("financial_settlement").where({adjustment_id:id});
        for(const creditMinor of [6000,4000]) {
          const failures=await Promise.allSettled([
            refund.command(user.id,id,{...execute,amount_minor:6000}),
            credit.issue(user.id,id,{confirmed:true,amount_minor:creditMinor})
          ]);
          for(const failed of failures) {
            assert.ok(failed.status==="rejected");
            assert.equal(failed.reason.type,"invalid_data");
          }
          assert.deepEqual(await reservations(),[]);
          assert.equal(sends,0);
        }
        const [cash,creditResult]=await Promise.allSettled([refund.command(user.id,id,execute),credit.issue(user.id,id,{confirmed:true})]);
        const denied=method==="STORE_CREDIT" ? cash:creditResult;
        assert.ok(denied.status==="rejected");
        assert.equal(denied.reason.code,method==="STORE_CREDIT" ? "REFUND_REQUIRES_REVIEW":"FINANCIAL_EVIDENCE_CONFLICT");
        if(method==="STORE_CREDIT") {
          assert.ok(creditResult.status==="fulfilled"); assert.equal(creditResult.value.status,"SETTLED");
          await assert.rejects(refund.command(user.id,id,{action:"RECONCILE",reason:"RECOVER_UNCERTAIN_REQUEST",confirmed:true}),{code:"REFUND_REQUIRES_REVIEW"});
        } else {
          assert.ok(cash.status==="fulfilled"); assert.equal(cash.value.status,"UNKNOWN");
          await assert.rejects(credit.issue(user.id,id,{confirmed:true}),{code:"FINANCIAL_EVIDENCE_CONFLICT"});
        }
        const rows=await reservations();
        assert.equal(rows.length,1);
        assert.equal(rows[0].method,method);
        assert.equal(rows[0].state,method==="STORE_CREDIT" ? "SETTLED":"RESERVED");
        assert.equal(Number(rows[0].amount_minor),10000);
        await assert.rejects(db.transaction(async trx=>{
          const locked=await trx<AdjustmentRow>("financial_adjustment").where({id}).forUpdate().first();
          assert.ok(locked);
          await reserveSettlement(trx,locked,method,1);
        }),/Settlement entitlement exceeded/);
        const credits=await db("store_credit_operation").where({adjustment_id:id});
        const refunds=await db("refund_operation").where({adjustment_id:id});
        assert.equal(credits.length,method==="STORE_CREDIT" ? 1:0);
        assert.equal(refunds.length,method==="ORIGINAL_PAYMENT" ? 1:0);
        assert.equal((credits[0] ?? refunds[0]).settlement_id,rows[0].id);
        assert.equal(sends,refunds.length);
        if(refunds.length) {
          const attempts=await db("provider_refund_attempt").where({refund_operation_id:refunds[0].id});
          assert.equal(attempts.length,1);
          assert.equal(JSON.parse(attempts[0].request_json).amount,10000);
        }
        const account=await native.customerAccount(source.person.id,false);
        const transactions=account ? await db("store_credit_account_transaction").where({account_id:account,type:"credit"}):[];
        assert.equal(transactions.length,credits.length);
        if(credits.length) {
          assert.equal(transactions[0].reference_id,credits[0].id);
          assert.equal(transactions[0].id,credits[0].native_transaction_id);
          assert.equal(checkoutMoney(transactions[0].amount),10000);
        }
        assert.equal((await balance.balance(source.person.id)).balance_minor,credits.length*10000);
        assert.deepEqual(await economics(),before);
      }
    } finally {
      for(const [key,value] of original) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    }
  });
}
