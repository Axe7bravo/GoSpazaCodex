import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { merchantSettlementSql } from "../modules/marketplace/merchant-settlement-schema";
import { merchantPayoutSql } from "../modules/marketplace/merchant-payout-schema";
import { MerchantSettlements } from "../lib/merchant-settlement-service";

const checked=(error:unknown,pattern:RegExp)=>error instanceof Error && pattern.test(error.message);
const domain=(type:string)=>(error:unknown)=>!!error && typeof error==="object" && "type" in error && error.type===type;
const decision=()=>({request_id:"m20req_"+randomUUID(),expected_revision:1,confirmed:true,reason:"M20 isolated verification"});

// Real PostgreSQL contract fixtures in a private, disposable schema. The M19
// input projection is seeded here, not by disabling or editing public M19
// triggers. Signed inputs below are explicitly model-readiness fixtures.
// Existing M19 lifecycle/native provenance remains covered by its verified suite.
export interface SettlementVerificationFixture {
  db:Knex;actor_id:string;makeReady:(name:string,amount?:number)=>Promise<string>;
}
export default async function verifyMerchantSettlements({container}:ExecArgs,after?: (fixture:SettlementVerificationFixture)=>Promise<void>) {
  const url=new URL(process.env.DATABASE_URL??"");
  if(process.env.APP_ENV!=="test" || !url.pathname.endsWith("_test")) throw new Error("Use test:isolated with an existing _test database.");
  const base=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("merchant_period_statement"),"Apply the M20 migration first.");
  const schema="m20_verify_"+randomUUID().replaceAll("-","");
  const db=knex({client:"pg",connection:process.env.DATABASE_URL,searchPath:[schema],pool:{min:0,max:8}});
  const users=container.resolve<IUserModuleService>(Modules.USER);
  const actor=await users.createUsers({email:`${schema}@example.test`});
  const grants=["SETTLEMENT_VIEW_USER_IDS","SETTLEMENT_PREPARE_USER_IDS","FINANCIAL_VIEW_USER_IDS","COMMISSION_CONFIGURE_USER_IDS"];
  const original=grants.map(k=>process.env[k]);
  let created=false;
  try {
    await base.raw("create schema ??",[schema]);created=true;
    await db.raw("create table merchant(id text primary key,deleted_at timestamptz)");
    await db.raw("create table merchant_store(id text primary key,merchant_id text not null references merchant(id),deleted_at timestamptz)");
    await db.raw(`create table order_finance_snapshot(id text primary key,order_id text not null,merchant_id text not null,
      store_id text not null,currency text not null,state text not null,recorded_at timestamptz not null)`);
    await db.raw("create table order_finance_exception(id text primary key,snapshot_id text not null,reason text not null)");
    await db.raw(`create table marketplace_finance_posting(id text primary key,snapshot_id text not null references order_finance_snapshot(id),
      economic_at timestamptz not null,recorded_at timestamptz not null,merchandise_minor bigint not null,tax_minor bigint not null,
      subsidy_minor bigint not null,commission_minor bigint not null,entitlement_minor bigint not null)`);
    for(const sql of merchantSettlementSql) await db.raw(sql);
    for(const sql of merchantPayoutSql) await db.raw(sql);
    process.env.SETTLEMENT_PREPARE_USER_IDS=actor.id;
    const activationRollback=new Error("M20 prospective activation fixture rollback");
    await assert.rejects(db.transaction(async trx=>{
      const activationService=new MerchantSettlements(container,trx);
      const activation={id:"prospective_policy",activation_at:"2099-01-01T00:00:00Z",confirmed:true,reason:"Explicit activation verification"};
      await assert.rejects(activationService.activate(actor.id,{...activation,activation_at:"2000-01-01T00:00:00Z"}));
      assert.equal((await activationService.activate(actor.id,activation)).id,activation.id);
      assert.equal((await activationService.activate(actor.id,activation)).id,activation.id);
      await assert.rejects(activationService.activate(actor.id,{...activation,reason:"Changed replay"}));
      throw activationRollback;
    }),error=>error===activationRollback);
    // Explicit fixture activation is historical, unlike the prospective production
    // activation command. No production clock or activation safety is bypassed.
    await db("settlement_period_policy").insert({id:"policy_fixture",version:"M20_B_V1",timezone:"Africa/Johannesburg",currency:"zar",
      activation_at:"2020-01-08T10:00:00Z",actor_id:actor.id,reason:"Historical test clock vectors",tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"});
    const calendar=await db.raw("select * from gospaza_settlement_period(?::timestamptz,?::timestamptz)",["2020-01-08T10:00:00Z","2020-01-12T22:00:00Z"]);
    assert.equal(calendar.rows[0].first_start.toISOString(),"2020-01-12T22:00:00.000Z");
    assert.equal(calendar.rows[0].end_at.toISOString(),"2020-01-19T22:00:00.000Z");
    for(const [activation,expected] of [["2020-01-12T22:00:00Z","2020-01-12T22:00:00.000Z"],["2020-01-12T22:00:00.001Z","2020-01-19T22:00:00.000Z"]]) {
      if(!activation) throw new Error("M20 period fixture requires an explicit activation instant.");
      const r=await db.raw("select * from gospaza_settlement_period(?::timestamptz,?::timestamptz)",[activation,activation]);
      assert.equal(r.rows[0].first_start.toISOString(),expected);
    }
    const makeMerchant=async(name:string)=>{
      await db("merchant").insert({id:name});await db("merchant_store").insert({id:name+"_store",merchant_id:name});
      return {merchant_id:name,store_id:name+"_store",policy_id:"policy_fixture",period_start:"2020-01-12T22:00:00Z"};
    };
    const source=async(merchant:string,name:string,amount:number,options:{at?:string;recorded?:string;blocked?:boolean;tax?:number;db?:Knex}={})=>{
      const target=options.db??db;
      await target("order_finance_snapshot").insert({id:name+"_snapshot",order_id:name+"_order",merchant_id:merchant,
        store_id:merchant+"_store",currency:"zar",state:"RESOLVED",recorded_at:"2020-01-09T00:00:00Z"});
      await target("marketplace_finance_posting").insert({id:name,snapshot_id:name+"_snapshot",economic_at:options.at??"2020-01-15T00:00:00Z",
        recorded_at:options.recorded??"2020-01-16T00:00:00Z",merchandise_minor:amount,tax_minor:options.tax??0,
        subsidy_minor:0,commission_minor:0,entitlement_minor:amount});
      if(options.blocked) await target("order_finance_exception").insert({id:name+"_exception",snapshot_id:name+"_snapshot",reason:"POSTING_SOURCE_CONFLICT"});
    };
    for(const k of grants) delete process.env[k];
    const service=new MerchantSettlements(container,db),input=await makeMerchant("clean");
    await source("clean","included",9000,{tax:1500});
    await source("clean","blocked",4500,{blocked:true});
    await source("clean","historical",700,{at:"2020-01-07T00:00:00Z"});
    await source("clean","late",600,{recorded:"2020-01-19T22:00:00.000001Z"});
    await source("clean","boundary",500,{at:"2020-01-19T22:00:00Z"});
    await source("clean","inclusive",100,{recorded:"2020-01-19T22:00:00Z"});
    process.env.FINANCIAL_VIEW_USER_IDS=actor.id;process.env.COMMISSION_CONFIGURE_USER_IDS=actor.id;
    await assert.rejects(service.generate(actor.id,input),domain("forbidden"));
    process.env.SETTLEMENT_VIEW_USER_IDS=actor.id;
    await assert.rejects(service.generate(actor.id,input),domain("forbidden"));
    process.env.SETTLEMENT_PREPARE_USER_IDS=actor.id;
    await assert.rejects(service.generate(actor.id,{...input,store_id:"foreign_store"}),domain("not_found"));
    const foreign=await makeMerchant("foreign");
    await assert.rejects(service.generate(actor.id,{...input,store_id:foreign.store_id}),domain("not_found"));
    for(const extra of [{payable_minor:1},{source_ids:["blocked"]},{status:"READY_FOR_APPROVAL"},{cutoff:"2020-01-01"}])
      await assert.rejects(service.generate(actor.id,{...input,...extra}),domain("invalid_data"));
    const pair=await Promise.all([service.generate(actor.id,input),service.generate(actor.id,input)]);
    assert.equal(pair[0]!.statement_id,pair[1]!.statement_id);
    const first=pair[0]!.statement_id;
    assert.equal((await service.repair(actor.id,input)).statement_id,first);
    const projection=await service.read(actor.id,first);
    assert.equal(projection.statement.included_count,2);assert.equal(projection.statement.excluded_count,2);
    assert.equal(projection.statement.payable_minor,"9100");assert.equal(projection.statement.tax_held_minor,"1500");
    assert.ok(projection.exclusions.some(h=>h.reason==="HISTORICAL_CATCH_UP"));
    assert.equal(await db("settlement_source_claim").whereIn("posting_id",["blocked","historical","late","boundary"]).first(),undefined);
    await assert.rejects(db("merchant_period_statement").where({id:first}).update({net_minor:1}),/Immutable M20 statement economics/);
    await assert.rejects(db("settlement_item").where({statement_id:first}).delete(),/Immutable M20/);
    await assert.rejects(db("settlement_source_claim").where({posting_id:"included"}).update({statement_id:null}),/claim transfer denied/);
    const replace=decision();
    const replaced=await service.supersede(actor.id,first,replace);
    assert.equal((await service.supersede(actor.id,first,replace)).statement_id,replaced.statement_id);
    await assert.rejects(service.supersede(actor.id,first,{...replace,reason:"changed"}));
    assert.equal((await db("merchant_period_statement").where({id:first}).first()).superseded_by,replaced.statement_id);
    assert.equal((await db("settlement_source_claim").where({posting_id:"included"}).first()).statement_id,replaced.statement_id);
    assert.equal((await service.generate(actor.id,input)).statement_id,replaced.statement_id);
    await assert.rejects(service.prepare(actor.id,first,decision()));
    const ready=decision();
    await assert.rejects(service.prepare(actor.id,replaced.statement_id!,{...decision(),expected_revision:99}));
    delete process.env.SETTLEMENT_PREPARE_USER_IDS;
    await assert.rejects(service.prepare(actor.id,replaced.statement_id!,decision()),domain("forbidden"));
    process.env.SETTLEMENT_PREPARE_USER_IDS=actor.id;
    await service.prepare(actor.id,replaced.statement_id!,ready);
    assert.equal((await service.prepare(actor.id,replaced.statement_id!,ready)).statement_id,replaced.statement_id);
    await assert.rejects(service.prepare(actor.id,replaced.statement_id!,{...ready,reason:"changed"}));
    await assert.rejects(service.supersede(actor.id,replaced.statement_id!,decision()));
    assert.equal((await db("payable_settlement").where({statement_id:replaced.statement_id}).first()).status,"READY_FOR_APPROVAL");
    const next=await service.generate(actor.id,{...input,period_start:"2020-01-19T22:00:00Z"});
    const nextItems=(await service.read(actor.id,next.statement_id)).items;
    assert.ok(nextItems.some(i=>i.posting_id==="late" && i.prior_period));assert.ok(nextItems.some(i=>i.posting_id==="boundary" && !i.prior_period));
    // Readiness rechecks newly raised M19 evidence without clearing it.
    await db("order_finance_exception").insert({id:"new_block",snapshot_id:"late_snapshot",reason:"POSTING_SOURCE_CONFLICT"});
    await assert.rejects(service.prepare(actor.id,next.statement_id,decision()));
    const cleanAgain=await service.supersede(actor.id,next.statement_id,decision());
    assert.equal((await db("settlement_source_claim").where({posting_id:"late"}).first()).statement_id,null);
    assert.ok((await service.read(actor.id,cleanAgain.statement_id!)).exclusions.some(h=>h.posting_id==="late"));
    assert.equal((await db("order_finance_exception").where({id:"new_block"})).length,1);
    // DRAFT supersession competes with unrelated generation under the same lock.
    const concurrentInput=await makeMerchant("supersession_race");await source("supersession_race","race_source",80);
    const initial=await service.generate(actor.id,concurrentInput);
    const race=await Promise.all([service.supersede(actor.id,initial.statement_id,decision()),service.generate(actor.id,concurrentInput)]);
    const head=await service.generate(actor.id,concurrentInput);
    assert.ok(race.some(r=>r.statement_id===head.statement_id));
    assert.equal((await db("settlement_source_claim").where({posting_id:"race_source"}).first()).statement_id,head.statement_id);
    // Audit failure rolls back the entire generation, including claims/payable.
    const rollbackInput=await makeMerchant("rollback");await source("rollback","rollback_source",123);
    await db.raw("create function reject_fixture_audit() returns trigger as $test$ begin raise exception 'Injected audit failure'; end; $test$ language plpgsql");
    await db.raw("create trigger reject_fixture_audit before insert on settlement_transition_audit for each row execute function reject_fixture_audit()");
    await assert.rejects(service.generate(actor.id,rollbackInput),/Injected audit failure/);
    assert.equal(await db("settlement_source_claim").where({posting_id:"rollback_source"}).first(),undefined);
    assert.equal(await db("merchant_period_statement").where({merchant_id:"rollback"}).first(),undefined);
    await db.raw("drop trigger reject_fixture_audit on settlement_transition_audit");
    await service.generate(actor.id,rollbackInput);
    // Actually reach COMMIT with a missing deferred audit/manifest: function
    // creation alone cannot prove constraint-trigger correctness.
    const deferredInput=await makeMerchant("deferred");
    await assert.rejects(db.transaction(async trx=>{
      const template=await trx("merchant_period_statement").where({merchant_id:"rollback"}).first();
      await trx("merchant_period_statement").insert({...template,id:"deferred_invalid",merchant_id:deferredInput.merchant_id,
        store_id:deferredInput.store_id,manifest_fingerprint:"PENDING"});
    }),/Settlement manifest\/totals mismatch/);
    assert.equal(await db("merchant_period_statement").where({id:"deferred_invalid"}).first(),undefined);
    // A later commit cannot add an item to a sealed manifest.
    await assert.rejects(db.raw(`insert into settlement_item select ?,p.id,p.snapshot_id,s.order_id,p.economic_at,p.recorded_at,
      false,p.merchandise_minor,p.tax_minor,p.subsidy_minor,p.commission_minor,p.entitlement_minor
      from marketplace_finance_posting p join order_finance_snapshot s on s.id=p.snapshot_id where p.id='blocked'`,[replaced.statement_id]),/Sealed settlement membership/);
    // Late source commits while a generator waits on the producer's merchant
    // transaction. Its recorded timestamp still excludes it from the cutoff.
    const lateInput=await makeMerchant("late_race");
    const producer=await db.transaction();
    let lateGeneration:Promise<{statement_id:string}>|undefined;
    let observeLock:((query:{sql:string;bindings?:readonly unknown[]})=>void)|undefined;
    try {
      await producer("merchant").where({id:"late_race"}).forUpdate().first();
      const attemptedLock=new Promise<void>(resolve=>{
        observeLock=query=>{if(query.sql.includes('"merchant"') && query.sql.includes("for update")
          && query.bindings?.includes("late_race")) resolve();};
        db.on("query",observeLock);
      });
      lateGeneration=service.generate(actor.id,lateInput);
      await Promise.race([attemptedLock,lateGeneration.then(()=>{throw new Error("Generation escaped the held merchant lock.");})]);
      await source("late_race","late_concurrent",999,{recorded:"2020-01-19T22:00:00.000001Z",db:producer});
      await producer.commit();
    } catch(error) {await producer.rollback();if(lateGeneration) await lateGeneration.catch(()=>undefined);throw error;}
    finally {if(observeLock) db.removeListener("query",observeLock);}
    assert.ok(lateGeneration);
    const lateStatement=await lateGeneration;
    assert.equal((await service.read(actor.id,lateStatement.statement_id)).statement.included_count,0);
    await service.prepare(actor.id,lateStatement.statement_id,decision());
    const lateNext=await service.generate(actor.id,{...lateInput,period_start:"2020-01-19T22:00:00Z"});
    assert.equal((await service.read(actor.id,lateNext.statement_id)).statement.payable_minor,"999");
    // Signed fixtures exercise only the future-ready M20 effect/carry model.
    const signed=await makeMerchant("signed_model");await source("signed_model","negative_model_only",-3000);
    const a=await service.generate(actor.id,signed);await service.prepare(actor.id,a.statement_id,decision());
    assert.equal(await db("payable_settlement").where({statement_id:a.statement_id}).first(),undefined);
    await source("signed_model","positive_model_two",2000,{at:"2020-01-21T00:00:00Z",recorded:"2020-01-22T00:00:00Z"});
    const carryGenerators=await Promise.all([service.generate(actor.id,{...signed,period_start:"2020-01-19T22:00:00Z"}),
      service.generate(actor.id,{...signed,period_start:"2020-01-19T22:00:00Z"})]);
    const b=carryGenerators[0]!;assert.equal(b.statement_id,carryGenerators[1]!.statement_id);
    assert.equal((await service.read(actor.id,b.statement_id)).statement.outgoing_carry_minor,"-1000");
    await assert.rejects(db("settlement_carry_claim").insert({source_statement_id:a.statement_id,statement_id:b.statement_id}),/duplicate key/);
    assert.equal((await db("settlement_carry_claim").where({source_statement_id:a.statement_id})).length,1);
    await service.prepare(actor.id,b.statement_id,decision());
    await source("signed_model","positive_model_three",5000,{at:"2020-01-28T00:00:00Z",recorded:"2020-01-29T00:00:00Z"});
    const c=await service.generate(actor.id,{...signed,period_start:"2020-01-26T22:00:00Z"});
    assert.equal((await service.read(actor.id,c.statement_id)).statement.payable_minor,"4000");
    const zero=await service.generate(actor.id,await makeMerchant("zero"));await service.prepare(actor.id,zero.statement_id,decision());
    assert.ok((await service.read(actor.id,zero.statement_id)).statement.finalized_at);
    assert.equal(await db("payable_settlement").where({statement_id:zero.statement_id}).first(),undefined);
    // The scope cannot silently invent policy activation, skip periods or use a future cutoff.
    await assert.rejects(service.generate(actor.id,{...input,policy_id:"absent"}));
    await assert.rejects(service.generate(actor.id,{...input,period_start:"2020-01-13T00:00:00Z"}));
    await assert.rejects(service.generate(actor.id,{...input,period_start:"2099-01-12T22:00:00Z"}));
    const revoked=new MerchantSettlements(container,db);delete process.env.SETTLEMENT_PREPARE_USER_IDS;
    await assert.rejects(revoked.prepare(actor.id,c.statement_id,decision()),domain("forbidden"));
    if(after) {
      process.env.SETTLEMENT_PREPARE_USER_IDS=actor.id;
      await after({db,actor_id:actor.id,makeReady:async(name,amount=9000)=>{
        const readyInput=await makeMerchant(name);await source(name,name+"_posting",amount);
        const generated=await service.generate(actor.id,readyInput);await service.prepare(actor.id,generated.statement_id,decision());
        const payable=await db("payable_settlement").where({statement_id:generated.statement_id}).first("id");
        assert.ok(payable);return String(payable.id);
      }});
    }
    console.log("M20-B PostgreSQL statement, preparation, claim and carry verification passed.");
  } catch(error) {
    if(checked(error,/./)) console.error("M20-B verifier failed:",error instanceof Error?error.message:"unknown");
    throw error;
  } finally {
    grants.forEach((key,i)=>{if(original[i]===undefined) delete process.env[key];else process.env[key]=original[i];});
    await db.destroy();
    // Only this generated test schema is removed. Public financial history stays intact.
    if(created) await base.raw("drop schema ?? cascade",[schema]);
    await users.deleteUsers([actor.id]);
  }
}

