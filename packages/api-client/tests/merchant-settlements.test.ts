import assert from "node:assert/strict";
import test from "node:test";
import { platformSettlements,merchantSettlements } from "../src/merchant-settlements";
test("settlement clients have actor-specific reads and explicit, non-replayed commands",async()=>{
  const seen:{path:string;method:string;body:unknown}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{assert.equal(init?.credentials,"include");assert.equal(init?.cache,"no-store");
    seen.push({path:new URL(String(url)).pathname,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});return Response.json({});};
  const admin=platformSettlements("http://localhost:9000",fetcher),merchant=merchantSettlements("http://localhost:9000",fetcher);
  await merchant.list();await merchant.detail("foreign/id");await admin.list();await admin.detail("statement_id");await admin.evidence("payable_id");
  const command={request_id:"request_id",expected_revision:2,confirmed:true,reason:"Reviewed"} as const;
  await admin.prepare("statement_id",command);await admin.supersede("statement_id",command);await admin.approve("payable_id",command);
  await admin.recordPayout("payable_id",{...command,amount_minor:9000,currency:"zar",channel:"BANK_TRANSFER",beneficiary_reference:"verified_ref",
    origin_reference:"origin_ref",external_transfer_id:"bank_ref",transferred_at:"2026-11-10T12:00:00Z"});
  assert.deepEqual(Object.keys(merchant),["list","detail"]);
  assert.equal(seen[1]?.path,"/merchant/settlements/foreign%2Fid");
  assert.deepEqual(seen.slice(5).map(x=>x.path),["/admin/gospaza/merchant-settlements/statement_id/prepare","/admin/gospaza/merchant-settlements/statement_id/supersede",
    "/admin/gospaza/merchant-payouts/payable_id/approve","/admin/gospaza/merchant-payouts/payable_id/payout"]);
  assert.deepEqual(seen[7]?.body,command);
});
test("settlement errors are bounded and mutation requests are never automatically retried",async()=>{
  let calls=0;const client=platformSettlements("http://localhost:9000",async()=>{calls++;return Response.json({message:"private SQL proof key"},{status:409});});
  await assert.rejects(client.approve("payable",{request_id:"request",expected_revision:1,confirmed:true,reason:"Review"}),error=>error instanceof Error&&/Refresh and review/.test(error.message)&&!error.message.includes("private SQL"));
  assert.equal(calls,1);
});
