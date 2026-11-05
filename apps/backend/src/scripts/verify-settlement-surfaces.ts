import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import type { ExecArgs } from "@medusajs/framework/types";
import type { MedusaRequest,MedusaResponse } from "@medusajs/framework/http";
import { knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MerchantSettlementDetail,PlatformSettlementDetail,SettlementEvidence } from "@gospaza/contracts";
import { settlementProjectionHandler } from "../lib/settlement-projection-http";
import { merchantPayoutHandler } from "../lib/merchant-payout-http";
import { settlementFixturePassword,settlementFixtureSchema,settlementManifest,type SettlementAcceptance } from "./fixtures/settlement-acceptance";

const decision=(revision:number)=>({expected_revision:revision,request_id:randomUUID(),confirmed:true,reason:"Private M20 API review note"});
function keys(value:unknown):string[] {if(!value||typeof value!=="object") return [];return Object.entries(value).flatMap(([k,v])=>[k,...keys(v)]);}
const privateKeys=["beneficiary_reference","origin_reference","external_transfer_id","evidence_reference","review_reference","request_id","request_fingerprint","manifest_fingerprint","storage_key","reason"];
const summaryKeys=["id","store_name","period_start","period_end","timezone","currency","statement_status","finalized","superseded","included_count","excluded_count","payable_id","payment_status",
  "paid_at","reconciled_at","attention_required","merchandise_minor","tax_held_minor","subsidy_minor","commission_minor","current_effects_minor","incoming_carry_minor","net_minor","payable_minor","outgoing_carry_minor"];
