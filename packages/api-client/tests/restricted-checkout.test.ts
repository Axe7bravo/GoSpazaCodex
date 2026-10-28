import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutClient, CheckoutError } from "../src/checkout";
test("restricted checkout errors expose bounded wording and never provider or licence payloads",async()=>{
  for(const code of ["PURCHASER_VERIFICATION_UNAVAILABLE","PURCHASER_VERIFICATION_NOT_VERIFIED","PURCHASER_VERIFICATION_EXPIRED","CLASSIFICATION_REVIEW_REQUIRED","RESTRICTED_STORE_UNAVAILABLE","RESTRICTED_CATEGORY_UNAVAILABLE","RESTRICTED_TRADING_CLOSED"]){
    let writes=0;
    const client=createCheckoutClient("http://localhost:9000","pk_fixture",async()=>{writes++;return Response.json({code,message:"private licence diagnostics",licence_number:"private"},{status:409});});
    await assert.rejects(client.prepare({cart_id:"cart",address_id:"address",expected_reservation_revision:1}),
      (error:unknown)=>error instanceof CheckoutError&&error.code===code&&!error.message.includes("private")&&!error.message.includes("licence"));
    assert.equal(writes,1);
  }
  const unknown=new CheckoutError(409,"PRIVATE_PROVIDER_DIAGNOSTIC");
  assert.equal(unknown.message,"We could not confirm checkout. Refresh its status before making another payment attempt.");
});
