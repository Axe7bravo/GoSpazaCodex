import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FinancialAdjustmentView } from "@gospaza/contracts";
import { AdminSettlementStatus, FinanceFeedback, OrderAdjustments } from "../src/financial";

const row:FinancialAdjustmentView={id:"private-adjustment",order_id:"private-order",currency:"zar",amount_minor:6342,
  financial_cause:"MERCHANT",reason:"ITEM_OMITTED",status:"APPROVED",revision:1,components:[],
  eligible_methods:["STORE_CREDIT"],default_method:"STORE_CREDIT",settled_minor:0,reserved_minor:0,unsettled_minor:6342,execution_available:false};

test("order outcomes distinguish approved, processing and settled credit from original-payment refunds",()=>{
  const render=(patch:Partial<FinancialAdjustmentView>)=>renderToStaticMarkup(createElement(OrderAdjustments,{rows:[{...row,...patch}]}));
  const approved=render({});
  assert.match(approved,/Approved amount.*63[,.]42/);
  assert.match(approved,/awaiting settlement/);
  assert.doesNotMatch(approved,/private-adjustment|private-order|MERCHANT|Credit added/);
  assert.match(render({credit_status:"PENDING"}),/Credit processing/);
  assert.match(render({credit_status:"CREDIT_ADDED",settled_minor:6342}),/Credit added to GoSpaza balance/);
  assert.match(render({default_method:"ORIGINAL_PAYMENT",refund_status:"SUCCEEDED"}),/Refunded to original payment method/);
  assert.match(render({default_method:"ORIGINAL_PAYMENT",refund_status:"FAILED"}),/Refund failed/);
});
test("empty, failed reads and exceptional operations have distinct presentations",()=>{
  assert.match(renderToStaticMarkup(createElement(OrderAdjustments,{rows:[]})),/No adjustments recorded/);
  const feedback=(error:string)=>renderToStaticMarkup(createElement(FinanceFeedback,{error,loaded:false,refresh:()=>{}}));
  assert.match(feedback(""),/Loading financial information/);
  assert.match(feedback("internal detail"),/role="alert"/);
  assert.doesNotMatch(feedback("internal detail"),/internal detail|No adjustments/);
  assert.match(renderToStaticMarkup(createElement(AdminSettlementStatus,{row:{...row,default_method:"ORIGINAL_PAYMENT",refund_operation_state:"UNKNOWN"}})),/<strong>Refund outcome unknown/);
  assert.match(renderToStaticMarkup(createElement(AdminSettlementStatus,{row:{...row,credit_status:"REVIEW_PENDING"}})),/<strong>Credit needs review/);
});
