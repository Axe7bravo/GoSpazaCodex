import assert from "node:assert/strict";
import { test } from "node:test";
import { accounted, preferenceInput, omissionInput, shortageEvidence } from "../src/modules/marketplace/shortage-policy";
import { preferenceDTO } from "../src/modules/marketplace/shortage-resolution";

test("absent preference is CONTACT_ME without implied prior consent", () => {
  assert.deepEqual(preferenceDTO(), { preference: "CONTACT_ME", revision: 0, chosen_at: null, frozen_at: null });
});
test("completion accounts for physical originals and terminal omissions exactly", () => {
  for (const [q, p, o] of [[5,5,0],[5,3,2],[1,0,1]] as const) assert.equal(accounted(q,p,o), true);
  for (const [q,p,o] of [[5,3,0],[5,4,2],[5,-1,6],[5,2.5,2.5],[0,0,0],[Number.MAX_SAFE_INTEGER+1,0,0]] as const) {
    assert.equal(accounted(q,p,o), false);
  }
});
test("customer inputs cannot assign quantities, authority, money or operational state", () => {
  const choice = { preference: "NO_SUBSTITUTION", expected_revision: 0 };
  const consent = { expected_revision: 1, confirmed: true };
  assert.equal(preferenceInput.safeParse(choice).success, true);
  assert.equal(omissionInput.safeParse(consent).success, true);
  for (const key of ["customer_id","merchant_id","store_id","status","picked_quantity","omitted_quantity","refund_amount","order_id"]) {
    assert.equal(preferenceInput.safeParse({ ...choice, [key]: "forged" }).success, false);
    assert.equal(omissionInput.safeParse({ ...consent, [key]: "forged" }).success, false);
  }
  assert.equal(omissionInput.safeParse({ ...consent, confirmed: false }).success, false);
  assert.equal(preferenceInput.safeParse({ ...choice, preference: "BEST_MATCH" }).success, false);
});
test("immutable shortage evidence records the exact missing original quantity", () => {
  const e = { ordered: 5, picked: 2, missing: 3, native_order_id: "order", native_line_id: "line",
    checkout_completion_id: "completion", source_lines_fingerprint: "fingerprint", preference: "CONTACT_ME", preference_revision: 1 };
  assert.equal(shortageEvidence.safeParse(e).success, true);
  for (const missing of [0,2,4,-1,2.5]) assert.equal(shortageEvidence.safeParse({ ...e, missing }).success, false);
  assert.equal(shortageEvidence.safeParse({ ...e, refund_amount: 100 }).success, false);
});
