import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { merchantPayoutHandler } from "../src/lib/merchant-payout-http";
import { payoutNext, exactPayout, payoutTimeValid, transferIdentity, recordPayout, recordPayoutFailure,
  reconcilePayout, retryPayout,settlementActionAllowed, type PayoutAction, type PayoutState } from "../src/modules/marketplace/merchant-payout-policy";
import { settlementAllowed } from "../src/modules/marketplace/merchant-settlement-policy";

const base={request_id:"request_a",expected_revision:1,confirmed:true,reason:"Reviewed external evidence"};
const transfer={channel:"BANK_TRANSFER",origin_reference:"origin_main",external_transfer_id:"BANK-123"};
const evidence={...base,...transfer,amount_minor:9000,currency:"zar",beneficiary_reference:"beneficiary_verified",
  transferred_at:"2026-11-04T10:00:00Z"};
test("M20-C exposes only the five authorized lifecycle edges",()=>{
  const edges:Partial<Record<PayoutAction,readonly [PayoutState,PayoutState]>>={APPROVE:["READY_FOR_APPROVAL","APPROVED"],
    PAY:["APPROVED","PAID"],FAIL:["APPROVED","FAILED"],RETRY:["FAILED","APPROVED"],RECONCILE:["PAID","RECONCILED"]};
  for(const action of ["APPROVE","PAY","FAIL","RETRY","RECONCILE"] as const) for(const state of ["DRAFT","READY_FOR_APPROVAL","APPROVED","FAILED","PAID","RECONCILED"] as const) {
    const edge=edges[action];assert.ok(edge);
    if(state===edge[0]) assert.equal(payoutNext(state,action),edge[1]);else assert.throws(()=>payoutNext(state,action));
  }
  assert.equal(payoutNext("RECONCILED","DISCREPANCY"),"RECONCILED");assert.throws(()=>payoutNext("DRAFT","DISCREPANCY"));
});
test("M20-C exact amount/currency and database-clock transfer time policy",()=>{
  assert.doesNotThrow(()=>exactPayout(9000,"9000","zar","zar"));
  for(const amount of [8999,9001,0,-1,1.5]) assert.throws(()=>exactPayout(amount,"9000","zar","zar"));
  assert.throws(()=>exactPayout(9000,"9000","usd","zar"));
  const approved="2026-11-04T09:00:00Z",now="2026-11-04T11:00:00Z";
  assert.equal(payoutTimeValid(evidence.transferred_at,approved,now),true);
  for(const invalid of ["invalid","2026-11-04T08:59:59Z","2026-11-04T11:00:01Z"]) assert.equal(payoutTimeValid(invalid,approved,now),false);
});
test("M20-C evidence is strict; unknown outcomes are not failed transfers",()=>{
  assert.equal(recordPayout.safeParse(evidence).success,true);
  assert.equal(recordPayout.safeParse({...evidence,status:"PAID"}).success,false);
  assert.equal(recordPayout.safeParse({...evidence,amount_minor:90.5}).success,false);
  assert.equal(transferIdentity.parse({...transfer,external_transfer_id:" BANK-123 "}).external_transfer_id,"BANK-123");
  assert.notEqual(transferIdentity.parse(transfer).external_transfer_id,transferIdentity.parse({...transfer,external_transfer_id:"bank-123"}).external_transfer_id);
  assert.equal(transferIdentity.safeParse({...transfer,channel:"AUTO_PAYOUT"}).success,false);
  assert.equal(recordPayoutFailure.safeParse({...base,...transfer,beneficiary_reference:"beneficiary_verified",attempted_at:evidence.transferred_at,
    failure_category:"BANK_REJECTED",nonreceipt_confirmed:true,evidence_reference:"bank_case_123"}).success,true);
  for(const failure_category of ["HTTP_TIMEOUT","UNKNOWN","OPERATOR_CANCELLED"])
    assert.equal(recordPayoutFailure.safeParse({...base,...transfer,beneficiary_reference:"beneficiary_verified",attempted_at:evidence.transferred_at,
      failure_category,nonreceipt_confirmed:true,evidence_reference:"case_123"}).success,false);
  assert.equal(retryPayout.safeParse({...base,failed_attempt_id:"failed_123",review_reference:"review_123"}).success,true);
  assert.equal(retryPayout.safeParse(base).success,false);
  assert.equal(reconcilePayout.safeParse({...evidence,receipt_id:"receipt_123",review_reference:"review_123"}).success,true);
  assert.equal(reconcilePayout.safeParse({...base,receipt_id:"receipt_123"}).success,false);
});
test("M20-C action grants do not imply each other",()=>{
  const env={SETTLEMENT_VIEW_USER_IDS:"viewer",SETTLEMENT_PREPARE_USER_IDS:"preparer",SETTLEMENT_APPROVE_USER_IDS:"approver",
    SETTLEMENT_PAYOUT_RECORD_USER_IDS:"recorder",SETTLEMENT_RECONCILE_USER_IDS:"reconciler"};
  for(const [actor,grant] of [["viewer","VIEW"],["preparer","PREPARE"],["approver","APPROVE"],["recorder","PAYOUT_RECORD"],["reconciler","RECONCILE"]] as const)
    for(const candidate of ["VIEW","PREPARE","APPROVE","PAYOUT_RECORD","RECONCILE"] as const)
      assert.equal(settlementAllowed(actor,candidate,env),grant===candidate);
  for(const [actor,allowed] of [["viewer",[]],["preparer",[]],["approver",["APPROVE","RETRY"]],["recorder",["PAY","FAIL","DISCREPANCY"]],["reconciler",["RECONCILE","DISCREPANCY"]]] as const)
    for(const action of ["APPROVE","PAY","FAIL","RETRY","RECONCILE","DISCREPANCY"] as const)
      assert.equal(settlementActionAllowed(actor,action,env),(allowed as readonly string[]).includes(action));
  assert.equal(settlementActionAllowed("viewer","EVIDENCE",env),false);
  assert.equal(settlementActionAllowed("approver","VIEW",env),false);
});
test("M20-C operational routes deny all non-platform actors before service resolution",async()=>{
  for(const actor_type of ["merchant","customer","driver",undefined]) for(const action of ["APPROVE","PAY","FAIL","RETRY","RECONCILE","DISCREPANCY","evidence"] as const) {
    let status=0;const response={setHeader:()=>undefined,status:(s:number)=>{status=s;return response;},json:()=>undefined};
    await merchantPayoutHandler(action)({auth_context:{actor_type,actor_id:"known_actor"}} as unknown as MedusaRequest,response as unknown as MedusaResponse);
    assert.equal(status,401);
  }
});
