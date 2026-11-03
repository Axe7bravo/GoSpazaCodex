import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { minorPrice } from "./catalogue-policy";
import { resourceId } from "./team-policy";

export const financialConflict = () => new MedusaError(MedusaError.Types.CONFLICT, "Financial evidence requires review.", "FINANCIAL_EVIDENCE_CONFLICT");
export const financialReason = z.enum(["ITEM_OMITTED", "MERCHANT_REJECTED", "FULL_UNFULFILLABLE", "RESTRICTED_HANDOFF_FAILED", "GOODWILL"]);
export type FinancialReason = z.infer<typeof financialReason>;
export type FinancialCause = "MERCHANT" | "PLATFORM" | "CUSTOMER_RECIPIENT" | "POLICY";
export type SettlementMethod = "STORE_CREDIT" | "ORIGINAL_PAYMENT";
export type FinancialCapability = "VIEW" | "VIEW_DISPOSITION" | "APPROVE" | "GOODWILL_CREATE" | "EXECUTE_REFUND" | "ISSUE_STORE_CREDIT";
export function hasFinancialCapability(id:string, capability:FinancialCapability, env:NodeJS.ProcessEnv=process.env) {
  return !!id && (env["FINANCIAL_"+capability+"_USER_IDS"] ?? "").split(",").map(v=>v.trim()).filter(Boolean).includes(id);
}
export const approvalInput = z.object({ expected_revision: z.number().int().positive(), confirmed: z.literal(true) }).strict();
export const goodwillInput = z.object({ request_id: resourceId, amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.enum(["SERVICE_RECOVERY", "CUSTOMER_CARE"]), confirmed: z.literal(true) }).strict();
export const financialPage = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export function financialParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid financial request.");
  return result.data;
}
// Reuse the existing decimal-to-cents boundary; no floating-point multiplication.
export const financialMinor = minorPrice;
export function safeSum(values: number[]): number {
  let sum = 0n;
  for (const value of values) { if (!Number.isSafeInteger(value) || value < 0) throw financialConflict(); sum += BigInt(value); }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw financialConflict();
  return Number(sum);
}
// Stable unit ordinal: floor cents/quantity, first remainder ordinals get one cent.
// Picked units occupy [0,picked); omitted units occupy [picked,ordered).
export function unitShare(cents: number, quantity: number, start: number, end: number): number {
  if (![cents,quantity,start,end].every(Number.isSafeInteger) || cents < 0 || quantity <= 0 || start < 0 || end < start || end > quantity) throw financialConflict();
  const total = BigInt(cents), count = BigInt(quantity), a = BigInt(start), b = BigInt(end), remainder = total % count;
  return Number(total / count * (b-a) + (b < remainder ? b : remainder) - (a < remainder ? a : remainder));
}
export function settlementMethod(reason: FinancialReason, registered: boolean): SettlementMethod {
  if (reason === "GOODWILL" && !registered) throw financialConflict();
  return registered && (reason === "ITEM_OMITTED" || reason === "GOODWILL") ? "STORE_CREDIT" : "ORIGINAL_PAYMENT";
}
export function restrictedFinancialCause(reason: string | null): FinancialCause | null {
  if (["NO_ACCEPTABLE_ID","UNDER_MINIMUM_AGE","SCHOOL_GOING_LEARNER","SCHOOL_UNIFORM","APPARENT_INTOXICATION","RECIPIENT_REFUSED_VERIFICATION"].includes(reason ?? "")) return "CUSTOMER_RECIPIENT";
  // Address mismatch does not prove attribution; recovery ambiguity is not fault.
  return null;
}
export const adjustsDelivery = (cause: FinancialCause, reason: FinancialReason) => reason !== "ITEM_OMITTED" && reason !== "GOODWILL" && (cause === "MERCHANT" || cause === "PLATFORM");
export function goodwillLimit(paid: number, raw = process.env.FINANCIAL_GOODWILL_MAX_BPS): number {
  if (!raw || !/^\d+$/.test(raw)) throw financialConflict();
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000 || !Number.isSafeInteger(paid) || paid < 0) throw financialConflict();
  return Number(BigInt(paid) * BigInt(bps) / 10000n);
}
export interface FinancialAllocation { component: "MERCHANDISE" | "TAX" | "DELIVERY_FEE" | "GOODWILL"; economic_key: string; start_unit: number; end_unit: number; amount_minor: number }
export interface FinancialLine { id: string; quantity: number; net_minor: number; tax_minor: number }
export function lineAllocations(line: FinancialLine, start: number, end: number): FinancialAllocation[] {
  return ([["MERCHANDISE",line.net_minor],["TAX",line.tax_minor]] as const).map(([component,amount]) => ({ component, economic_key: line.id,
    start_unit: start, end_unit: end, amount_minor: unitShare(amount,line.quantity,start,end) }));
}
