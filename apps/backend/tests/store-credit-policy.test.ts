import test from "node:test";
import assert from "node:assert/strict";
import { exactIds, mutationAccounts, reversibleCredit, validateCurrency } from "../src/modules/store-credit/policy";
import SafeStoreCreditService from "../src/modules/store-credit/service";
import type { IStoreCreditModuleService } from "@medusajs/loyalty-plugin/types";

test("Store Credit locks a sorted unique account set, never request order", () => {
  const item = { amount: "0.01", reference: "test", reference_id: "fixture" };
  assert.deepEqual(mutationAccounts([{ ...item, account_id: "b" }, { ...item, account_id: "a" }, { ...item, account_id: "b" }]), ["a", "b"]);
  for (const ids of [[{}], [""], ["../foreign"], "account", Array(1), Array(101).fill("a")]) assert.throws(() => exactIds(ids));
});
test("Store Credit requires ZAR and positive exact-cent amounts; rejects mass assignment", () => {
  validateCurrency("zar");
  for (const currency of ["usd", "ZAR", null, undefined]) assert.throws(() => validateCurrency(currency));
  for (const amount of ["-1", "0", "NaN", "Infinity", "0.001"]) assert.throws(() => mutationAccounts([{ account_id: "a", amount, reference: "test", reference_id: "fixture" }]));
  assert.throws(() => mutationAccounts([{ account_id: "a", amount: 1, reference: "test", reference_id: "fixture", type: "debit" } as never]));
});
test("exact compensation is conservative about spent or ambiguous credit", () => {
  assert.equal(reversibleCredit("70", "50", false), true);
  assert.equal(reversibleCredit("100", "50", false), true);
  assert.equal(reversibleCredit("20", "100", true), false);
  assert.equal(reversibleCredit("120", "100", true), false); // Replenishment does not prove unspent.
  assert.equal(reversibleCredit("20", "50", false), false);
});
test("all generated balance/history mutations reject before touching persistence", async () => {
  // Run instance initializers for the generated-CRUD property overrides. These
  // commands must reject without accessing any persistence dependency.
  const dependencies = {} as ConstructorParameters<typeof SafeStoreCreditService>[0];
  const service = new SafeStoreCreditService(dependencies);
  for (const method of ["createAccountTransactions", "updateAccountTransactions", "deleteAccountTransactions", "softDeleteAccountTransactions", "restoreAccountTransactions", "updateStoreCreditAccounts", "deleteStoreCreditAccounts", "softDeleteStoreCreditAccounts", "restoreStoreCreditAccounts"] as const) {
    await assert.rejects(service[method]({ amount: -80, type: "debit", account_id: "foreign" }), { code: "STORE_CREDIT_MUTATION_RESTRICTED" });
  }
  // Pinned SDK generates no public upsert method. Detect accidental future exposure.
  assert.equal("upsertAccountTransactions" in service, false);
});

// Type-level compatibility for the native workflow-facing contract. The pinned
// native interface's unrelated update/list overloads already differ from its class.
type WorkflowContract = Pick<IStoreCreditModuleService, "creditAccounts" | "debitAccounts" | "deleteTransactions" | "retrieveAccountStats" | "createStoreCreditAccounts">;
export const nativeWorkflowCompatible = (service: SafeStoreCreditService): WorkflowContract => service;
