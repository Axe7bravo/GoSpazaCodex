import test from "node:test";
import assert from "node:assert/strict";
import { financialMinor, unitShare, lineAllocations, safeSum, settlementMethod, restrictedFinancialCause, adjustsDelivery, goodwillLimit, goodwillInput, approvalInput } from "../src/modules/marketplace/financial-policy";
import { hasFinancialCapability } from "../src/modules/marketplace/financial-policy";

test("financial cents reuse the strict native decimal boundary", () => {
  assert.equal(financialMinor("0.01"), 1);
  assert.equal(financialMinor("109.99"), 10999);
  for (const value of ["0.001", "-1", "NaN", "Infinity", "900719925474099.99"]) assert.throws(() => financialMinor(value));
});
test("discounted net and frozen tax allocate independently without lost cents", () => {
  const line = { id: "line_a", quantity: 3, net_minor: 1001, tax_minor: 151 };
  const all = [0,1,2].map(i => lineAllocations(line,i,i+1));
  assert.deepEqual(all.map(rows => rows.map(r => r.amount_minor)), [[334,51],[334,50],[333,50]]);
  assert.equal(safeSum(all.flat().map(r => r.amount_minor)), 1152);
  assert.equal(safeSum(lineAllocations(line,2,3).map(r => r.amount_minor)), 383);
  assert.equal(unitShare(1,3,0,1),1);
  assert.equal(unitShare(1,3,1,3),0);
  assert.throws(() => unitShare(10,3,2,4));
  assert.throws(() => safeSum([Number.MAX_SAFE_INTEGER,1]));
});
test("settlement eligibility is reason/account derived, not a customer choice", () => {
  assert.equal(settlementMethod("ITEM_OMITTED",true),"STORE_CREDIT");
  assert.equal(settlementMethod("ITEM_OMITTED",false),"ORIGINAL_PAYMENT");
  for (const reason of ["MERCHANT_REJECTED","FULL_UNFULFILLABLE","RESTRICTED_HANDOFF_FAILED"] as const) assert.equal(settlementMethod(reason,true),"ORIGINAL_PAYMENT");
  assert.equal(settlementMethod("GOODWILL",true),"STORE_CREDIT");
  assert.throws(() => settlementMethod("GOODWILL",false));
  assert.equal(goodwillInput.safeParse({ request_id:"request_1", amount_minor:100, reason:"CUSTOMER_CARE", confirmed:true, method:"ORIGINAL_PAYMENT" }).success,false);
  assert.equal(approvalInput.safeParse({ expected_revision:1, confirmed:true, amount_minor:1 }).success,false);
});
test("bounded financial cause excludes sensitive detail and uncertain recovery", () => {
  assert.equal(restrictedFinancialCause("SCHOOL_UNIFORM"),"CUSTOMER_RECIPIENT");
  assert.equal(restrictedFinancialCause("COMPLIANCE_RECOVERY_REQUIRED"),null);
  assert.equal(restrictedFinancialCause("DELIVERY_ADDRESS_MISMATCH"),null);
  assert.equal(restrictedFinancialCause("made up fault"),null);
  assert.equal(adjustsDelivery("CUSTOMER_RECIPIENT","RESTRICTED_HANDOFF_FAILED"),false);
  assert.equal(adjustsDelivery("MERCHANT","RESTRICTED_HANDOFF_FAILED"),true);
  assert.equal(adjustsDelivery("PLATFORM","FULL_UNFULFILLABLE"),true);
  assert.equal(adjustsDelivery("MERCHANT","ITEM_OMITTED"),false);
});
test("goodwill fails closed without bounded platform configuration", () => {
  assert.equal(goodwillLimit(1001,"1000"),100);
  for (const value of ["", "-1", "10001", "1.5", "anything"]) assert.throws(() => goodwillLimit(1001,value));
});
test("financial capabilities are explicit and independent", () => {
  const env={FINANCIAL_VIEW_USER_IDS:"usr_view",FINANCIAL_APPROVE_USER_IDS:"usr_approve",FINANCIAL_GOODWILL_CREATE_USER_IDS:"usr_goodwill"};
  assert.equal(hasFinancialCapability("usr_view","VIEW",env),true);
  assert.equal(hasFinancialCapability("usr_view","APPROVE",env),false);
  assert.equal(hasFinancialCapability("usr_approve","GOODWILL_CREATE",env),false);
  for(const actor of ["picker","driver","merchant","customer","native_user",""]) assert.equal(hasFinancialCapability(actor,"GOODWILL_CREATE",env),false);
});
