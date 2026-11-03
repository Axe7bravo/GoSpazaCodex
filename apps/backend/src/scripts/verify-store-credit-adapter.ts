import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Context, DAL, ExecArgs, ICustomerModuleService } from "@medusajs/framework/types";
import type { EntityManager } from "@medusajs/framework/mikro-orm/postgresql";
import type { ModuleAccountTransaction, ModuleCreditAccount } from "@medusajs/loyalty-plugin/types";
import { creditAccountStep, debitAccountStep } from "@medusajs/loyalty-plugin/workflows";
import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { MathBN, Modules } from "@medusajs/framework/utils";
import SafeStoreCreditService from "../modules/store-credit/service";

type FailureInput = { transactions: ModuleAccountTransaction[]; spend: boolean };
const failAfterCredit = createStep("c2a-verifier-fail-after-credit", async (input: FailureInput, { container }): Promise<StepResponse<never>> => {
  if (input.spend) {
    const transaction = input.transactions[0]; assert.ok(transaction);
    // A separately committed legitimate debit, deliberately outside compensation.
    await container.resolve<SafeStoreCreditService>("store_credit").debitAccounts([
      { account_id: transaction.account_id, amount: 80, reference: "c2a-proof", reference_id: randomUUID() },
    ]);
  }
  throw new Error("C2A intentional downstream failure");
});
// In pinned 2.18, finished root executions are deleted without retentionTime,
// even with store:true. Retain proof evidence for one day; this is not the
// lifetime policy for C2B's durable financial recovery operation.
const proofRetentionSeconds = 24 * 60 * 60;
const failedCreditWorkflow = createWorkflow({ name: "c2a-native-credit-compensation-proof", store: true, retentionTime: proofRetentionSeconds }, function (input: { credit: ModuleCreditAccount[]; spend: boolean }) {
  const transactions = creditAccountStep(input.credit);
  return new WorkflowResponse(failAfterCredit({ transactions, spend: input.spend }));
});
const failAfterDebit = createStep("c2a-verifier-fail-after-debit", async (_input: ModuleAccountTransaction[]): Promise<StepResponse<never>> => {
  throw new Error("C2A intentional debit downstream failure");
});
const failedDebitWorkflow = createWorkflow({ name: "c2a-native-debit-compensation-proof", store: true, retentionTime: proofRetentionSeconds }, function (input: ModuleCreditAccount[]) {
  return new WorkflowResponse(failAfterDebit(debitAccountStep(input)));
});

