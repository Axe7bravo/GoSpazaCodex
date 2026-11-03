import NativeModule from "@medusajs/loyalty-plugin/.medusa/server/src/modules/store-credit";
import type { Context } from "@medusajs/framework/types";
import type { EntityManager } from "@medusajs/framework/mikro-orm/postgresql";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ModuleCreditAccount, ModuleDebitAccount, ModuleStoreCreditAccount } from "@medusajs/loyalty-plugin/types";
import { MathBN, MedusaError } from "@medusajs/framework/utils";
import { creditAttention, exactIds, invalidCreditInput, mutationAccounts, restrictedMutation, reversibleCredit, validateCurrency } from "./policy";
import { nativePrice, minorPrice } from "../marketplace/catalogue-policy";
import { checkoutSnapshot } from "../marketplace/checkout-policy";
import type { Attempt } from "../marketplace/checkout-repository";

const NativeService = NativeModule.service;
type TransactionRow = { id: string; account_id: string; type: string; amount: string; reference: string; deleted_at: Date | null };

/** Internal primitive, not an actor-authorized financial API. No plugin routes are loaded. */
export default class SafeStoreCreditService extends NativeService {
  readonly gospazaSafeStoreCredit = "M18-C2A";

  private async transaction<T>(context: Context, work: (context: Context<EntityManager>) => Promise<T>): Promise<T> {
    if (context.transactionManager) return work(context as Context<EntityManager>);
    return this.baseRepository_.transaction<EntityManager>(transactionManager => work({ ...context, manager: transactionManager, transactionManager }),
      { isolationLevel: "read committed" });
  }

  private runner(context: Context<EntityManager>): Knex.Transaction {
    const runner = context.transactionManager?.getTransactionContext();
    if (!runner) creditAttention(); // Never use an unscoped connection.
    // The pinned PostgreSQL manager exposes this as an untyped transaction context.
    return runner as Knex.Transaction;
  }

  private async lockAccounts(ids: string[], context: Context<EntityManager>) {
    const runner = this.runner(context);
    const isolation = await runner.raw("select current_setting('transaction_isolation') as isolation");
    if (isolation.rows[0]?.isolation !== "read committed") creditAttention();
    // Separate ordered statements guarantee acquisition order independently of query plans.
    for (const id of exactIds(ids)) {
      const account = await runner("store_credit_account").where({ id }).forUpdate().first();
      if (!account || account.deleted_at || !account.customer_id) invalidCreditInput();
      validateCurrency(account.currency_code);
    }
  }

  async customerAccount(customer: string, create: boolean, context:Context = {}) {
    exactIds([customer]);
    return this.transaction(context, async shared => {
      const runner = this.runner(shared);
      await runner.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", ["gospaza:zar-credit:" + customer]);
      const accounts = await this.listStoreCreditAccounts({ customer_id: customer, currency_code: "zar" }, { take: 2 }, shared);
      if (accounts.length > 1) creditAttention();
      if (accounts[0]) return accounts[0].id;
      if (!create) return null;
      const made=await this.createStoreCreditAccounts({ customer_id: customer, currency_code: "zar" }, shared);
      if(!shared.transactionManager) creditAttention();
      await shared.transactionManager.flush();
      return made.id;
    });
  }

  async issueSettlement(account: string, customer: string, operation: string, minor: number, context:Context = {}) {
    exactIds([account, customer, operation]);
    const reference = "gospaza-financial-settlement";
    return this.transaction(context, async shared => {
      await this.lockAccounts([account], shared);
      const runner = this.runner(shared);
      const owner = await this.retrieveStoreCreditAccount(account, {}, shared);
      if (owner.customer_id !== customer || owner.currency_code !== "zar") creditAttention();
      const source=await runner("store_credit_operation as o").join("financial_settlement as s","s.id","o.settlement_id")
        .where({"o.id":operation,"o.customer_id":customer,"o.account_id":account,"o.amount_minor":minor,"s.method":"STORE_CREDIT"})
        .whereIn("o.status",["ISSUING","ATTENTION_REQUIRED","SETTLED"]).select("o.status","s.state").first();
      if(!source || source.state!==(source.status==="SETTLED" ? "SETTLED":"RESERVED")) creditAttention();
      const readback = async () => {
        const rows = await runner<TransactionRow>("store_credit_account_transaction").where({ reference, reference_id: operation }).limit(2);
        if (!rows.length) return null;
        const row = rows[0];
        if (rows.length !== 1 || !row || row.deleted_at || row.account_id !== account || row.type !== "credit"
          || minorPrice(MathBN.convert(row.amount).toFixed()) !== minor) creditAttention();
        return row.id;
      };
      const existing = await readback();
      if (existing) return existing;
      if(source.status==="SETTLED") creditAttention();
      await this.creditAccounts([{ account_id: account, amount: nativePrice(minor), reference, reference_id: operation }], shared);
      return await readback() ?? creditAttention();
    });
  }

