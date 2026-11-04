import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MerchantOrderEconomics } from "@gospaza/contracts";
import { OrderEconomicsView,commissionRate } from "../src/order-economics";

const base:MerchantOrderEconomics={order_id:"own-order",currency:"zar",state:"PENDING",basis_points:null,earned:null,zero_reason:null};
const render=(patch:Partial<MerchantOrderEconomics>)=>renderToStaticMarkup(createElement(OrderEconomicsView,{row:{...base,...patch}}));
test("missing terms, explicit zero, frozen terms and a proven zero sale remain distinct",()=>{
  assert.equal(commissionRate(null),"No applicable rate");assert.equal(commissionRate(0),"0.00%");
  assert.equal(commissionRate(800),"8.00%");assert.equal(commissionRate(1000),"10.00%");
  assert.match(render({state:"RESOLVED",basis_points:0}),/No earned sale has been recorded/);
  assert.match(render({state:"KNOWN_ZERO",zero_reason:"FULL_UNFULFILLABLE"}),/All units were omitted/);
  const unresolved=render({state:"UNRESOLVED"});
  assert.match(unresolved,/require review/);assert.doesNotMatch(unresolved,/0[,.]00|No merchandise earnings/);
});
test("recognized merchandise entitlement is separate from commission and tax",()=>{
  const text=render({state:"EARNED",basis_points:800,earned:{merchandise_minor:10000,basis_minor:10000,tax_minor:1500,
    commission_minor:800,subsidy_minor:0,entitlement_minor:9200,economic_at:"2026-11-04T12:00:00Z"}});
  assert.match(text,/Platform commission<\/dt><dd>[^<]*8[,.]00/);
  assert.match(text,/Merchant merchandise entitlement<\/dt><dd>[^<]*92[,.]00/);
  assert.doesNotMatch(text,/payout|payable now|settlement|Yoco|Store Credit/i);
});
