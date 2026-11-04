import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CommissionService } from "../lib/commission-service";
import { MarketplaceRecognition } from "../lib/marketplace-recognition";
import { FinancialService } from "../lib/financial-service";
import { StoreCreditSettlement } from "../lib/store-credit-settlement";
import { OrderOperationsService } from "../lib/order-operations-service";
import { commissionAt } from "../modules/marketplace/commission-policy";
import { unitShare } from "../modules/marketplace/financial-policy";
import { recognitionEvidence } from "../modules/marketplace/recognition-policy";
import { withRetainedRecognitionFixture } from "./fixtures/financial-browser";
import verifyRecipient from "./verify-recipient";

export default async function verifyCommissionRecognition(args:ExecArgs) {
  const {container}=args;
  const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const rules=new CommissionService(container), ledger=new MarketplaceRecognition(container);
  const grants=["COMMISSION_CONFIGURE_USER_IDS","FINANCIAL_GOODWILL_CREATE_USER_IDS","FINANCIAL_APPROVE_USER_IDS",
    "FINANCIAL_ISSUE_STORE_CREDIT_USER_IDS","FINANCIAL_GOODWILL_MAX_BPS"];
  const prior=grants.map(k=>process.env[k]);
  let actor="",merchant="",order="";
  const publish=(bps:number,revision:number)=>rules.publish(actor,{scope:"MERCHANT",merchant_id:merchant,
    decision:"SET",basis_points:bps,expected_revision:revision,confirmed:true,reason:"Single-use recognition fixture",request_id:randomUUID()});
  try {
    await withRetainedRecognitionFixture(()=>verifyRecipient(args,async(f,_delivery,returnedOrder)=>{
      assert.deepEqual(await ledger.recognize(returnedOrder),{state:"KNOWN_ZERO",reason:"FAILED_RESTRICTED_HANDOFF"});
      const rejected=await f.complete("recognition-rejection",f.fixture.second.variantId,1);
      const orders=new OrderOperationsService(container);
      await orders.ensure(rejected.orderId);
      await orders.decide(f.ownerB.identity,rejected.orderId,"reject",{expected_revision:0,confirmed:true});
      assert.deepEqual(await ledger.recognize(rejected.orderId),{state:"KNOWN_ZERO",reason:"MERCHANT_REJECTED"});
      const empty=await db("pick_session as p").join("order_operation as o","o.id","p.order_operation_id")
        .where({"o.merchant_id":merchant,"p.status":"COMPLETED"}).whereNull("p.deleted_at")
        .whereNotExists(db("pick_line as l").select("l.id").whereRaw("l.pick_session_id=p.id").where("l.picked_quantity",">",0))
        .select("o.medusa_order_id").first();
      assert.ok(empty,"M16's complete all-omitted fixture must exist");
      assert.deepEqual(await ledger.recognize(empty.medusa_order_id),{state:"KNOWN_ZERO",reason:"FULL_UNFULFILLABLE"});
      const count=async()=>Number((await db("marketplace_finance_posting as p").join("order_finance_snapshot as s","s.id","p.snapshot_id")
        .where("s.order_id",order).count("* as n").first())?.n);
      const marker=new Error("rollback disposable recognition");
      let mismatchedSource:Record<string,unknown>|undefined;
      await assert.rejects(db.transaction(async trx=>{
        await new CommissionService(container,trx).ensure(order);
        const provisional=await new MarketplaceRecognition(container,trx).recognize(order);
        assert.ok(provisional.state==="RECOGNIZED");
        const row=await trx("marketplace_finance_posting").where({id:provisional.id}).first();
        assert.ok(row);
        mismatchedSource={...row,units:JSON.stringify(row.units),source_fingerprint:"conflicting-fixture-fingerprint"};
        await assert.rejects(trx.transaction(async invalid=>{
          await invalid("marketplace_finance_posting").insert({...row,id:randomUUID(),event_id:randomUUID(),units:JSON.stringify(row.units)});
        }),/Unproven marketplace recognition/);
        await assert.rejects(trx.transaction(async invalid=>{
          await invalid("marketplace_finance_posting").where({id:row.id}).delete();
        }),/Immutable M19 finance history/);
        throw marker;
      }),err=>err===marker);
      assert.equal(await count(),0);
      await assert.rejects(db.transaction(async trx=>{
        await new CommissionService(container,trx).ensure(order);
        const s=await trx("order_finance_snapshot").where({order_id:order}).first();
        assert.ok(mismatchedSource);
        // Negative control inside a rolled-back transaction: the same source
        // already has a conflicting payload. Do not update immutable history.
        await trx("marketplace_finance_posting").insert({...mismatchedSource,snapshot_id:s.id});
        const conflict=await new MarketplaceRecognition(container,trx).recognize(order);
        assert.deepEqual(conflict,{state:"UNRESOLVED",reason:"POSTING_SOURCE_CONFLICT"});
        assert.ok(await trx("order_finance_exception").where({snapshot_id:s.id,reason:"POSTING_SOURCE_CONFLICT"}).first());
        throw marker;
      }),err=>err===marker);
      assert.equal(await count(),0);
      const snapshot=await rules.ensure(order);
      assert.equal(snapshot.state,"RESOLVED");assert.equal(snapshot.basis_points,800);
      const evidence=recognitionEvidence.parse(snapshot.evidence),line=evidence.lines[0];
      assert.ok(line && evidence.lines.length===1 && line.quantity===5);
      const snap=await db("order_finance_snapshot").where({order_id:order}).first();
      const prev=await db("order_finance_snapshot").where("id","<",snap.id).orderBy("id","desc").first("id");
      const [a,b,repairA,repairB]=await Promise.all([ledger.recognize(order),ledger.recognize(order),
        ledger.repair(prev?.id,snap.id),ledger.repair(prev?.id,snap.id)]);
      assert.ok(a.state==="RECOGNIZED");assert.deepEqual(a,b);
      assert.equal(repairA.examined,1);assert.equal(repairB.examined,1);
      assert.ok(!repairA.deferred.includes(snap.id) && !repairB.deferred.includes(snap.id));
      const posting=await db("marketplace_finance_posting").where({id:a.id}).first();
      const earned=unitShare(line.net_minor,5,0,3),tax=unitShare(line.tax_minor,5,0,3);
      assert.equal(Number(posting.merchandise_minor),earned);
      assert.equal(Number(posting.tax_minor),tax);
      assert.equal(Number(posting.subsidy_minor),0);
      assert.equal(Number(posting.commission_minor),commissionAt(earned,800));
      assert.equal(Number(posting.entitlement_minor),earned-commissionAt(earned,800));
      assert.deepEqual(posting.units,[{line:line.id,start:0,end:3}]);
      const delivery=await db("delivery_operation").where({medusa_order_id:order}).first();
      assert.equal(new Date(posting.economic_at).getTime(),new Date(delivery.delivered_at).getTime());
      const finance=new FinancialService(container),credit=new StoreCreditSettlement(container);
      const [omission]=await finance.ensure(order);assert.ok(omission && omission.reason==="ITEM_OMITTED");
      const goodwill=await finance.goodwill(actor,order,{request_id:randomUUID(),amount_minor:1,reason:"CUSTOMER_CARE",confirmed:true});
      await Promise.all([finance.approve(actor,goodwill.id,{expected_revision:goodwill.revision,confirmed:true}),ledger.recognize(order)]);
      assert.deepEqual(await ledger.recognize(order),a);
      assert.equal((await credit.issue(actor,omission.id,{confirmed:true})).status,"SETTLED");
      assert.deepEqual(await ledger.recognize(order),a);assert.equal(await count(),1);
      assert.deepEqual(await db("marketplace_finance_posting").where({id:a.id}).first(),posting);
      console.log("M19-C delivered sale, frozen rate, known-zero, rollback, concurrent repair and M18 settlement separation passed.");
    },{
      async beforeOrder(user,id) {
        actor=user;merchant=id;
        for(const key of grants.slice(0,-1)) process.env[key]=user;
        process.env.FINANCIAL_GOODWILL_MAX_BPS="10000";
        await publish(800,0);
      },
      async beforeDelivery(id) {
        order=id;await publish(1200,1);
        assert.equal((await ledger.recognize(order)).state,"PENDING");
      },
    }));
  } finally {
    grants.forEach((key,i)=>{if(prior[i]===undefined) delete process.env[key];else process.env[key]=prior[i];});
  }
}
