import assert from "node:assert/strict";
import { test } from "node:test";
import { recognizeManifest,recognitionEvidence } from "../src/modules/marketplace/recognition-policy";

const snapshot=(net:number,tax:number,subsidy:number,quantity:number,allocated?:number)=>recognitionEvidence.parse({
  native_economics_fingerprint:"fixture",basis_minor:net+subsidy,
  components:{merchandise_net_minor:net,merchandise_tax_minor:tax,platform_subsidy_minor:subsidy},
  lines:[{id:"line",quantity,net_minor:net,tax_minor:tax,subsidy_minor:allocated}],
});
test("M19-C delivered consideration excludes shipping and ignores tender",()=>{
  for(const funding of [{external_minor:13800,credit_minor:0},{external_minor:7458,credit_minor:6342}]) {
    const e=snapshot(10000,1500,0,1);
    const original={...e,components:{...e.components,...funding,shipping_net_minor:2000,shipping_tax_minor:300}};
    assert.deepEqual(recognizeManifest(original,[{id:"line",quantity:1}],1000).effects,
      {merchandise_minor:10000,tax_minor:1500,subsidy_minor:0,commission_minor:1000,entitlement_minor:9000});
  }
});
test("M19-C merchant discount and proven make-whole stay distinct",()=>{
  const all=[{id:"line",quantity:1}];
  assert.equal(recognizeManifest(snapshot(9000,0,0,1),all,1000).effects.commission_minor,900);
  assert.deepEqual(recognizeManifest(snapshot(9000,0,1000,1),all,1000).effects,
    {merchandise_minor:9000,tax_minor:0,subsidy_minor:1000,commission_minor:1000,entitlement_minor:9000});
  assert.equal(recognizeManifest(snapshot(9000,0,1000,2,1000),all,1000).effects.subsidy_minor,500);
  assert.throws(()=>recognizeManifest(snapshot(9000,0,1000,2),all,1000),/UNRESOLVED_ADJUSTMENT_ATTRIBUTION/);
});
test("M19-C physical manifest consumes picked prefix and preserves odd cents",()=>{
  const e=snapshot(1001,10,0,3);
  assert.deepEqual(recognizeManifest(e,[{id:"line",quantity:2}],1000).effects,
    {merchandise_minor:668,tax_minor:7,subsidy_minor:0,commission_minor:67,entitlement_minor:601});
  assert.equal(recognizeManifest(snapshot(105,0,0,1),[{id:"line",quantity:1}],1000).effects.commission_minor,11);
  assert.throws(()=>recognizeManifest(e,[{id:"other",quantity:1}],1000));
  assert.throws(()=>recognizeManifest(e,[{id:"line",quantity:4}],1000));
  assert.throws(()=>recognizeManifest(e,[{id:"line",quantity:1},{id:"line",quantity:1}],1000));
});
