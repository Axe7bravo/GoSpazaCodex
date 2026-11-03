import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IAuthModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import verifyOrderOperations from "./verify-order-operations";
import { FinancialService } from "../lib/financial-service";
import { PickingService } from "../lib/picking-service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { cleanupShortages } from "./shortage-verification-cleanup";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { readFinancialEconomics } from "../lib/financial-native";
import { unitShare } from "../modules/marketplace/financial-policy";

// Finance history is never deleted for test cleanup. Every finance write uses
// an enclosing rollback transaction; deferred audit checks are explicitly flushed.
export default async function verifyFinancialAdjustments(args:ExecArgs) {
  await verifyOrderOperations(args,async f=>{
    const { container }=f.fixture, db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth=await container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(f.platform.identity);
    const user=String(auth.app_metadata?.user_id ?? ""); assert.ok(user);
    const keys=["FINANCIAL_VIEW_USER_IDS","FINANCIAL_APPROVE_USER_IDS","FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_GOODWILL_MAX_BPS","FINANCIAL_VIEW_DISPOSITION_USER_IDS"];
    const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
    const rollback=new Error("M18 isolated fixture rollback");
    const pickingOrders:string[]=[];
    try {
      // API negative checks require no financial grants in the separately running backend.
      const customerPath="/store/gospaza/orders/"+f.a.orderId+"/financial-resolution";
      const merchantPath="/merchant/orders/"+f.a.orderId+"/financial-resolution";
      f.expect(await f.http(f.b.person.cookie,"GET",customerPath),404);
      f.expect(await f.http(f.ownerB.cookie,"GET",merchantPath),404);
      f.expect(await f.http(f.picker.cookie,"GET",merchantPath),403);
      f.expect(await f.http(f.ownerA.cookie,"GET",merchantPath));
      f.expect(await f.http(f.manager.cookie,"GET",merchantPath));
      f.expect(await f.http(f.a.person.cookie,"GET",customerPath));
      f.expect(await f.http(f.a.person.cookie,"GET",customerPath+"?amount_minor=100"),400);
      const denied=new FinancialService(container);
      for (const key of keys.slice(0,3)) delete process.env[key];
      await assert.rejects(denied.list(user,{}));
      await assert.rejects(denied.goodwill(user,f.a.orderId,{ request_id:randomUUID(),amount_minor:1,reason:"CUSTOMER_CARE",confirmed:true }));
      for (const key of keys.slice(0,3)) process.env[key]=user;
      process.env.FINANCIAL_GOODWILL_MAX_BPS="1000";
      delete process.env.FINANCIAL_VIEW_DISPOSITION_USER_IDS;
      const decisions=new OrderOperationsService(container), picking=new PickingService(container);
      await decisions.decide(f.ownerB.identity,f.b.orderId,"reject",{expected_revision:0,confirmed:true});
      const short=await f.complete("m18-partial",f.fixture.first.variantId,3); pickingOrders.push(short.orderId);
      await decisions.ensure(short.orderId);
      await decisions.decide(f.ownerA.identity,short.orderId,"accept",{expected_revision:0,confirmed:true});
      await picking.customerShortages(short.person.id,short.orderId,"PREFERENCE",{preference:"NO_SUBSTITUTION",expected_revision:0});
      await picking.mutate(f.picker.identity,short.orderId,"CLAIM",{});
      let state=await picking.detail(f.picker.identity,short.orderId);
      const line=state.lines[0]; assert.ok(line);
      await picking.mutate(f.picker.identity,short.orderId,"LINE",{expected_revision:state.revision,picked_quantity:2,shortage_recorded:true},line.id);
      state=await picking.detail(f.picker.identity,short.orderId);
      await picking.mutate(f.picker.identity,short.orderId,"COMPLETE",{expected_revision:state.revision,confirmed:true});
      await assert.rejects(db.transaction(async trx=>{
        const service=new FinancialService(container,trx);
        const omitted=await service.ensure(short.orderId);
        assert.equal(omitted.length,1); assert.equal(omitted[0]?.reason,"ITEM_OMITTED");
        assert.equal(omitted[0]?.status,"APPROVED"); assert.equal(omitted[0]?.default_method,"STORE_CREDIT");
        const handoff=await readOrderHandoff(trx,short.orderId); assert.ok(handoff);
        const economics=await readFinancialEconomics(container,handoff), economicLine=economics.lines[0]; assert.ok(economicLine);
        assert.equal(Number(omitted[0]?.amount_minor),unitShare(economicLine.net_minor,3,2,3)+unitShare(economicLine.tax_minor,3,2,3));
        assert.equal((await service.ensure(short.orderId))[0]?.id,omitted[0]?.id);
        const rejected=await service.ensure(f.b.orderId); assert.equal(rejected.length,1);
        assert.equal(rejected[0]?.default_method,"ORIGINAL_PAYMENT");
        assert.equal(Number(rejected[0]?.amount_minor),Number(rejected[0]?.economic_bound_minor));
        await trx.raw("set constraints financial_audit_check immediate");
        throw rollback;
      }),error=>error===rollback);
      await assert.rejects(db.transaction(async trx=>{
        const service=new FinancialService(container,trx);
        const input={ request_id:"m18_"+randomUUID(),amount_minor:1,reason:"CUSTOMER_CARE",confirmed:true };
        const created=await service.goodwill(user,f.a.orderId,input);
        assert.equal(created.status,"REVIEW_REQUIRED");
        assert.deepEqual(created.eligible_methods,["STORE_CREDIT"]);
        assert.equal(created.reserved_minor,0); assert.equal(created.settled_minor,0); assert.equal(created.execution_available,false);
        assert.equal((await service.goodwill(user,f.a.orderId,input)).id,created.id);
        await assert.rejects(service.goodwill(user,f.a.orderId,{...input,amount_minor:2}));
        const original=await trx("financial_adjustment").where({id:created.id}).first(); assert.ok(original);
        await assert.rejects(trx.transaction(async invalid=>{
          await invalid("financial_adjustment").insert({...original,id:"fadj_"+randomUUID(),
            allocations:JSON.stringify([{component:"GOODWILL",economic_key:"unique_probe_"+randomUUID(),start_unit:0,end_unit:1,amount_minor:1}]),eligible_methods:JSON.stringify(original.eligible_methods)});
        }),/duplicate key/);
        await assert.rejects(trx.transaction(async invalid=>{
          const identity="missing_audit_"+randomUUID();
          await invalid("financial_adjustment").insert({...original,id:"fadj_"+randomUUID(),source_id:identity,
            allocations:JSON.stringify([{component:"GOODWILL",economic_key:identity,start_unit:0,end_unit:1,amount_minor:1}]),eligible_methods:JSON.stringify(original.eligible_methods)});
          await invalid.raw("set constraints financial_audit_check immediate");
        }),/Financial audit required/);
        await trx.raw("set constraints financial_audit_check immediate");
        await trx.raw("set constraints financial_audit_check deferred");
        // A genuinely separate PostgreSQL transaction cannot enter the same
        // order's mutation boundary while this transaction owns it.
        await assert.rejects(db.transaction(async competitor=>{
          await competitor("order_operation").where({medusa_order_id:f.a.orderId}).forUpdate().noWait().first();
        }), (error:unknown)=>typeof error==="object" && error!==null && "code" in error && error.code==="55P03");
        const approved=await service.approve(user,created.id,{expected_revision:1,confirmed:true});
        assert.equal(approved.status,"APPROVED"); assert.equal(approved.revision,2);
        assert.deepEqual(await service.approve(user,created.id,{expected_revision:1,confirmed:true}),approved);
        await assert.rejects(trx.transaction(async invalid=>{
          await invalid("financial_adjustment").where({id:created.id}).update({amount_minor:2});
        }),/Immutable financial economics/);
        await assert.rejects(trx.transaction(async invalid=>{
          await invalid("financial_adjustment_event").where({adjustment_id:created.id}).update({actor_id:"forged"});
        }),/Financial audit append only/);
        const events=await trx("financial_adjustment_event").where({adjustment_id:created.id}).orderBy("revision");
        assert.equal(events.length,2); assert.equal(events[1]?.actor_id,user);
        await trx.raw("set constraints financial_audit_check immediate");
        const detail=await service.adminOrder(user,f.a.orderId);
        assert.ok(detail.history.some(event=>event.adjustment_id===created.id && event.action==="MANUALLY_APPROVED"));
        assert.equal(detail.dispositions,undefined,"finance view does not grant inventory visibility");
        process.env.FINANCIAL_VIEW_DISPOSITION_USER_IDS=user;
        assert.deepEqual((await service.adminOrder(user,f.a.orderId)).dispositions,[]);
        const projection=JSON.stringify(detail);
        for (const forbidden of ["payment_id","capture_id","school_uniform","date_of_birth","latitude","source_id","economics_fingerprint"]) assert.equal(projection.includes(forbidden),false);
        // Valid deferred branch was evaluated; leave no permanent finance fixture.
        throw rollback;
      }),error=>error===rollback);
      assert.equal((await db("financial_adjustment").where({medusa_order_id:f.a.orderId})).length,0);
      // Missing audit must fail the deferred branch, independently of service code.
      await assert.rejects(db.transaction(async trx=>{
        const service=new FinancialService(container,trx);
        const row=await service.goodwill(user,f.a.orderId,{request_id:"m18_"+randomUUID(),amount_minor:1,reason:"CUSTOMER_CARE",confirmed:true});
        // Deletion is deliberately rejected: a verifier must not weaken append-only audit.
        await trx("financial_adjustment_event").where({adjustment_id:row.id}).delete();
      }),/Financial audit append only/);
    } finally {
      if(pickingOrders.length) await db.transaction(async trx=>{
        await trx("merchant").where({id:f.fixture.first.merchantId}).forUpdate().first();
        await cleanupShortages(trx,pickingOrders);
        const operations=trx("order_operation").select("id").whereIn("medusa_order_id",pickingOrders);
        const sessions=trx("pick_session").select("id").whereIn("order_operation_id",operations);
        await trx("pick_event").whereIn("pick_session_id",sessions).delete();
        await trx("pick_line").whereIn("pick_session_id",sessions).delete();
        await trx("pick_session").whereIn("order_operation_id",operations).delete();
      });
      for (const key of keys) { const value=before[key]; if(value===undefined)delete process.env[key];else process.env[key]=value; }
    }
  });
  console.log("M18-B financial domain verification passed; no settlement execution.");
}
