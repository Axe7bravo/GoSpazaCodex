import assert from "node:assert/strict";
import test from "node:test";
import type { RecipientObservation } from "@gospaza/contracts";
import { createRecipientClient } from "../src/recipient";

test("recipient requests allowlist observations and never replay an uncertain mutation",async()=>{
  const input:RecipientObservation={expected_revision:2,recipient_role:"ALTERNATE_ADULT",document_type:"PASSPORT",document_viewed:true,
    date_of_birth:"1990-01-01",school_uniform_observed:false,recipient_declares_school_going_learner:false,
    recipient_appears_intoxicated:false,recipient_refused_verification:false,invoice_address_matches:true};
  const calls:{path:string;body:unknown}[]=[];
  const client=createRecipientClient("http://localhost:9000",async(url,init)=>{
    assert.equal(init?.credentials,"include");assert.equal(init?.cache,"no-store");
    calls.push({path:new URL(String(url)).pathname,body:init?.body?JSON.parse(String(init.body)):null});
    return Response.json({},{status:init?.method==="GET"?200:409});
  });
  await assert.rejects(client.verify("delivery",{...input,...{compliance_satisfied:true,driver_id:"forged",id_number:"forbidden"}}));
  assert.deepEqual(calls[0]?.body,input);
  await client.read("delivery");
  await assert.rejects(client.receiveReturn("delivery",2));
  assert.deepEqual(calls.map(c=>c.path),["/driver/deliveries/delivery/recipient","/driver/deliveries/delivery/recipient","/merchant/deliveries/delivery/return"]);
});

test("lost return receipt response is read back rather than automatically resubmitted",async()=>{
  let writes=0;
  const client=createRecipientClient("http://localhost:9000",async(_url,init)=>{
    if(init?.method!=="GET"){writes++;throw new TypeError("Response lost");}
    return Response.json({return_state:"RETURNED_TO_STORE"});
  });
  await assert.rejects(client.receiveReturn("delivery",3));
  assert.equal((await client.merchantReturn("delivery")).return_state,"RETURNED_TO_STORE");
  assert.equal(writes,1);
});
