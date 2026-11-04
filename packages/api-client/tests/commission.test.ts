import assert from "node:assert/strict";
import test from "node:test";
import { merchantCommission,platformCommission } from "../src/commission";
test("commission clients isolate actor paths and preserve an explicit zero-rate publication",async()=>{
  const paths:string[]=[], bodies:unknown[]=[];
  const capture:typeof fetch=async(url,init)=>{
    assert.equal(init?.cache,"no-store");assert.equal(init?.credentials,"include");
    paths.push(String(url));if(init?.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json({});
  };
  const base="http://localhost:9000",client=platformCommission(base,capture),merchant=merchantCommission(base,capture);
  const cmd={scope:"MERCHANT",merchant_id:"merchant_fixture",decision:"SET",basis_points:0,
    expected_revision:0,confirmed:true,request_id:"request_fixture",reason:"Contract rate"} as const;
  await client.history(cmd.merchant_id,20);await client.publish(cmd);await client.order("order/foreign");await merchant.order("order/foreign");
  assert.deepEqual(paths.map(path=>path.slice(base.length)),["/admin/gospaza/commission-rules?limit=20&offset=20&merchant_id=merchant_fixture",
    "/admin/gospaza/commission-rules","/admin/gospaza/orders/order%2Fforeign/finance-snapshot","/merchant/orders/order%2Fforeign/economics"]);
  assert.deepEqual(bodies,[cmd]);assert.deepEqual(Object.keys(merchant),["order"]);
});
