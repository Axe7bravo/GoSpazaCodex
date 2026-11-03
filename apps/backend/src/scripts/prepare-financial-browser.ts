import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, IAuthModuleService, ICustomerModuleService, IInventoryService, IOrderModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { Modules,ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { FinancialService } from "../lib/financial-service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { RefundService } from "../lib/refund-service";
import { PaymentReconciliationService } from "../lib/payment-reconciliation-service";
import { ReturnedInventory } from "../lib/returned-inventory";
import { pickupInput } from "../modules/marketplace/pickup-policy";
import { yocoConfiguration } from "../lib/yoco-config";
import { fixturePassword,withFinancialBrowserFixture } from "./fixtures/financial-browser";
import { creditCheckoutFixture } from "./verify-credit-checkout";
import verifyRecipient from "./verify-recipient";

export default async function prepareFinancialBrowser(args:ExecArgs) {
  const output=resolve(__dirname,"../../../../test-results/m18-fixtures",randomUUID()+".json");
  let manifest:object|undefined;
  await withFinancialBrowserFixture(()=>verifyRecipient(args,async(f,delivery,returnedOrder,more)=>{
    const {container}=f.fixture;
    const auth=container.resolve<IAuthModuleService>(Modules.AUTH),users=container.resolve<IUserModuleService>(Modules.USER);
    const customers=container.resolve<ICustomerModuleService>(Modules.CUSTOMER),orders=container.resolve<IOrderModuleService>(Modules.ORDER);
    const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const email=async(identity:string)=>{
      const record=await auth.retrieveAuthIdentity(identity,{relations:["provider_identities"]});
      const value=record.provider_identities?.find(x=>x.provider==="emailpass")?.entity_id;
      assert.ok(value?.endsWith("@example.test"));return value;
    };
    const customerEmail=async(id:string)=>(await customers.retrieveCustomer(id)).email;
    const admin=async()=>{
      const email=randomUUID()+"@example.test";
      const user=await users.createUsers({email});
      const registered=await auth.register("emailpass",{body:{email,password:fixturePassword(email)}});
      assert.ok(registered.authIdentity);
      await auth.updateAuthIdentities({id:registered.authIdentity.id,app_metadata:{user_id:user.id}});
      return {email,id:user.id};
    };
    const viewer=await admin(),inventoryViewer=await admin(),deniedAdmin=await admin();
    const mixed=await creditCheckoutFixture(f);
    const finance=new FinancialService(container),operations=new OrderOperationsService(container);
    const grants=["FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_GOODWILL_MAX_BPS","FINANCIAL_EXECUTE_REFUND_USER_IDS"];
    const prior=grants.map(k=>process.env[k]);
    try {
      process.env.FINANCIAL_GOODWILL_CREATE_USER_IDS=viewer.id;
      process.env.FINANCIAL_GOODWILL_MAX_BPS="10000";
      process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS=viewer.id;
      // Guarantee two real queue pages even on a new test database.
      const queueOrder=await f.complete("browser-pagination",f.fixture.second.variantId,2);
      await operations.ensure(queueOrder.orderId);
      for(let index=0;index<21;index++) await finance.goodwill(viewer.id,queueOrder.orderId,{
        request_id:"browser_"+randomUUID(),amount_minor:1,reason:"CUSTOMER_CARE",confirmed:true});
      const config=yocoConfiguration(process.env);
      assert.ok(config && config.secretKey.startsWith("sk_test_"));
      const signingKey=Buffer.from(config.webhookSecret.slice(6),"base64");
      const refunds:Record<string,{order:string;email:string}>={};
      for(const outcome of ["SETTLED","FAILED","UNKNOWN"] as const) {
        const source=await f.complete("browser-refund-"+outcome,f.fixture.second.variantId,1);
        await operations.ensure(source.orderId);
        await operations.decide(f.ownerB.identity,source.orderId,"reject",{expected_revision:0,confirmed:true});
        const [adjustment]=await finance.ensure(source.orderId);assert.ok(adjustment);
        const refund=new RefundService(container,{send:async(row,attempt)=>{
          if(outcome==="UNKNOWN") return {kind:"UNKNOWN"};
          const refundId="rfd_"+attempt.id,id="evt_"+randomUUID(),webhookId="wh_"+randomUUID();
          const rawData=JSON.stringify({id,type:outcome==="SETTLED"?"refund.succeeded":"refund.failed",payload:{
            id:refundId,paymentId:row.provider_payment_id,type:"refund",status:outcome==="SETTLED"?"succeeded":"failed",
            amount:Number(row.amount_minor),currency:"ZAR",mode:row.mode,metadata:{checkoutId:row.checkout_id,
              gospazaRefundOperationId:row.id,gospazaRefundAttemptId:attempt.id}}});
          const timestamp=String(Math.floor(Date.now()/1000));
          const signature=createHmac("sha256",signingKey)
            .update(webhookId+"."+timestamp+"."+rawData).digest("base64");
          const inbox=new PaymentReconciliationService(container);
          await inbox.receive({rawData,data:{},headers:{"webhook-id":webhookId,"webhook-timestamp":timestamp,"webhook-signature":"v1,"+signature}});
          const stored=await db("yoco_inbox").where({event_id:id}).first();assert.ok(stored);
          await inbox.applyInbox(stored.id);
          return {kind:"ACCEPTED",refundId,status:202};
        }});
        const result=await refund.command(viewer.id,adjustment.id,{action:"EXECUTE",reason:"APPROVED_ADJUSTMENT",confirmed:true});
        assert.equal(result.status,outcome);
        refunds[outcome]={order:source.orderId,email:await customerEmail(source.person.id)};
      }
      const [nonSellable,attention,restock]=more;assert.ok(nonSellable && attention && restock);
      const lines=await new ReturnedInventory(container).handle(f.manager.identity,attention.deliveryId);
      const line="items" in lines ? lines.items?.[0]:undefined;
      assert.ok(line);
      // Fail the isolated native inventory boundary before any stock change.
      // The ordinary disposition service must persist its real attention result.
      const inventory=container.resolve<IInventoryService>(Modules.INVENTORY);
      const scopes:{createScope():MedusaContainer}=container;
      const scope=scopes.createScope();
      const unavailableInventory:IInventoryService=Object.create(inventory);
      unavailableInventory.adjustInventory=async()=>{throw new Error("Fixture inventory unavailable");};
      scope.register({[Modules.INVENTORY]:asValue(unavailableInventory)});
      const result=await new ReturnedInventory(scope).handle(f.manager.identity,attention.deliveryId,{line_id:line.line_id,confirmed:true,decision:"RESTOCK"});
      assert.ok("status" in result && result.status==="ATTENTION_REQUIRED");
      const customer=(await orders.retrieveOrder(returnedOrder)).customer_id;assert.ok(customer);
      await finance.ensure(returnedOrder);
      await finance.ensure(attention.orderId);
      const shipment=await db("pickup_operation").where({delivery_id:restock.deliveryId,action:"SHIP",state:"SUCCEEDED"}).first();
      const physical=pickupInput.parse(shipment.input);
      const component=physical.components.find(c=>c.inventory_item_id);
      assert.ok(component?.inventory_item_id);
      const level=await inventory.retrieveInventoryLevelByItemAndLocation(component.inventory_item_id,physical.location_id);
      manifest={version:1,key:f.fixture.publishableKey,mixed:{...mixed,email:await customerEmail(mixed.customerId)},
        owner:await email(f.ownerA.identity),manager:await email(f.manager.identity),managerId:f.manager.id,
        picker:await email(f.picker.identity),foreignMerchant:await email(f.ownerB.identity),
        viewer,inventoryViewer,deniedAdmin,refunds,queueOrder:queueOrder.orderId,queueEmail:await customerEmail(queueOrder.person.id),
        delivery,returnedOrder,stockGateId:level.id,returnEmail:await customerEmail(customer),nonSellable,attention,restock,location:f.fixture.location};
    } finally {grants.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});}
  }));
  assert.ok(manifest);
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(manifest),{flag:"wx"});
  console.log("M18 isolated browser manifest: "+output);
}
