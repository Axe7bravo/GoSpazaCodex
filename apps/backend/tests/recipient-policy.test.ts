import assert from "node:assert/strict";
import test from "node:test";
import { ageThreshold, recipientInput, evaluateRestrictedRecipientCompliance, deliveryDocumentPolicy } from "../src/modules/marketplace/recipient-policy";
const observation = { expected_revision: 1, recipient_role:"PURCHASER" as const,document_type:"IDENTITY_DOCUMENT" as const,
  document_viewed:true,date_of_birth:"2000-01-01",school_uniform_observed:false,recipient_declares_school_going_learner:false,
  recipient_appears_intoxicated:false,recipient_refused_verification:false,invoice_address_matches:true };
test("recipient age uses SA calendar and conservative leap anniversary",()=>{
  assert.equal(ageThreshold("2008-10-26",new Date("2026-10-25T21:59:59Z")),false);
  assert.equal(ageThreshold("2008-10-26",new Date("2026-10-25T22:00:00Z")),true);
  assert.equal(ageThreshold("2008-10-25",new Date("2026-10-25T22:00:00Z")),true);
  assert.equal(ageThreshold("2008-02-29",new Date("2026-02-28T12:00:00Z")),false);
  assert.equal(ageThreshold("2008-02-29",new Date("2026-02-28T22:00:00Z")),true);
  for(const invalid of ["2026-10-27","2001-02-29","not-a-date","2000-1-01"]) assert.throws(()=>ageThreshold(invalid,new Date("2026-10-26T12:00:00Z")));
});
test("strict transient inputs reject identity warehousing and client authority",()=>{
  for(const key of ["age","adult","over_18","compliance_satisfied","driver_id","merchant_id","document_number","id_number","image","return_quantity"])
    assert.equal(recipientInput.safeParse({...observation,[key]:true}).success,false);
  for(const document_type of ["STUDENT_CARD","PHOTO","SCREENSHOT","BIRTH_CERTIFICATE"]) assert.equal(recipientInput.safeParse({...observation,document_type}).success,false);
  for(const document_type of ["IDENTITY_DOCUMENT","DRIVERS_LICENCE","PASSPORT"]) assert.equal(recipientInput.safeParse({...observation,document_type}).success,true);
});
test("every independent refusal applies equally to purchaser and alternate adult",()=>{
  const now=new Date("2026-10-26T12:00:00Z");
  const cases:[Partial<typeof observation>,string][]=[
    [{document_viewed:false},"NO_ACCEPTABLE_ID"], [{date_of_birth:"2010-01-01"},"UNDER_MINIMUM_AGE"],
    [{school_uniform_observed:true},"SCHOOL_UNIFORM"],[{recipient_declares_school_going_learner:true},"SCHOOL_GOING_LEARNER"],
    [{recipient_appears_intoxicated:true},"APPARENT_INTOXICATION"],[{recipient_refused_verification:true},"RECIPIENT_REFUSED_VERIFICATION"],
    [{invoice_address_matches:false},"DELIVERY_ADDRESS_MISMATCH"]];
  for(const recipient_role of ["PURCHASER","ALTERNATE_ADULT"] as const) {
    const success=evaluateRestrictedRecipientCompliance({...observation,recipient_role},now);
    assert.equal(success.outcome,"SATISFIED"); assert.equal(JSON.stringify(success).includes("2000-01-01"),false);
    assert.equal("date_of_birth" in success.evidence,false);
    for(const [patch,reason] of cases) assert.equal(evaluateRestrictedRecipientCompliance({...observation,...patch,recipient_role},now).reason,reason);
  }
});
test("document approval fails closed without explicit versioned policy",()=>{
  const approved=process.env.DELIVERY_DOCUMENT_POLICY_APPROVED,version=process.env.DELIVERY_DOCUMENT_POLICY_VERSION;
  try {
    delete process.env.DELIVERY_DOCUMENT_POLICY_APPROVED;delete process.env.DELIVERY_DOCUMENT_POLICY_VERSION;
    assert.equal(deliveryDocumentPolicy(),null);
    process.env.DELIVERY_DOCUMENT_POLICY_APPROVED="true";assert.equal(deliveryDocumentPolicy(),null);
    process.env.DELIVERY_DOCUMENT_POLICY_VERSION="test-policy";assert.deepEqual(deliveryDocumentPolicy(),{version:"test-policy"});
  } finally {
    if(approved===undefined)delete process.env.DELIVERY_DOCUMENT_POLICY_APPROVED;else process.env.DELIVERY_DOCUMENT_POLICY_APPROVED=approved;
    if(version===undefined)delete process.env.DELIVERY_DOCUMENT_POLICY_VERSION;else process.env.DELIVERY_DOCUMENT_POLICY_VERSION=version;
  }
});