export default async function verifySettlementSurfaces({container}:ExecArgs) {
  const f=JSON.parse(await readFile(settlementManifest(),"utf8")) as SettlementAcceptance;settlementFixtureSchema(f.schema);
  const base=new URL(process.env.BACKEND_URL??"");assert.ok(["localhost","127.0.0.1"].includes(base.hostname));
  const cookies=new Map<keyof SettlementAcceptance["actors"],string>();
  const db=knex({client:"pg",connection:process.env.DATABASE_URL,searchPath:[f.schema,"public"],pool:{min:0,max:4}});
  type Actor=keyof SettlementAcceptance["actors"];
  async function request<T>(actor:Actor,path:string,method="GET",body?:unknown,status=200):Promise<T> {
    const response=await fetch(new URL(path,base),{method,signal:AbortSignal.timeout(30000),headers:{Cookie:cookies.get(actor)??"",...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,status,actor+": "+method+" "+path+" returned an unexpected status; sensitive body omitted.");
    if(status===200) assert.match(response.headers.get("cache-control")??"",/no-store/);
    return response.json() as Promise<T>;
  }
  async function login(actor:Actor) {
    const role=["operator","viewer","preparer","approver","recorder","reconciler"].includes(actor)?"user":actor==="customer"?"customer":actor==="driver"?"driver":"merchant";
    const response=await fetch(new URL("/auth/"+role+"/emailpass",base),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:f.actors[actor].email,password:settlementFixturePassword(f.actors[actor].email)}),signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200);const {token}=await response.json() as {token:string};
    const session=await fetch(new URL("/auth/session",base),{method:"POST",headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(30000)});
    assert.equal(session.status,200);const cookie=session.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");assert.ok(cookie);cookies.set(actor,cookie);
  }
  const statements="/admin/gospaza/merchant-settlements",payouts="/admin/gospaza/merchant-payouts";
  async function transfer() {const {rows:[clock]}=await db.raw("select clock_timestamp() as instant");return {amount_minor:9000,currency:"zar" as const,channel:"BANK_TRANSFER" as const,
    beneficiary_reference:"m20_private_beneficiary",origin_reference:"m20_private_origin",external_transfer_id:"bank_"+randomUUID(),transferred_at:new Date(clock.instant).toISOString(),evidence_reference:"m20_private_proof_reference"};}
  const reconcile=(e:NonNullable<SettlementEvidence["receipt"]>,revision=3)=>({...decision(revision),receipt_id:e.id,review_reference:"private_review_reference",amount_minor:Number(e.amount_minor),currency:e.currency,
    channel:e.channel,beneficiary_reference:e.beneficiary_reference,origin_reference:e.origin_reference,external_transfer_id:e.external_transfer_id,transferred_at:e.transferred_at});
  try {
    for(const actor of Object.keys(f.actors) as Actor[]) await login(actor);
    const api=f.statements.api,pay=payouts+"/"+api.payable;
    const initial=await request<PlatformSettlementDetail>("operator",statements+"/"+api.id);
    assert.equal(initial.statement.payment_status,"READY_FOR_APPROVAL","API fixture is consumed; generate a fresh manifest before another run.");
    const viewer=await request<PlatformSettlementDetail>("viewer",statements+"/"+api.id);assert.deepEqual(viewer.actions,[]);assert.equal(viewer.can_read_evidence,false);
    assert.deepEqual(Object.keys(viewer).sort(),["statement","items","holds","payment","tax_policy","shipping_policy","policy_version","statement_revision","payable_revision","actions","can_read_evidence","approved_amount_minor","history","failures","discrepancies"].sort());
    assert.deepEqual(Object.keys(viewer.statement).sort(),[...summaryKeys,"merchant_id","store_id"].sort());
    for(const hidden of privateKeys) assert.ok(!keys(viewer).includes(hidden));
    await request("viewer",pay+"/evidence","GET",undefined,403);
    for(const actor of ["viewer","preparer"] as const) await request(actor,pay+"/approve","POST",decision(1),403);
    await request("approver",pay+"/payout","POST",{...decision(1),...await transfer()},403);
    await request("approver",pay+"/approve","POST",{...decision(1),amount_minor:1},400);
    const approval=decision(1);await request("approver",pay+"/approve","POST",approval);
    await request("approver",pay+"/approve","POST",{...approval,reason:"Changed replay"},409);
    const observed=await transfer();
    for(const extra of [{amount_minor:1},{amount_minor:9001},{currency:"usd"},{merchant_id:"foreign"},{store_id:"foreign"},{status:"PAID"}])
      await request("recorder",pay+"/payout","POST",{...decision(2),...observed,...extra},"currency" in extra||"merchant_id" in extra||"store_id" in extra||"status" in extra?400:409);
    await request("recorder",pay+"/payout","POST",{...decision(1),...observed},409);
    await request("reconciler",pay+"/reconcile","POST",reconcile({...observed,id:"unknown_receipt",amount_minor:String(observed.amount_minor)},2),409);
    await request("recorder",pay+"/payout","POST",{...decision(2),...observed});
    await request("recorder",pay+"/payout","POST",{...decision(3),...await transfer()},409);
    const privateRead=await request<SettlementEvidence>("reconciler",pay+"/evidence");assert.ok(privateRead.receipt);
    await request("recorder",pay+"/reconcile","POST",reconcile(privateRead.receipt),403);
    const review=reconcile(privateRead.receipt);await request("reconciler",pay+"/reconcile","POST",review);await request("reconciler",pay+"/reconcile","POST",review);
    await request("reconciler",pay+"/reconcile","POST",{...review,reason:"Changed replay"},409);
    const ordinary=await request<PlatformSettlementDetail>("viewer",statements+"/"+api.id);assert.equal(ordinary.statement.payment_status,"RECONCILED");
    for(const hidden of privateKeys) assert.ok(!keys(ordinary).includes(hidden));
    const duplicate=f.statements.api_duplicate;await request("approver",payouts+"/"+duplicate.payable+"/approve","POST",decision(1));
    await request("recorder",payouts+"/"+duplicate.payable+"/payout","POST",{...decision(2),...observed},409);
    const disputed=f.statements.api_disputed;await request("approver",payouts+"/"+disputed.payable+"/approve","POST",decision(1));
    await request("recorder",payouts+"/"+disputed.payable+"/payout","POST",{...decision(2),...await transfer()});
    await request("recorder",payouts+"/"+disputed.payable+"/discrepancies","POST",{...decision(3),category:"TRANSFER_DISPUTE",evidence_reference:"private_bank_dispute"});
    const disputedEvidence=await request<SettlementEvidence>("reconciler",payouts+"/"+disputed.payable+"/evidence");assert.ok(disputedEvidence.receipt);
    await request("reconciler",payouts+"/"+disputed.payable+"/reconcile","POST",reconcile(disputedEvidence.receipt),409);
    const attention=await request<PlatformSettlementDetail>("operator",statements+"/"+disputed.id);
    assert.equal(attention.statement.payment_status,"PAID");assert.equal(attention.statement.attention_required,true);assert.ok(!attention.actions.includes("RECONCILE"));

    for(const actor of ["owner","manager"] as const) {
      const own=await request<MerchantSettlementDetail>(actor,"/merchant/settlements/"+api.id);
      assert.deepEqual(Object.keys(own).sort(),["statement","items","holds","payment","tax_policy","shipping_policy"].sort());
      assert.deepEqual(Object.keys(own.statement).sort(),[...summaryKeys].sort());
      for(const item of own.items) assert.deepEqual(Object.keys(item).sort(),["order_id","economic_at","prior_period","entitlement_minor"].sort());
      for(const hold of own.holds) assert.deepEqual(Object.keys(hold).sort(),["order_id","category","held_minor"].sort());
      assert.ok(own.payment);assert.deepEqual(Object.keys(own.payment).sort(),["amount_minor","currency","transferred_at","external_reference"].sort());
      assert.equal(own.statement.payment_status,"RECONCILED");
      for(const hidden of [...privateKeys,"actor_id","history","actions","merchant_id","store_id","policy_id","snapshot_id","posting_id","identity_id"]) assert.ok(!keys(own).includes(hidden));
      const serialized=JSON.stringify(own);for(const value of [observed.beneficiary_reference,observed.origin_reference,observed.external_transfer_id,observed.evidence_reference,approval.reason]) assert.ok(!serialized.includes(value));
      const list=await request<{items:{id:string}[]}>(actor,"/merchant/settlements");assert.ok(list.items.some(s=>s.id===api.id));assert.ok(!list.items.some(s=>s.id===f.statements.foreign.id));
      const foreign=await request(actor,"/merchant/settlements/"+f.statements.foreign.id,"GET",undefined,404);
      assert.deepEqual(foreign,await request(actor,"/merchant/settlements/unknown_statement","GET",undefined,404));
      await request(actor,"/merchant/settlements?store_id=foreign","GET",undefined,400);
      await request(actor,pay+"/approve","POST",decision(4),401);
    }
    await request("picker","/merchant/settlements","GET",undefined,403);
    await request("picker","/merchant/settlements/"+api.id,"GET",undefined,403);
    for(const actor of ["customer","driver"] as const) {
      await request(actor,statements,"GET",undefined,401);await request(actor,"/merchant/settlements","GET",undefined,401);
      await request(actor,pay+"/evidence","GET",undefined,401);
    }
    // Real HTTP native session stays unchanged while active membership changes.
    await request("owner","/merchant/team/members/"+f.manager_member,"PATCH",{status:"INACTIVE"});
    try {await request("manager","/merchant/settlements/"+api.id,"GET",undefined,401);}
    finally {await request("owner","/merchant/team/members/"+f.manager_member,"PATCH",{status:"ACTIVE"});}
    await request("manager","/merchant/settlements/"+api.id);
    // Environment grants are server-process configuration. As in M19, exercise
    // the actual route handler with this same HTTP-authenticated native identity
    // and unchanged session, removing the process grant without a restart UI.
    const identity=await request<{actor:{id:string;type:string}}>("viewer","/admin/gospaza/me");assert.equal(identity.actor.id,f.actors.viewer.id);
    const previous=process.env.SETTLEMENT_VIEW_USER_IDS,scope=container.createScope();scope.register({[ContainerRegistrationKeys.PG_CONNECTION]:asValue(db)});
    const req={scope,query:{},params:{id:api.id},auth_context:{actor_type:"user",actor_id:identity.actor.id},headers:{cookie:cookies.get("viewer")}};
    const invoke=async()=>{let status=200;const res={setHeader:()=>undefined,status:(s:number)=>{status=s;return res;},json:()=>undefined};
      await settlementProjectionHandler("platform-detail")(req as unknown as MedusaRequest,res as unknown as MedusaResponse);return status;};
    try {process.env.SETTLEMENT_VIEW_USER_IDS=identity.actor.id;assert.equal(await invoke(),200);delete process.env.SETTLEMENT_VIEW_USER_IDS;assert.equal(await invoke(),403);}
    finally {if(previous===undefined) delete process.env.SETTLEMENT_VIEW_USER_IDS;else process.env.SETTLEMENT_VIEW_USER_IDS=previous;}
    assert.equal((await request<{actor:{id:string}}>("viewer","/admin/gospaza/me")).actor.id,identity.actor.id);
    const recorder=await request<{actor:{id:string}}>("recorder","/admin/gospaza/me");assert.equal(recorder.actor.id,f.actors.recorder.id);
    const priorRecord=process.env.SETTLEMENT_PAYOUT_RECORD_USER_IDS;
    const recordReq={scope,query:{},params:{id:duplicate.payable},auth_context:{actor_type:"user",actor_id:recorder.actor.id},headers:{cookie:cookies.get("recorder")},
      body:{...decision(2),...await transfer(),amount_minor:1}};
    const recordHandler=async()=>{let status=200;const res={setHeader:()=>undefined,status:(s:number)=>{status=s;return res;},json:()=>undefined};
      await merchantPayoutHandler("PAY")(recordReq as unknown as MedusaRequest,res as unknown as MedusaResponse);return status;};
    try {process.env.SETTLEMENT_PAYOUT_RECORD_USER_IDS=recorder.actor.id;assert.equal(await recordHandler(),409);
      delete process.env.SETTLEMENT_PAYOUT_RECORD_USER_IDS;assert.equal(await recordHandler(),403);}
    finally {if(priorRecord===undefined) delete process.env.SETTLEMENT_PAYOUT_RECORD_USER_IDS;else process.env.SETTLEMENT_PAYOUT_RECORD_USER_IDS=priorRecord;}
    assert.equal((await request<{actor:{id:string}}>("recorder","/admin/gospaza/me")).actor.id,recorder.actor.id);
    const untouched=await request<PlatformSettlementDetail>("operator",statements+"/"+duplicate.id);assert.equal(untouched.statement.payment_status,"APPROVED");assert.equal(untouched.payment,null);
    await writeFile(settlementManifest(),JSON.stringify({...f,api_verified:true}));
    console.log("M20-D direct API, membership, grant-handler and privacy acceptance passed. Browser fixtures remain independent and unconsumed.");
  } finally {
    for(const cookie of cookies.values()) await fetch(new URL("/auth/session",base),{method:"DELETE",headers:{Cookie:cookie},signal:AbortSignal.timeout(30000)});
    await db.destroy();
  }
}