  async spendCheckout(attemptId:string, customer:string, context:Context = {}) {
    return this.transaction(context,async shared=>{
      const runner=this.runner(shared);
      const attempt=await runner<Attempt>("checkout_attempt").where({id:attemptId}).forUpdate().first();
      if(!attempt || attempt.state!=="PAYMENT_PENDING" || attempt.closed_at) creditAttention();
      const snapshot=checkoutSnapshot.parse(attempt.snapshot), funding=snapshot.store_credit;
      if(!funding || snapshot.customer_id!==customer || snapshot.currency_code!=="zar") creditAttention();
      const existing=await runner("checkout_credit_redemption").where({attempt_id:attemptId}).first();
      if(existing) {
        if(existing.restore_id || existing.account_id!==funding.account_id || Number(existing.amount_minor)!==funding.amount_minor) creditAttention();
        return existing.native_debit_id as string;
      }
      await this.lockAccounts([funding.account_id],shared);
      const owner=await this.retrieveStoreCreditAccount(funding.account_id,{},shared);
      if(owner.customer_id!==customer || owner.currency_code!=="zar") creditAttention();
      const [debit]=await this.debitAccounts([{account_id:owner.id,amount:nativePrice(funding.amount_minor),
        reference:"gospaza-checkout",reference_id:attemptId}],shared);
      if(!debit?.id) creditAttention();
      await runner("checkout_credit_redemption").insert({attempt_id:attemptId,customer_id:customer,account_id:owner.id,
        amount_minor:funding.amount_minor,gross_minor:funding.gross_minor,external_minor:snapshot.totals.total_minor,currency:"zar",native_debit_id:debit.id});
      return debit.id;
    });
  }

  async restoreClosedCheckout(attemptId:string) {
    await this.transaction({},async shared=>{
      const runner=this.runner(shared);
      const attempt=await runner<Attempt>("checkout_attempt").where({id:attemptId}).forUpdate().first();
      if(!attempt?.closed_at || attempt.payment_accepted_at || !["FAILED","EXPIRED","ABANDONED","SUPERSEDED"].includes(attempt.state)) return;
      if(await runner("checkout_completion").where({checkout_attempt_id:attemptId}).first()) creditAttention();
      const spent=await runner("checkout_credit_redemption").where({attempt_id:attemptId}).forUpdate().first();
      if(!spent || spent.restore_id) return;
      const [credit]=await this.creditAccounts([{account_id:spent.account_id,amount:nativePrice(Number(spent.amount_minor)),
        reference:"gospaza-checkout-restoration",reference_id:attemptId}],shared);
      if(!credit?.id) creditAttention();
      await runner("checkout_credit_redemption").where({attempt_id:attemptId}).update({restore_id:credit.id,restored_at:runner.fn.now()});
    });
  }

  // Native stats converts SUM to Number. Preserve exact native transaction-derived
  // decimal values at this boundary instead; no parallel balance or ledger exists.
  override async retrieveAccountStats(data: { account_id: string }, context: Context = {}) {
    return this.transaction(context, async shared => {
      exactIds([data.account_id]);
      await super.retrieveStoreCreditAccount(data.account_id, {}, shared);
      const row = await this.runner(shared)("store_credit_account_transaction")
        .where({ account_id: data.account_id })
        .select(this.runner(shared).raw("coalesce(sum(case when type = 'credit' then amount else -amount end), 0)::text as balance, coalesce(sum(case when type = 'credit' then amount else 0 end), 0)::text as credits, coalesce(sum(case when type = 'debit' then amount else 0 end), 0)::text as debits")).first();
      return { id: data.account_id, balance: String(row.balance), credits: String(row.credits), debits: String(row.debits) };
    });
  }

  override async creditAccounts_(data: ModuleCreditAccount[], context: Context = {}) {
    const ids = mutationAccounts(data);
    return this.transaction(context, async shared => {
      await this.lockAccounts(ids, shared);
      const transactions = await super.creditAccounts_(data, shared);
      // Native create persists into MikroORM's unit of work without flushing.
      // SQL balance reads in a caller-owned transaction must see this credit
      // before its eventual commit; flush preserves the transaction and locks.
      const manager = shared.transactionManager;
      if (!manager) creditAttention();
      await manager.flush();
      return transactions;
    });
  }

