import test from "node:test";
import assert from "node:assert/strict";
import { customerFinance, merchantFinance, adminFinance } from "../src/financial";
test("financial clients use actor routes, session credentials and bounded mutation bodies",async()=>{
  const calls:{path:string;body:unknown;key:string|null}[]=[];
  const capture:typeof fetch=async(url,init)=>{
    assert.equal(init?.credentials,"include");assert.equal(init?.cache,"no-store");
    const target=new URL(String(url));
    calls.push({path:target.pathname+target.search,body:init?.body ? JSON.parse(String(init.body)):null,key:new Headers(init?.headers).get("x-publishable-api-key")});
    return Response.json({});
  };
  const base="http://localhost:9000", customer=customerFinance(base,"pk_fixture",capture), merchant=merchantFinance(base,capture);
  await customer.order("order/foreign");await customer.apply(true);
  await merchant.order("order_1");await merchant.decide("delivery_1","line_1","NON_SELLABLE");
  await adminFinance(base,capture).list(20);
  assert.deepEqual(calls.map(r=>r.path),["/store/gospaza/orders/order%2Fforeign/financial-resolution","/store/gospaza/balance",
    "/merchant/orders/order_1/financial-resolution","/merchant/deliveries/delivery_1/dispositions","/admin/gospaza/financial-adjustments?limit=20&offset=20"]);
  assert.deepEqual(calls.map(r=>r.key),["pk_fixture","pk_fixture",null,null,null]);
  assert.deepEqual(calls[1]?.body,{use_balance:true});
  assert.deepEqual(calls[3]?.body,{line_id:"line_1",decision:"NON_SELLABLE",confirmed:true});
});
