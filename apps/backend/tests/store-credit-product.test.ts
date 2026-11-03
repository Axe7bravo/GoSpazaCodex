import assert from "node:assert/strict";
import { test } from "node:test";
import { applicableBalance } from "../src/modules/store-credit/policy";
import { dispositionInput } from "../src/lib/returned-inventory";

test("credit application preserves integer cents and a chargeable external remainder",()=>{
  assert.equal(applicableBalance(10000,6342),6342);
  assert.equal(applicableBalance(50000,12000),12000);
  assert.equal(applicableBalance(10000,9800),9800);
  for(const balance of [9801,10000,12000,0,-1,1.5,Infinity]) assert.throws(()=>applicableBalance(10000,balance));
});

test("return disposition accepts only a decision on a server-identified line",()=>{
  const command={line_id:"ordli_example",decision:"RESTOCK",confirmed:true};
  assert.ok(dispositionInput.safeParse(command).success);
  for(const field of ["quantity","merchant_id","store_id","location_id","inventory_item_id"])
    assert.equal(dispositionInput.safeParse({...command,[field]:1}).success,false);
});
