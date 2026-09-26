import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewTransition, editableApplication, reasonInput, approvalInput, emptyReviewInput, reviewActions } from "../src/modules/marketplace/review-policy";
import { statuses, parse } from "../src/modules/marketplace/validation";
test("review actions accept only the explicit source state", () => {
  for (const status of statuses) for (const action of reviewActions) {
    if (status === (action === "start-review" ? "SUBMITTED" : "UNDER_REVIEW")) assert.ok(reviewTransition(status, action));
    else assert.throws(() => reviewTransition(status, action));
  }
  assert.equal(reviewTransition("SUBMITTED", "start-review"), "UNDER_REVIEW");
  assert.equal(reviewTransition("UNDER_REVIEW", "request-information"), "MORE_INFORMATION_REQUIRED");
  assert.equal(reviewTransition("UNDER_REVIEW", "reject"), "REJECTED");
  assert.equal(reviewTransition("UNDER_REVIEW", "approve"), "APPROVED");
});
test("only drafts and information requests are editable", () => {
  for (const status of statuses) assert.equal(editableApplication(status), ["DRAFT", "MORE_INFORMATION_REQUIRED"].includes(status));
});
test("review inputs require reasons and approval confirmation and reject injected tenancy", () => {
  for (const reason of ["", "  ", "x".repeat(2001)]) assert.throws(() => parse(reasonInput, { reason }));
  assert.deepEqual(parse(reasonInput, { reason: " Explain address " }), { reason: "Explain address" });
  assert.throws(() => parse(approvalInput, { reason: "Reviewed" }));
  assert.throws(() => parse(approvalInput, { confirmed: false, reason: "Reviewed" }));
  assert.throws(() => parse(approvalInput, { confirmed: true, reason: "" }));
  for (const field of ["merchant_id", "auth_identity_id", "owner_id", "medusa_stock_location_id", "status"]) {
    assert.throws(() => parse(approvalInput, { confirmed: true, reason: "Reviewed", [field]: "injected" }));
    assert.throws(() => parse(reasonInput, { reason: "Reviewed", [field]: "injected" }));
    assert.throws(() => parse(emptyReviewInput, { [field]: "injected" }));
  }
});