function deferred() {
  let release: () => void = () => { throw new Error("Uninitialized test barrier"); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("C2A concurrency proof did not progress")), 15000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Standalone proof: PostgreSQL + Redis only, no HTTP backend/Next servers needed. */
export default async function verifyStoreCreditAdapter({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("Run C2A proofs only on a development/test database");
  const service = container.resolve<SafeStoreCreditService>("store_credit");
  assert.ok(service instanceof SafeStoreCreditService, "stock Store Credit service must never resolve");
  assert.equal(service.gospazaSafeStoreCredit, "M18-C2A");
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  // Test-only access to the native repository gives explicit outer transactions.
  // Production callers must not resolve internal repositories to bypass the module.
  const repository = (service as unknown as { baseRepository_: DAL.RepositoryService }).baseRepository_;
  const transaction = <T>(work: (context: Context<EntityManager>) => Promise<T>): Promise<T> =>
    repository.transaction<EntityManager>(manager => work({ manager, transactionManager: manager }), { isolationLevel: "read committed" });
  const createdAccounts: string[] = [];
  const input = (id: string, amount: number | string): ModuleCreditAccount[] => [{ account_id: id, amount, reference: "c2a-proof", reference_id: randomUUID() }];
  async function account(balance: number) {
    const customer = await customers.createCustomers({ email: `c2a-${randomUUID()}@example.invalid`, has_account: true });
    const result = await service.createStoreCreditAccounts({ customer_id: customer.id, currency_code: "zar" });
    createdAccounts.push(result.id);
    if (balance) await service.creditAccounts(input(result.id, balance));
    return result.id;
  }
  async function balance(id: string, expected?: string) {
    const stats = await service.retrieveAccountStats({ account_id: id });
    assert.ok(MathBN.convert(stats.balance).gte(0), "native transaction-derived balance must not be negative");
    if (expected !== undefined) assert.equal(MathBN.convert(stats.balance).toFixed(), expected);
    return stats;
  }

  for (const [amount, successes, remaining] of [[80, 1, "20"], [50, 2, "0"], [100, 1, "0"]] as const) {
    const id = await account(100);
    const results = await Promise.allSettled([service.debitAccounts(input(id, amount)), service.debitAccounts(input(id, amount))]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, successes);
    for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "STORE_CREDIT_INSUFFICIENT_BALANCE");
    await balance(id, remaining);
  }

  // Underscored entry points also serialize; they are public in the pinned class.
  const direct = await account(100);
  const directResults = await Promise.allSettled([service.debitAccounts_(input(direct, 80)), service.debitAccounts_(input(direct, 80))]);
  assert.equal(directResults.filter(result => result.status === "fulfilled").length, 1);
  await balance(direct, "20");

  const first = await account(100), second = await account(100);
  const locked = deferred(), unlock = deferred();
  const holder = transaction(async context => {
    const runner = context.transactionManager?.getTransactionContext(); assert.ok(runner);
    await runner("store_credit_account").where({ id: first }).forUpdate().first();
    locked.release();
    await unlock.promise;
  });
  try {
    await bounded(Promise.race([locked.promise, holder]));
    // Must complete while the unrelated account's PostgreSQL lock is still held.
    await bounded(service.debitAccounts(input(second, 80)));
    await balance(second, "20");
  } finally { unlock.release(); await holder; }

  // Reversed request order must not produce a multi-account deadlock.
  const multiA = await account(100), multiB = await account(100);
  await bounded(Promise.all([
    service.debitAccounts([...input(multiA, 50), ...input(multiB, 50)]),
    service.debitAccounts([...input(multiB, 50), ...input(multiA, 50)]),
  ]));
  await balance(multiA, "0"); await balance(multiB, "0");

  const guarded = await account(100);
  for (const method of ["createAccountTransactions", "updateAccountTransactions", "deleteAccountTransactions", "softDeleteAccountTransactions", "restoreAccountTransactions", "updateStoreCreditAccounts", "deleteStoreCreditAccounts", "softDeleteStoreCreditAccounts", "restoreStoreCreditAccounts"] as const) {
    await assert.rejects(service[method]({ account_id: guarded, amount: -80, type: "debit", customer_id: "foreign" }), { code: "STORE_CREDIT_MUTATION_RESTRICTED" });
    await balance(guarded, "100");
  }
  await assert.rejects(service.creditAccounts(input(guarded, -1)), { code: "STORE_CREDIT_INVALID_INPUT" });
  await assert.rejects(service.debitAccounts([...input(guarded, 80), ...input(guarded, 80)]), { code: "STORE_CREDIT_INSUFFICIENT_BALANCE" });
  await balance(guarded, "100");
  await assert.rejects(service.createStoreCreditAccounts({ currency_code: "usd", customer_id: "foreign" }), { code: "STORE_CREDIT_INVALID_INPUT" });
  await assert.rejects(service.createStoreCreditAccounts({ currency_code: "zar" }), { code: "STORE_CREDIT_INVALID_INPUT" });
  await assert.rejects(service.createStoreCreditAccounts({ currency_code: "zar", customer_id: "foreign", balance: 100 }), { code: "STORE_CREDIT_INVALID_INPUT" });

  // Same native manager proof: credit, stats, debit and native inserts are visible
  // inside the caller transaction, then all disappear on its rollback.
  const rollbackAccount = await account(20), rollback = new Error("C2A outer rollback");
  const rolledIds: string[] = [];
  await assert.rejects(transaction(async context => {
    const runner = context.transactionManager?.getTransactionContext(); assert.ok(runner);
    const credited = await service.creditAccounts(input(rollbackAccount, 50), context);
    assert.equal(MathBN.convert((await service.retrieveAccountStats({ account_id: rollbackAccount }, context)).balance).toFixed(), "70",
      "new native credit must be SQL-visible before debit and outer commit");
    assert.equal((await runner("store_credit_account_transaction").whereIn("id", credited.map(row => row.id))).length, credited.length);
    const debited = await service.debitAccounts(input(rollbackAccount, 30), context);
    rolledIds.push(...credited.map(row => row.id), ...debited.map(row => row.id));
    assert.equal(MathBN.convert((await service.retrieveAccountStats({ account_id: rollbackAccount }, context)).balance).toFixed(), "40");
    assert.equal((await runner("store_credit_account_transaction").whereIn("id", rolledIds)).length, 2);
    throw rollback;
  }), error => error === rollback);
  assert.equal((await service.listAccountTransactions({ id: rolledIds })).length, 0);
  await balance(rollbackAccount, "20");

  // Real native step compensation (not a mock of deleteTransactions).
  for (const historical of [20, 50]) {
    const id = await account(historical);
    const before = await service.listAccountTransactions({ account_id: id });
    const run = await failedCreditWorkflow(container).run({ input: { credit: input(id, 50), spend: false }, throwOnError: false, context: { transactionId: randomUUID() } });
    assert.ok(run.errors.length);
    assert.match(JSON.stringify(run.errors), /C2A intentional downstream failure/);
    assert.doesNotMatch(JSON.stringify(run.errors), /Store Credit requires review|deleteTransactions is not a function/);
    const after = await service.listAccountTransactions({ account_id: id });
    assert.deepEqual(after.map(row => row.id).sort(), before.map(row => row.id).sort());
    await balance(id, String(historical));
  }
  const spent = await account(0);
  const spentTransactionId = randomUUID();
  const spentRun = await failedCreditWorkflow(container).run({ input: { credit: input(spent, 100), spend: true }, throwOnError: false, context: { transactionId: spentTransactionId } });
  assert.match(JSON.stringify(spentRun.transaction.getErrors()), /Store Credit requires review/);
  assert.notEqual(String(spentRun.transaction.getState()), "done");
  assert.equal(spentRun.transaction.transactionId, spentTransactionId);
  // Supported native workflow readback, not a parallel recovery table/ledger.
  const executions = await container.resolve<{
    listWorkflowExecutions(filters: { workflow_id: string; transaction_id: string }): Promise<{ state: string; execution: unknown; context: unknown; retention_time: number | null }[]>;
  }>(Modules.WORKFLOW_ENGINE).listWorkflowExecutions({ workflow_id: failedCreditWorkflow.getName(), transaction_id: spentTransactionId });
  assert.equal(executions.length, 1, "unresolved compensation must retain durable workflow evidence");
  assert.equal(executions[0]?.state, spentRun.transaction.getState());
  assert.equal(executions[0]?.retention_time, proofRetentionSeconds);
  assert.match(JSON.stringify(executions), /Store Credit requires review/);
  const spentHistory = await service.listAccountTransactions({ account_id: spent });
  assert.equal(spentHistory.length, 2);
  await balance(spent, "20");
  const credit = spentHistory.find(row => row.type === "credit"); assert.ok(credit);
  await assert.rejects(service.deleteTransactions([credit.id]), { code: "STORE_CREDIT_ATTENTION_REQUIRED" });
  await balance(spent, "20");

  const debitRollback = await account(100);
  const debitBefore = await service.listAccountTransactions({ account_id: debitRollback });
  const debitRun = await failedDebitWorkflow(container).run({ input: input(debitRollback, 80), throwOnError: false });
  assert.ok(debitRun.errors.length);
  assert.deepEqual((await service.listAccountTransactions({ account_id: debitRollback })).map(row => row.id), debitBefore.map(row => row.id));
  await balance(debitRollback, "100");

  const race = await account(0);
  const [raceCredit] = await service.creditAccounts(input(race, 100)); assert.ok(raceCredit);
  const raceResults = await Promise.allSettled([service.debitAccounts(input(race, 80)), service.deleteTransactions([raceCredit.id])]);
  if (raceResults[0]?.status === "fulfilled") {
    const compensation = raceResults[1];
    assert.ok(compensation?.status === "rejected");
    assert.equal(compensation.reason.code, "STORE_CREDIT_ATTENTION_REQUIRED");
    await balance(race, "20");
  } else {
    const debit = raceResults[0];
    assert.ok(debit?.status === "rejected");
    assert.equal(debit.reason.code, "STORE_CREDIT_INSUFFICIENT_BALANCE");
    assert.equal(raceResults[1]?.status, "fulfilled");
    await balance(race, "0");
    await service.deleteTransactions([raceCredit.id]); // Exact replay, no second effect.
  }
  // Safe alias replay must not fall back to deleting the account's other history.
  const exactReplay = await account(50);
  const [onlyNewCredit] = await service.creditAccounts(input(exactReplay, 50)); assert.ok(onlyNewCredit);
  await service.deleteTransactions([onlyNewCredit.id]);
  await service.deleteTransactions([onlyNewCredit.id]);
  await balance(exactReplay, "50");
  for (const id of createdAccounts) await balance(id);
  // Deliberately retain scoped native financial history; no destructive cleanup.
  console.info("M18-C2A Store Credit adapter verification passed; scoped test financial history retained.");
}
