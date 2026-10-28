import assert from "node:assert/strict";
import test from "node:test";
import { createRestrictedCommerceClient } from "../src/restricted-commerce";

test("restricted client submits proposals, never merchant approval or customer verification", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json({}); };
  const client = createRestrictedCommerceClient("http://localhost:9000",fetcher,"pk_fixture");
  const submission = { registration_number: "fixture", category: "GROCER_WINE" as const, issuing_authority: "fixture",
    valid_from: null, valid_until: null, evidence_ids: ["revd_fixture"] };
  await client.submit({ ...submission, ...{ status: "ACTIVE", merchant_id: "foreign", approved: true } });
  await client.purchaser();
  await client.propose("prod_fixture","NONE",null);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)),submission);
  assert.equal(calls[1]?.url.pathname,"/store/gospaza/purchaser-eligibility");
  assert.equal(calls[1]?.init?.method,"GET");
  assert.equal(calls[1]?.init?.body,undefined);
  assert.equal(calls[1]?.url.search,"");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)),{ restriction: "NONE",alcohol_class: null });
  for (const call of calls) {
    assert.equal(call.init?.credentials,"include"); assert.equal(call.init?.cache,"no-store");
  }
});

test("uncertain compliance writes are not automatically replayed and do not expose raw errors", async () => {
  let count = 0;
  const fetcher: typeof fetch = async () => { count++; return Response.json({ message: "private review diagnostics" },{ status: 503 }); };
  await assert.rejects(createRestrictedCommerceClient("http://localhost:9000",fetcher).propose("prod_fixture","ALCOHOL","WINE"),
    (error: unknown) => error instanceof Error && !error.message.includes("private review diagnostics"));
  assert.equal(count,1);
});

test("platform review and evidence requests retain explicit scope and allowlisted mutation fields",async()=>{
  const calls:{url:URL;init?:RequestInit}[]=[];
  const client=createRestrictedCommerceClient("http://localhost:9000",async(url,init)=>{calls.push({url:new URL(String(url)),init});return Response.json({});});
  await client.review("store_a",{action:"suspend",confirmed:true,expected_revision:3,reason:"Reviewed",...{merchant_id:"foreign",status:"ACTIVE"}});
  await client.reviewClassification("store_a","product_a",{restriction:"NONE",alcohol_class:null,confirmed:true,expected_identity:"a".repeat(64),reason:"Correction",...{approved:true,store_id:"foreign"}});
  await client.upload({display_name:"Evidence.pdf",mime_type:"application/pdf",content:"fixture",...{storage_key:"foreign",access:"public"}});
  assert.equal(calls[0]!.url.pathname,"/admin/gospaza/restricted-commerce/stores/store_a");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)),{action:"suspend",expected_revision:3,confirmed:true,reason:"Reviewed"});
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)),{restriction:"NONE",alcohol_class:null,expected_identity:"a".repeat(64),confirmed:true,reason:"Correction"});
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)),{document_type:"LIQUOR_DOCUMENT",display_name:"Evidence.pdf",mime_type:"application/pdf",content:"fixture"});
  assert.equal(client.evidenceUrl("evidence_a","store_a"),"http://localhost:9000/admin/gospaza/restricted-commerce/stores/store_a/documents/evidence_a");
});
