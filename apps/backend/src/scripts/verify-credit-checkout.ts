import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ensureCommerce } from "../lib/commerce";
import { nativeProducts } from "../lib/catalogue-native";
import { FinancialService } from "../lib/financial-service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { StoreCreditSettlement } from "../lib/store-credit-settlement";
import { PaymentInitiationService } from "../lib/payment-initiation-service";
import { createCatalogueProductWorkflow } from "../workflows/create-catalogue-product";
import { reviewFixtureGrocery } from "./fixtures/restricted-commerce";
import verifyPaymentReconciliation from "./verify-payment-reconciliation";
import type { ReconciledOrderFixture } from "./verify-payment-reconciliation";

export default async function verifyCreditCheckout(args: ExecArgs) {
  await verifyPaymentReconciliation(args, async f => { await creditCheckoutFixture(f); },true);
}

export async function creditCheckoutFixture(f:ReconciledOrderFixture) {
    const {container, second} = f.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const source = await f.complete("credit-source", second.variantId, 6);
    await new OrderOperationsService(container).ensure(source.orderId);
    const token = randomUUID();
    const user = await container.resolve<IUserModuleService>(Modules.USER).createUsers({email: token+"@example.invalid"});
    const grants = ["FINANCIAL_APPROVE_USER_IDS","FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_ISSUE_STORE_CREDIT_USER_IDS"];
    const original = new Map([...grants,"FINANCIAL_GOODWILL_MAX_BPS"].map(key => [key,process.env[key]] as const));
    try {
      for (const key of grants) process.env[key]=user.id;
      process.env.FINANCIAL_GOODWILL_MAX_BPS="10000";
      const finance = new FinancialService(container);
      const proposed = await finance.goodwill(user.id,source.orderId,{request_id:"credit_"+token,amount_minor:6342,reason:"CUSTOMER_CARE",confirmed:true});
      await finance.approve(user.id,proposed.id,{expected_revision:proposed.revision,confirmed:true});
      const credit = new StoreCreditSettlement(container);
      const results = await Promise.all([credit.issue(user.id,proposed.id,{confirmed:true}),credit.issue(user.id,proposed.id,{confirmed:true})]);
      assert.ok(results.every(result=>result.status==="SETTLED"));
      assert.deepEqual(await credit.balance(source.person.id),{currency:"zar",balance_minor:6342});
      const sourceView=f.expect(await f.http(source.person.cookie,"GET","/store/gospaza/orders/"+source.orderId+"/financial-resolution"));
      assert.deepEqual(sourceView,{
        funding:{gross_minor:6594,store_credit_minor:0,original_payment_minor:6594},
        adjustments:[{reason:"GOODWILL",amount_minor:6342,currency:"zar",status:"APPROVED",
          default_method:"STORE_CREDIT",settled_minor:6342,credit_status:"CREDIT_ADDED"}],
      },"customer receives only published financial outcomes");
      const topology = await ensureCommerce(container,second.merchantId);
      const {result:productId} = await createCatalogueProductWorkflow(container).run({input:{
        merchantId:second.merchantId,channelId:topology.channelId,locationId:topology.locationId,
        product:{title:"Credit checkout "+token,description:"",status:"published",requires_age_verification:false,
          variants:[{title:"Default",sku:token,price_minor:10000,stocked_quantity:2}]}
      }});
      await reviewFixtureGrocery(container,productId);
      const [product] = await nativeProducts(container,[productId]);
      const variant = product?.variants[0];
      assert.ok(variant);
      const future = await f.complete("credit-redemption",variant.id,1,undefined,undefined,{
        customer:source.person,
        async beforeQuote(person) {
          assert.deepEqual(f.expect(await f.http(person.cookie,"POST","/store/gospaza/balance",{use_balance:true})),
            {currency:"zar",gross_minor:10000,applied_minor:6342,external_payable_minor:3658});
          assert.equal((await credit.balance(person.id)).balance_minor,6342);
        },
        async afterInitiation(person,input) {
          const pay=new PaymentInitiationService(container,person.id);
          await Promise.all([pay.initiate(input),pay.initiate(input)]);
          const debits=await db("store_credit_account_transaction").where({reference:"gospaza-checkout",reference_id:input.attempt_id});
          assert.equal(debits.length,1);
          assert.equal((await db("checkout_credit_redemption").where({attempt_id:input.attempt_id})).length,1);
        }
      });
      assert.equal(future.person.id,source.person.id);
      assert.notEqual(future.orderId,source.orderId);
      const completion = await db("checkout_completion").where({checkout_attempt_id:future.attemptId}).first();
      assert.equal(completion?.terminal_receipt?.gross_minor,10000);
      assert.equal(completion.terminal_receipt.store_credit_minor,6342);
      assert.equal(completion.terminal_receipt.amount_minor,3658);
      const external = await db("provider_operation").where({checkout_attempt_id:future.attemptId}).first();
      assert.equal(Number(external.amount_minor),3658);
      assert.equal(JSON.parse(external.request_json).amount,3658);
      assert.deepEqual(await credit.balance(source.person.id),{currency:"zar",balance_minor:0});
      await new OrderOperationsService(container).ensure(future.orderId);
      assert.deepEqual(f.expect(await f.http(future.person.cookie,"GET","/store/gospaza/orders/"+future.orderId+"/financial-resolution")),
        {funding:{gross_minor:10000,store_credit_minor:6342,original_payment_minor:3658},adjustments:[]});
      const next=await finance.goodwill(user.id,future.orderId,{request_id:"credit_full_"+token,amount_minor:6342,reason:"CUSTOMER_CARE",confirmed:true});
      await finance.approve(user.id,next.id,{expected_revision:next.revision,confirmed:true});
      assert.equal((await credit.issue(user.id,next.id,{confirmed:true})).status,"SETTLED");
      const small=await f.customer("full-funding",second.variantId,1,undefined,future.person);
      f.expect(await f.http(small.cookie,"POST","/store/gospaza/balance",{use_balance:true}),409);
      assert.equal((await credit.balance(small.id)).balance_minor,6342);
      return {customerId:small.id,sourceOrder:source.orderId,mixedOrder:future.orderId,
        variantId:variant.id,cartId:small.cartId,addressId:small.addressId};
    } finally {
      for(const [key,value] of original) {
        if(value===undefined) delete process.env[key];
        else process.env[key]=value;
      }
    }
}
