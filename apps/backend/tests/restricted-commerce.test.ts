import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryPermits, classificationDecision, classificationProposal, registrationSubmission,
  purchaserEvidence, restrictedSnapshot, restrictedDispatchBlock, salePermitted, tradingPolicy, unavailablePurchaserProvider, validatePurchaser } from "../src/modules/marketplace/restricted-policy";

const windows = Array.from({ length: 7 }, (_,day) => ({ day, start_minute: 480, end_minute: 1200 }));
const policy = tradingPolicy.parse({ timezone: "Africa/Johannesburg", source: "fixture reviewed conditions", version: "fixture-1",
  permitted_alcohol_classes: ["WINE"],
  effective_from: "2026-01-01T00:00:00Z", effective_until: null, regulatory_sale_windows: windows,
  licence_sale_windows: windows, store_sale_windows: windows, dispatch_windows: null, handoff_windows: null });
test("restricted sale intersects all reviewed windows at exact SA boundaries", () => {
  assert.equal(salePermitted(policy,new Date("2026-10-25T05:59:59Z")),false);
  assert.equal(salePermitted(policy,new Date("2026-10-25T06:00:00Z")),true);
  assert.equal(salePermitted(policy,new Date("2026-10-25T17:59:59Z")),true);
  assert.equal(salePermitted(policy,new Date("2026-10-25T18:00:00Z")),false);
  assert.equal(salePermitted({ ...policy, licence_sale_windows: [{ day: 0,start_minute: 600,end_minute: 660 }] },new Date("2026-10-25T06:00:00Z")),false);
  assert.equal(salePermitted({ ...policy, effective_until: "2026-10-25T06:00:00Z" },new Date("2026-10-25T06:00:00Z")),false);
});
test("registration capabilities never turn grocer wine into general liquor permission", () => {
  assert.equal(categoryPermits("GROCER_WINE","WINE"),true);
  for (const kind of ["SPIRITS","BEER","OTHER"] as const) assert.equal(categoryPermits("GROCER_WINE",kind),false);
});
test("production purchaser boundary has no self-declaration path", async () => {
  assert.deepEqual(await unavailablePurchaserProvider.evaluate("cus_a",new Date()),{ state: "UNAVAILABLE" });
  assert.throws(() => validatePurchaser({ state: "UNAVAILABLE" },"cus_a",new Date()),/PURCHASER_VERIFICATION_UNAVAILABLE/);
});
test("purchaser evidence binds customer, age AND provincial policy, expiry and revocation", () => {
  const evidence = { id: "pelig_a",customer_id: "cus_a",method: "fixture",method_version: "1",policy_version: "1",minimum_age: 18 as const,
    provincial_requirements_satisfied: true as const,state: "VERIFIED" as const,verified_at: "2026-10-25T05:00:00Z",expires_at: "2026-10-25T07:00:00Z" };
  assert.equal(validatePurchaser({ state: "VERIFIED",evidence },"cus_a",new Date("2026-10-25T06:00:00Z")).id,"pelig_a");
  assert.throws(() => validatePurchaser({ state: "VERIFIED",evidence },"cus_b",new Date("2026-10-25T06:00:00Z")));
  assert.throws(() => validatePurchaser({ state: "VERIFIED",evidence },"cus_a",new Date("2026-10-25T07:00:00Z")),/EXPIRED/);
  assert.throws(() => validatePurchaser({ state: "VERIFIED",evidence: { ...evidence,state: "REVOKED" } },"cus_a",new Date("2026-10-25T06:00:00Z")));
  assert.equal(purchaserEvidence.safeParse({ ...evidence, provincial_requirements_satisfied: false }).success,false);
  assert.equal(purchaserEvidence.safeParse({ ...evidence, date_of_birth: "1990-01-01" }).success,false);
});
test("classification and registration reject authority mass assignment", () => {
  assert.equal(classificationProposal.safeParse({ restriction: "NONE",alcohol_class: null,approved: true }).success,false);
  assert.equal(classificationDecision.safeParse({ restriction: "ALCOHOL",alcohol_class: null,confirmed: true,reason: "test",expected_identity: "a".repeat(64) }).success,false);
  assert.equal(registrationSubmission.safeParse({ registration_number: "fixture",category: "GROCER_WINE",issuing_authority: "fixture",
    valid_from: null,valid_until: null,evidence_ids: ["revd_a"],status: "ACTIVE" }).success,false);
});
test("restricted snapshots cannot contradict their inherited product decisions", () => {
  assert.equal(restrictedSnapshot.safeParse({ version: 1,restricted_content_present: false,
    classifications: [{ product_id: "prod_a",variant_id: "variant_a",revision_id: "rrev_a",restriction: "ALCOHOL",alcohol_class: "WINE" }],
    registration_id: null,registration_revision: null,trading_policy_version: null,purchaser_evidence_id: null }).success,false);
});
test("unknown historical truth and unresolved delivery documentation never admit dispatch", () => {
  assert.equal(restrictedDispatchBlock(undefined),"DISPATCH_PRODUCT_EVIDENCE");
  const snapshot = restrictedSnapshot.parse({ version: 1,restricted_content_present: true,
    classifications: [{ product_id: "prod_a",variant_id: "variant_a",revision_id: "rrev_a",restriction: "ALCOHOL",alcohol_class: "WINE" }],
    registration_id: "rreg_a",registration_revision: 1,trading_policy_version: "fixture-1",purchaser_evidence_id: "pelig_a" });
  assert.equal(restrictedDispatchBlock(snapshot),"RESTRICTED_DELIVERY_DOCUMENTATION_UNAVAILABLE");
});
