import { MathBN, MedusaError } from "@medusajs/framework/utils";
import type { ModuleCreditAccount } from "@medusajs/loyalty-plugin/types";
import { financialMinor } from "../marketplace/financial-policy";
import { YOCO_MINIMUM_MINOR } from "../yoco/validation";

export function applicableBalance(gross:number,balance:number) {
  if(!Number.isSafeInteger(gross) || !Number.isSafeInteger(balance) || gross<=0 || balance<0) invalidCreditInput();
  const applied=Math.min(gross,balance), external=gross-applied;
  if(!applied || external<YOCO_MINIMUM_MINOR) throw new MedusaError(MedusaError.Types.CONFLICT,
    "Balance cannot be applied to this checkout.", "STORE_CREDIT_EXTERNAL_PAYMENT_UNAVAILABLE");
  return applied;
}

export function invalidCreditInput(): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid Store Credit input.", "STORE_CREDIT_INVALID_INPUT");
}
export function restrictedMutation(): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Use the guarded Store Credit commands.", "STORE_CREDIT_MUTATION_RESTRICTED");
}
export function creditAttention(): never {
  throw new MedusaError(MedusaError.Types.CONFLICT, "Store Credit requires review; do not repeat issuance.", "STORE_CREDIT_ATTENTION_REQUIRED");
}
export function exactIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || Array.from(value).some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) invalidCreditInput();
  return [...new Set(value as string[])].sort();
}
export function validateCurrency(value: unknown): void {
  if (value !== "zar") invalidCreditInput();
}
export function mutationAccounts(data: ModuleCreditAccount[]): string[] {
  if (!Array.isArray(data) || data.length === 0 || data.length > 100) invalidCreditInput();
  for (const item of data) {
    if (!item || Object.keys(item).some(key => !["account_id", "amount", "reference", "reference_id", "note"].includes(key))) invalidCreditInput();
    if (typeof item.reference !== "string" || !item.reference.length || item.reference.length > 128 ||
        typeof item.reference_id !== "string" || !item.reference_id.length || item.reference_id.length > 128 ||
        (item.note !== undefined && (typeof item.note !== "string" || item.note.length > 500))) invalidCreditInput();
    // Native Medusa uses major units. Decimal arithmetic only, with cent precision.
    try {
      if (financialMinor(MathBN.convert(item.amount).toFixed()) <= 0) invalidCreditInput();
    } catch { invalidCreditInput(); }
  }
  return exactIds(data.map(item => item.account_id));
}
export function reversibleCredit(balance: string, removedCredits: string, hasDebitHistory: boolean): boolean {
  // Native history has no spend-allocation provenance. Replenishment cannot prove
  // an earlier credit unspent. Retain it when consumption is ambiguous.
  return !hasDebitHistory && MathBN.convert(balance).gte(removedCredits);
}
