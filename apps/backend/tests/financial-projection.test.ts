import assert from "node:assert/strict";
import test from "node:test";
import { orderAdjustment } from "../src/lib/financial-projection";
import type { FinancialAdjustmentView } from "@gospaza/contracts";

test("customer financial projection omits platform and merchant evidence",()=>{
  const admin:FinancialAdjustmentView={id:"fadj_private",order_id:"order_private",reason:"MERCHANT_REJECTED",
    financial_cause:"MERCHANT",currency:"zar",amount_minor:6342,components:[],status:"APPROVED",revision:2,
    eligible_methods:["ORIGINAL_PAYMENT"],default_method:"ORIGINAL_PAYMENT",settled_minor:0,reserved_minor:6342,
    unsettled_minor:6342,execution_available:false,refund_status:"PENDING",refund_operation_state:"UNKNOWN"};
  assert.deepEqual(JSON.parse(JSON.stringify(orderAdjustment(admin))),{
    reason:"MERCHANT_REJECTED",currency:"zar",amount_minor:6342,status:"APPROVED",
    default_method:"ORIGINAL_PAYMENT",settled_minor:0,refund_status:"PENDING"});
});
