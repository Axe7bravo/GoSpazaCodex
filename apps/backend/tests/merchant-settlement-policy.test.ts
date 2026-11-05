import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { merchantSettlementHandler } from "../src/lib/merchant-settlement-http";
import { settlementAmounts, settlementAllowed, settlementDecision, settlementGeneration } from "../src/modules/marketplace/merchant-settlement-policy";

test("M20 merchandise effects and tax/shipping explanation are separate",()=>{
  assert.deepEqual(settlementAmounts([9000,4500]),{current_effects_minor:13500,incoming_carry_minor:0,
    net_minor:13500,payable_minor:13500,outgoing_carry_minor:0});
  assert.equal(settlementAmounts([]).payable_minor,0);
  assert.equal(settlementAmounts([0]).outgoing_carry_minor,0);
  assert.throws(()=>settlementAmounts([1.5]));
  assert.throws(()=>settlementAmounts([Number.MAX_SAFE_INTEGER,1]));
  assert.throws(()=>settlementAmounts([1],1));
});
test("M20 platform routes reject customer, merchant and driver identities before service resolution",async()=>{
  for(const actor_type of ["customer","merchant","driver",undefined]) {
    let status=0;
    const response={setHeader:()=>undefined,status:(value:number)=>{status=value;return response;},json:()=>undefined};
    const request={auth_context:{actor_type,actor_id:"known_actor"}};
    await merchantSettlementHandler("generate")(request as unknown as MedusaRequest,response as unknown as MedusaResponse);
    assert.equal(status,401);
  }
});
test("M20 signed carry model readiness, not a new production negative source",()=>{
  const a=settlementAmounts([-3000]),b=settlementAmounts([2000],a.outgoing_carry_minor),c=settlementAmounts([5000],b.outgoing_carry_minor);
  assert.deepEqual([a.net_minor,b.net_minor,c.net_minor],[-3000,-1000,4000]);
  assert.deepEqual([a.payable_minor,b.payable_minor,c.payable_minor],[0,0,4000]);
  assert.deepEqual([a.outgoing_carry_minor,b.outgoing_carry_minor,c.outgoing_carry_minor],[-3000,-1000,0]);
});
test("M20 grants and financial inputs are explicit",()=>{
  const env={SETTLEMENT_VIEW_USER_IDS:"reader",SETTLEMENT_PREPARE_USER_IDS:"preparer",FINANCIAL_VIEW_USER_IDS:"finance",COMMISSION_CONFIGURE_USER_IDS:"commission"};
  assert.equal(settlementAllowed("preparer","PREPARE",env),true);
  for(const actor of ["reader","finance","commission",""]) assert.equal(settlementAllowed(actor,"PREPARE",env),false);
  const base={merchant_id:"merchant_a",store_id:"store_a",policy_id:"policy_a",period_start:"2026-11-08T22:00:00Z"};
  assert.equal(settlementGeneration.safeParse(base).success,true);
  for(const key of ["payable_minor","tax_held_minor","source_ids","status","cutoff","currency","incoming_carry_minor"])
    assert.equal(settlementGeneration.safeParse({...base,[key]:100}).success,false);
  assert.equal(settlementDecision.safeParse({request_id:"request_a",expected_revision:1,confirmed:false,reason:"test"}).success,false);
});
