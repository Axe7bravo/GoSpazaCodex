import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOrderDecision, isOrderDecisionReplay } from "../src/modules/marketplace/order-operation-policy";
import { requireCapability } from "../src/modules/marketplace/team-policy";

const input = { expected_revision: 0, confirmed: true };
test("M11 decisions strictly reject client authority and bound optional reasons", () => {
  for (const action of ["accept", "reject"] as const) {
    for (const field of ["status", "merchant_id", "store_id", "order_id", "decided_by", "decided_by_member_id",
      "accepted_at", "rejected_at", "revision", "capacity", "customer_id", "merchant_store_id"]) {
      assert.throws(() => parseOrderDecision(action, { ...input, [field]: "forged" }));
    }
    for (const body of [{}, { ...input, confirmed: false }, { ...input, expected_revision: -1 }]) {
      assert.throws(() => parseOrderDecision(action, body));
    }
  }
  assert.throws(() => parseOrderDecision("accept", { ...input, reason: "not accepted" }));
  assert.throws(() => parseOrderDecision("reject", { ...input, reason: "x".repeat(501) }));
  assert.equal(parseOrderDecision("reject", { ...input, reason: "  " }).reason, null);
  assert.equal(parseOrderDecision("reject", { ...input, reason: "  unavailable  " }).reason, "unavailable");
});
test("M11 replay preserves the first action and rejects changed reason or stale revision", () => {
  for (const action of ["accept", "reject"] as const) {
    const parsed = parseOrderDecision(action, input);
    assert.equal(isOrderDecisionReplay({ status: "PENDING_ACCEPTANCE", revision: 0, rejection_reason: null }, action, parsed), false);
    const terminal = { status: action === "accept" ? "ACCEPTED" : "REJECTED", revision: 1, rejection_reason: null };
    assert.equal(isOrderDecisionReplay(terminal, action, parsed), true);
    assert.throws(() => isOrderDecisionReplay(terminal, action === "accept" ? "reject" : "accept", parsed), /ORDER_DECISION_CONFLICT/);
    assert.throws(() => isOrderDecisionReplay(terminal, action, { ...parsed, expected_revision: 1 }), /ORDER_DECISION_CONFLICT/);
  }
  assert.throws(() => isOrderDecisionReplay({ status: "REJECTED", revision: 1, rejection_reason: "original" },
    "reject", parseOrderDecision("reject", { ...input, reason: "changed" })), /ORDER_DECISION_CONFLICT/);
});
test("M11 OWNER and MANAGER have reusable decision capability; PICKER does not", () => {
  for (const role of ["OWNER", "MANAGER"] as const) requireCapability(role, "MERCHANT_ORDER_DECIDE");
  assert.throws(() => requireCapability("PICKER", "MERCHANT_ORDER_DECIDE"), /capability/);
});