  override async debitAccounts_(data: ModuleDebitAccount[], context: Context = {}) {
    const ids = mutationAccounts(data);
    return this.transaction(context, async shared => {
      await this.lockAccounts(ids, shared);
      // Validate the entire batch before a write, including duplicate account IDs.
      for (const id of ids) {
        const needed = data.filter(item => item.account_id === id).reduce((sum, item) => sum.plus(MathBN.convert(item.amount)), MathBN.convert(0));
        const stats = await this.retrieveAccountStats({ account_id: id }, shared);
        if (MathBN.convert(stats.balance).lt(needed)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Insufficient balance", "STORE_CREDIT_INSUFFICIENT_BALANCE");
      }
      // Native decorators preserve this exact transactionManager for read/insert/flush.
      return super.debitAccounts_(data, shared);
    });
  }

  // Generated Medusa CRUD is declared as callable instance properties. Binding
  // this overloaded helper preserves both native single/batch return signatures.
  override createStoreCreditAccounts = this.createAccounts.bind(this);

  private createAccounts(data: Partial<ModuleStoreCreditAccount>, context?: Context): Promise<ModuleStoreCreditAccount>;
  private createAccounts(data: Partial<ModuleStoreCreditAccount>[], context?: Context): Promise<ModuleStoreCreditAccount[]>;
  private async createAccounts(data: Partial<ModuleStoreCreditAccount> | Partial<ModuleStoreCreditAccount>[], context: Context = {}) {
    const accounts = Array.isArray(data) ? data : [data];
    if (!accounts.length || accounts.length > 100) invalidCreditInput();
    for (const account of accounts) {
      if (!account || Object.keys(account).some(key => !["customer_id", "currency_code", "metadata"].includes(key))) invalidCreditInput();
      exactIds([account.customer_id]);
      validateCurrency(account.currency_code);
    }
    return Array.isArray(data) ? super.createStoreCreditAccounts(data, context) : super.createStoreCreditAccounts(data, context);
  }

  // Reject all generated mutation bypasses, including account reassignment/cascades.
  override createAccountTransactions = async (..._args: unknown[]): Promise<never> => restrictedMutation();
  override updateAccountTransactions = async (..._args: unknown[]): Promise<never> => restrictedMutation();
  override deleteAccountTransactions = async (..._args: unknown[]): Promise<never> => restrictedMutation();
  override softDeleteAccountTransactions = async (..._args: unknown[]): Promise<never> => restrictedMutation();
  override restoreAccountTransactions = async (..._args: unknown[]): Promise<never> => restrictedMutation();
  override async updateStoreCreditAccounts(..._args: unknown[]): Promise<never> { return restrictedMutation(); }
  override async deleteStoreCreditAccounts(..._args: unknown[]): Promise<never> { return restrictedMutation(); }
  override async softDeleteStoreCreditAccounts(..._args: unknown[]): Promise<never> { return restrictedMutation(); }
  override restoreStoreCreditAccounts = async (..._args: unknown[]): Promise<never> => restrictedMutation();

  /** Native compensation contract: IDs come from its StepResponse, never an HTTP payload. */
  async deleteTransactions(transactionIds: string[], context: Context = {}): Promise<void> {
    const ids = exactIds(transactionIds);
    if (!ids.length) return;
    await this.transaction(context, async shared => {
      const runner = this.runner(shared);
      const before = await runner<TransactionRow>("store_credit_account_transaction").whereIn("id", ids);
      if (!before.length) return; // Exact replay after successful compensation.
      const accounts = exactIds(before.map(row => row.account_id));
      await this.lockAccounts(accounts, shared);
      const rows = await runner<TransactionRow>("store_credit_account_transaction").whereIn("id", ids);
      if (rows.some(row => !accounts.includes(row.account_id) || row.deleted_at || ["gospaza-financial-settlement","gospaza-checkout","gospaza-checkout-restoration"].includes(row.reference) || !["credit", "debit"].includes(row.type))) creditAttention();
      for (const accountId of accounts) {
        const credits = rows.filter(row => row.account_id === accountId && row.type === "credit");
        if (!credits.length) continue;
        const debit = await runner("store_credit_account_transaction").where({ account_id: accountId, type: "debit" }).first("id");
        const stats = await this.retrieveAccountStats({ account_id: accountId }, shared);
        const amount = credits.reduce((sum, row) => sum.plus(row.amount), MathBN.convert(0));
        if (!reversibleCredit(stats.balance, amount.toString(), !!debit)) creditAttention();
      }
      await super.deleteAccountTransactions(rows.map(row => row.id), shared);
    });
  }
}
