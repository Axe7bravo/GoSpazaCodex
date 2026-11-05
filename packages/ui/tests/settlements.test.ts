import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MerchantSettlementDetail,SettlementSummary } from "@gospaza/contracts";
import { SettlementStatement,SettlementTable,settlementMoney,settlementStatus } from "../src/settlements";
import { FinanceFeedback } from "../src/financial";
const summary:SettlementSummary={id:"own_statement",store_name:"Own store",period_start:"2026-11-01T22:00:00Z",period_end:"2026-11-08T22:00:00Z",timezone:"Africa/Johannesburg",currency:"zar",
  statement_status:"READY_FOR_APPROVAL",finalized:false,superseded:false,included_count:1,excluded_count:0,payable_id:"own_payable",payment_status:"READY_FOR_APPROVAL",
  paid_at:null,reconciled_at:null,attention_required:false,merchandise_minor:"10000",tax_held_minor:"1500",subsidy_minor:"0",commission_minor:"1000",
  current_effects_minor:"9000",incoming_carry_minor:"0",net_minor:"9000",payable_minor:"9000",outgoing_carry_minor:"0"};
const detail:MerchantSettlementDetail={statement:summary,items:[],holds:[],payment:null,tax_policy:"TAX_HELD",shipping_policy:"EXCLUDED"};
const render=(patch:Partial<MerchantSettlementDetail>)=>renderToStaticMarkup(createElement(SettlementStatement,{detail:{...detail,...patch}}));
test("settlement amounts retain entitlement, tax-held, net and payable meanings",()=>{
  const html=render({});assert.match(html,/Recognized merchandise/);assert.match(html,/Tax held/);assert.match(html,/Merchant entitlement in this statement/);
  assert.match(html,/Signed statement net/);assert.match(html,/Positive payable/);assert.match(html,/90[,.]00/);assert.match(html,/15[,.]00/);
  assert.doesNotMatch(html,/platform revenue|GoSpaza owes|payment succeeded|Send money/);
  assert.equal(settlementMoney("1.5"),"Amount unavailable");assert.match(settlementMoney("9007199254740992"),/[,.]92$/);
  assert.match(settlementMoney("-1"),/-/);assert.match(settlementMoney("-1"),/0[,.]01$/);
});
test("zero and signed negative statements never fabricate a payment",()=>{
  for(const net of ["0","-3000"]) {
    const statement={...summary,payable_id:null,payment_status:null,finalized:true,net_minor:net,payable_minor:"0",outgoing_carry_minor:net};
    const html=render({statement});assert.match(html,/No payout created/);assert.doesNotMatch(html,/Paid R0|Negative payout|Reconciliation pending/);
    if(net!=="0") assert.match(html,/Carried forward/);
  }
});
test("recorded payout and reconciliation remain distinct while discrepancies preserve history",()=>{
  const statement={...summary,payment_status:"PAID" as const,paid_at:"2026-11-10T12:00:00Z",attention_required:true};
  const html=render({statement,payment:{amount_minor:"9000",currency:"zar",transferred_at:statement.paid_at,external_reference:"…123456"}});
  assert.match(html,/External payout recorded/);assert.match(html,/Reconciliation pending/);assert.match(html,/Payment needs operational attention/);
  assert.match(html,/Recorded payment history remains unchanged/);assert.doesNotMatch(html,/Payment failed|Reconciled automatically/);
  assert.equal(settlementStatus({...statement,payment_status:"RECONCILED",reconciled_at:statement.paid_at}),"Reconciled");
});
test("historical holds, unknown amounts, empty and read-error states are truthful",()=>{
  const html=render({holds:[{order_id:"own_order",category:"HISTORICAL_REVIEW",held_minor:null}]});
  assert.match(html,/Historical item under review/);assert.match(html,/Amount not established/);assert.doesNotMatch(html,/GoSpaza owes|private|fingerprint/);
  assert.match(renderToStaticMarkup(createElement(SettlementTable,{rows:[],href:"/merchant/settlements"})),/No period statements/);
  const error=renderToStaticMarkup(createElement(FinanceFeedback,{loaded:false,error:"raw SQL private data",refresh:()=>{}}));
  assert.match(error,/role="alert"/);assert.doesNotMatch(error,/raw SQL private data/);
});
