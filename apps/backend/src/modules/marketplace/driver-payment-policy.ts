import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";
import { payoutInstant, payoutTimeValid, transferIdentity } from "./merchant-payout-policy";

export const DRIVER_PAYMENT_POLICY = "M21_D_V1";
export const driverPaymentConflict = () => new MedusaError(MedusaError.Types.CONFLICT,
  "Driver payment evidence or availability changed.", "DRIVER_PAYMENT_CONFLICT");
export type DriverPaymentAction = "RECORD" | "UNKNOWN" | "CONFIRMED_PAID" | "CONFIRMED_NOT_PAID" | "RECONCILE" | "DISCREPANCY";
export function driverPaymentAllowed(actor: string, action: DriverPaymentAction | "VIEW" | "EVIDENCE", env: NodeJS.ProcessEnv = process.env) {
  const has = (grant: string) => !!actor && (env[grant + "_USER_IDS"] ?? "").split(",").map(x => x.trim()).includes(actor);
  if (action === "VIEW") return has("DRIVER_EARNINGS_VIEW");
  if (action === "EVIDENCE" || action === "DISCREPANCY") return has("DRIVER_PAYMENT_RECORD") || has("DRIVER_PAYMENT_RECONCILE");
  return has(action === "RECONCILE" ? "DRIVER_PAYMENT_RECONCILE" : "DRIVER_PAYMENT_RECORD");
}
const reference = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const decision = z.object({ request_id: resourceId, confirmed: z.literal(true), reason: z.string().trim().min(1).max(240) }).strict();
export const driverPaymentSelection = z.array(resourceId).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, "Whole earnings must be distinct.").transform(ids => [...ids].sort());
const facts = z.object({ earning_ids: driverPaymentSelection, amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("zar"), beneficiary_reference: reference, transferred_at: payoutInstant.transform(v => new Date(v).toISOString()),
  ...transferIdentity.shape }).strict();
export const recordDriverPayment = decision.extend({ ...facts.shape, evidence_reference: reference }).strict();
export const resolveDriverPayment = decision.extend({ review_reference: reference, evidence_reference: reference }).strict();
export const nonpaymentDriverPayment = resolveDriverPayment.extend({ nonreceipt_confirmed: z.literal(true),
  failure_category: z.enum(["BANK_REJECTED", "RETURNED_BEFORE_RECEIPT", "RAIL_CONFIRMED_FAILURE"]) }).strict();
export const reconcileDriverPayment = decision.extend({ ...facts.shape, driver_profile_id: resourceId, review_reference: reference }).strict();
export const driverPaymentDiscrepancy = decision.extend({ category: z.enum(["BENEFICIARY_MISMATCH", "AMOUNT_MISMATCH", "TRANSFER_DISPUTE",
  "DUPLICATE_EXTERNAL_RECORD", "RETURNED_TRANSFER", "RECONCILIATION_MISMATCH"]), evidence_reference: reference }).strict();
export const driverPaymentPage = z.object({ after: resourceId.optional(), limit: z.coerce.number().int().min(1).max(25).default(25) }).strict();
export interface PayableDriverEarning { id: string; driver_profile_id: string; payer: string; currency: string; amount_minor: string | number;
  economic_at: string | Date; recorded_at: string | Date }
export function driverPaymentTotal(rows: readonly PayableDriverEarning[]) {
  const first = rows[0];
  if (!first || new Set(rows.map(r => r.id)).size !== rows.length) throw driverPaymentConflict();
  let total = 0n;
  for (const row of rows) {
    if (row.driver_profile_id !== first.driver_profile_id || row.payer !== "GOSPAZA" || row.currency !== "zar"
      || !/^[1-9]\d*$/.test(String(row.amount_minor))) throw driverPaymentConflict();
    total += BigInt(row.amount_minor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw driverPaymentConflict();
  return Number(total);
}
export function driverPaymentEvidenceValid(rows: readonly PayableDriverEarning[], amount: number, currency: string, at: string, now: string | Date) {
  return driverPaymentTotal(rows) === amount && currency === "zar" && rows.every(row =>
    payoutTimeValid(at, row.economic_at, now) && payoutTimeValid(at, row.recorded_at, now));
}
export function driverPaymentCanReconcile(paid: boolean, discrepancy: boolean, earningAttention: boolean) {
  return paid && !discrepancy && !earningAttention;
}
