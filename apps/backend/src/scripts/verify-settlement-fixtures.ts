import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access,mkdir,writeFile } from "node:fs/promises";
import { dirname,join } from "node:path";
import { knex,type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs,IAuthModuleService,IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys,Modules } from "@medusajs/framework/utils";
import type MarketplaceService from "../modules/marketplace/service";
import { MerchantSettlements } from "../lib/merchant-settlement-service";
import { MerchantPayouts } from "../lib/merchant-payout-service";
import { merchantSettlementSql } from "../modules/marketplace/merchant-settlement-schema";
import { merchantPayoutSql } from "../modules/marketplace/merchant-payout-schema";
import { settlementFixturePassword,settlementFixtureSchema,settlementManifest,type SettlementActor,type SettlementAcceptance } from "./fixtures/settlement-acceptance";

export default async function prepareSettlementFixtures({container}:ExecArgs) {
  const output=settlementManifest();
  try {await access(output);throw new Error("Manifest already exists. Choose a fresh M20_BROWSER_MANIFEST before creating fixtures.");}
  catch(error) {if(!error||typeof error!=="object"||!("code" in error)||error.code!=="ENOENT") throw error;}
  const schema=settlementFixtureSchema("m20_acceptance_"+randomUUID().replaceAll("-",""));
  const native=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION),auth=container.resolve<IAuthModuleService>(Modules.AUTH);
  assert.ok(await native.schema.hasTable("merchant_payout_receipt"),"Apply the verified M20-C migration to this isolated database first.");
  const users=container.resolve<IUserModuleService>(Modules.USER),market=container.resolve<MarketplaceService>("marketplace");
  const actors={} as SettlementAcceptance["actors"];
  async function account(name:keyof SettlementAcceptance["actors"],platform=false):Promise<SettlementActor> {
    const email="m20-"+name+"-"+randomUUID()+"@example.test";
    const registered=await auth.register("emailpass",{body:{email,password:settlementFixturePassword(email)}});assert.ok(registered.authIdentity);
    let id=registered.authIdentity.id;
    if(platform) {const user=await users.createUsers({email});id=user.id;await auth.updateAuthIdentities({id:registered.authIdentity.id,app_metadata:{user_id:id}});}
    const actor={id,identity:registered.authIdentity.id,email};actors[name]=actor;return actor;
  }
  for(const name of ["operator","viewer","preparer","approver","recorder","reconciler"] as const) await account(name,true);
  for(const name of ["owner","manager","picker","foreign","customer","driver"] as const) await account(name);
  async function provision(owner:SettlementActor) {
    const application=await market.createDraft(owner.identity);assert.ok(application);
    await market.edit(application.id,owner.identity,{legal_name:"M20 fixture "+owner.id,trading_name:"M20 test store",contact_name:"Fixture",contact_email:owner.email,
      contact_phone:"0123456789",address_line_1:"1 Test Street",address_line_2:"",city:"Fixture city",province:"Fixture province",postal_code:"1234",country_code:"ZA",intends_to_sell_alcohol:false,notes:"Synthetic M20 acceptance"});
    await market.submit(application.id,owner.identity);await market.review(application.id,actors.operator.id,"start-review");
    return market.provision(application.id,actors.operator.id,"Isolated M20 acceptance provisioning");
  }
  const tenant=await provision(actors.owner),foreign=await provision(actors.foreign);
  async function emailFor(identity:string) {const a=await auth.retrieveAuthIdentity(identity,{relations:["provider_identities"]});const email=a.provider_identities?.find(p=>p.provider==="emailpass")?.entity_id;assert.ok(email);return email;}
  async function invite(name:"manager"|"picker",role:"MANAGER"|"PICKER") {
    const invitation=await market.teamService.invite(actors.owner.identity,{email:actors[name].email,role},emailFor);
    return market.teamService.accept(actors[name].identity,actors[name].email,{token:invitation.token});
  }
  const manager=await invite("manager","MANAGER");await invite("picker","PICKER");
  await native.raw("create schema ??",[schema]);
  const db=knex({client:"pg",connection:process.env.DATABASE_URL,searchPath:[schema,"public"],pool:{min:0,max:4}});
  const grantKeys=["SETTLEMENT_VIEW_USER_IDS","SETTLEMENT_PREPARE_USER_IDS","SETTLEMENT_APPROVE_USER_IDS","SETTLEMENT_PAYOUT_RECORD_USER_IDS","SETTLEMENT_RECONCILE_USER_IDS"];
  const prior=grantKeys.map(k=>process.env[k]);grantKeys.forEach(k=>{process.env[k]=actors.operator.id;});
  try {
    await db.raw("create table m20_acceptance_marker(version integer primary key check(version=1))");await db("m20_acceptance_marker").insert({version:1});
    // Same explicit input-contract fixtures as B/C; public M19 remains untouched.
    await db.raw(`create table order_finance_snapshot(id text primary key,order_id text not null,merchant_id text not null,store_id text not null,currency text not null,state text not null,recorded_at timestamptz not null)`);
    await db.raw("create table order_finance_exception(id text primary key,snapshot_id text not null,reason text not null)");
    await db.raw(`create table marketplace_finance_posting(id text primary key,snapshot_id text not null references order_finance_snapshot(id),economic_at timestamptz not null,recorded_at timestamptz not null,
      merchandise_minor bigint not null,tax_minor bigint not null,subsidy_minor bigint not null,commission_minor bigint not null,entitlement_minor bigint not null)`);
    for(const sql of [...merchantSettlementSql,...merchantPayoutSql]) await db.raw(sql);
    await db("settlement_period_policy").insert({id:"m20_fixture_policy",version:"M20_B_V1",timezone:"Africa/Johannesburg",currency:"zar",activation_at:"2020-01-08T10:00:00Z",
      actor_id:actors.operator.id,reason:"Explicit isolated fixture activation",tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"});
    const statements={} as SettlementAcceptance["statements"];
    const preparation=new MerchantSettlements(container,db),payouts=new MerchantPayouts(container,db);
    const decision=()=>({request_id:randomUUID(),expected_revision:1,confirmed:true,reason:"Isolated fixture preparation"});
    // Each journey has a separate period and source; preceding periods are sealed.
    const names=["lifecycle","failure","merchant","api","api_duplicate","api_disputed"] as const;
    for(let i=0;i<names.length;i++) {
      const name=names[i];assert.ok(name);
      const start=new Date(Date.UTC(2020,0,12,22)+i*7*86400000),end=new Date(start.getTime()+7*86400000);
      const snapshot="m20_"+name+"_snapshot",posting="m20_"+name+"_posting";
      await db("order_finance_snapshot").insert({id:snapshot,order_id:"m20_order_"+name,merchant_id:tenant.merchant.id,store_id:tenant.store.id,currency:"zar",state:"RESOLVED",recorded_at:start});
      await db("marketplace_finance_posting").insert({id:posting,snapshot_id:snapshot,economic_at:new Date(start.getTime()+86400000),recorded_at:new Date(start.getTime()+2*86400000),
        merchandise_minor:10000,tax_minor:1500,subsidy_minor:0,commission_minor:1000,entitlement_minor:9000});
      const generated=await preparation.generate(actors.operator.id,{merchant_id:tenant.merchant.id,store_id:tenant.store.id,policy_id:"m20_fixture_policy",period_start:start.toISOString()});
      await preparation.prepare(actors.operator.id,generated.statement_id,decision());
      const payable=await db("payable_settlement").where({statement_id:generated.statement_id}).first("id");assert.ok(payable);
      statements[name]={id:generated.statement_id,payable:String(payable.id)};
      if(name==="failure") await payouts.execute(actors.operator.id,String(payable.id),"APPROVE",decision());
      if(name==="merchant") {
        await payouts.execute(actors.operator.id,String(payable.id),"APPROVE",decision());
        await payouts.read(actors.operator.id,String(payable.id));
        const {rows:[clock]}=await db.raw("select clock_timestamp() as instant");
        const transfer={amount_minor:9000,currency:"zar",beneficiary_reference:"merchant_fixture_private_beneficiary",channel:"BANK_TRANSFER",
          origin_reference:"merchant_fixture_private_origin",external_transfer_id:"merchant_fixture_bank_"+randomUUID(),transferred_at:new Date(clock.instant).toISOString()};
        const receipt=await payouts.execute(actors.operator.id,String(payable.id),"PAY",{...decision(),expected_revision:2,...transfer,evidence_reference:"merchant_fixture_private_proof"});
        await payouts.execute(actors.operator.id,String(payable.id),"RECONCILE",{...decision(),expected_revision:3,...transfer,receipt_id:receipt.receipt_id,review_reference:"merchant_fixture_private_review"});
      }
      assert.equal(new Date(end).getUTCDay(),0); // Local Monday midnight is UTC Sunday.
    }
    const foreignSnapshot="m20_foreign_snapshot";
    await db("order_finance_snapshot").insert({id:foreignSnapshot,order_id:"m20_order_foreign",merchant_id:foreign.merchant.id,store_id:foreign.store.id,currency:"zar",state:"RESOLVED",recorded_at:"2020-01-13T00:00:00Z"});
    await db("marketplace_finance_posting").insert({id:"m20_foreign_posting",snapshot_id:foreignSnapshot,economic_at:"2020-01-14T00:00:00Z",recorded_at:"2020-01-15T00:00:00Z",merchandise_minor:10000,tax_minor:1500,subsidy_minor:0,commission_minor:1000,entitlement_minor:9000});
    const g=await preparation.generate(actors.operator.id,{merchant_id:foreign.merchant.id,store_id:foreign.store.id,policy_id:"m20_fixture_policy",period_start:"2020-01-12T22:00:00Z"});
    await preparation.prepare(actors.operator.id,g.statement_id,decision());const p=await db("payable_settlement").where({statement_id:g.statement_id}).first("id");assert.ok(p);
    statements.foreign={id:g.statement_id,payable:String(p.id)};
    const manifest:SettlementAcceptance={version:1,schema,actors,manager_member:manager.member_id,statements};
    await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(manifest),{flag:"wx"});
    await writeFile(join(dirname(output),"m20-current-manifest.txt"),output);
    console.log("M20 fresh acceptance manifest:",output);
  } finally {grantKeys.forEach((k,i)=>{if(prior[i]===undefined) delete process.env[k];else process.env[k]=prior[i];});await db.destroy();}
}
