import { z } from "@medusajs/framework/zod";
import { financialConflict, safeSum } from "./financial-policy";
import { resourceId } from "./team-policy";

export const COMMISSION_POLICY = "M19_B_V1";
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const rate = z.number().int().min(0).max(10000);
export const commissionPublication = z.object({
  scope: z.enum(["PLATFORM", "MERCHANT"]),
  merchant_id: resourceId.optional(),
  decision: z.enum(["SET", "CLEAR"]),
  basis_points: rate.optional(),
  effective_at: z.string().datetime({ offset: true }).refine(value=>!/[.]\d{4}/.test(value), "Millisecond precision required.").optional(),
  expected_revision: z.number().int().min(0).max(2147483646),
  request_id: resourceId,
  reason: z.string().trim().min(1).max(240),
  confirmed: z.literal(true),
}).strict().superRefine((input, ctx) => {
  if ((input.scope === "MERCHANT") !== !!input.merchant_id
    || (input.decision === "SET") !== (input.basis_points !== undefined)
    || (input.scope === "PLATFORM" && input.decision === "CLEAR"))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid commission decision." });
});
export const commissionHistoryInput = z.object({
  merchant_id: resourceId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

export function commissionAt(basis: number, basisPoints: number): number {
  if (!cents.safeParse(basis).success || !rate.safeParse(basisPoints).success) throw financialConflict();
  return Number((BigInt(basis) * BigInt(basisPoints) + 5000n) / 10000n);
}
export function commissionDelta(previous: number, next: number, basisPoints: number) {
  return commissionAt(next, basisPoints) - commissionAt(previous, basisPoints);
}

export interface CommissionComponents {
  merchandise_net_minor: number;
  merchant_discount_minor: number;
  platform_subsidy_minor: number;
  merchandise_tax_minor: number;
  shipping_net_minor: number;
  shipping_tax_minor: number;
  external_minor: number;
  credit_minor: number;
}
export interface SponsorAllocation {
  source_id: string;
  sponsor: "MERCHANT"|"PLATFORM";
  net_minor: number;
  makes_merchant_whole: boolean;
}
// Only immutable owner-supplied merchandise allocations belong here. An
// adjustment code, today's Promotion or arbitrary native metadata is no proof.
export function discountAttribution(discount: number, allocations: readonly SponsorAllocation[]) {
  if (!cents.safeParse(discount).success) throw financialConflict();
  const ids = new Set(allocations.map(row=>row.source_id));
  if (ids.size !== allocations.length || ids.has("") || safeSum(allocations.map(row=>row.net_minor)) !== discount
    || allocations.some(row=>row.sponsor==="PLATFORM" && !row.makes_merchant_whole)) return null;
  return {
    merchant_discount_minor: safeSum(allocations.filter(row=>row.sponsor==="MERCHANT").map(row=>row.net_minor)),
    platform_subsidy_minor: safeSum(allocations.filter(row=>row.sponsor==="PLATFORM").map(row=>row.net_minor)),
  };
}
// Input is an internally established evidence projection, never an API payload.
// Merchandise net already includes the native discount. Do not subtract it twice.
export function commissionBasis(input: CommissionComponents) {
  if (!Object.values(input).every(value => cents.safeParse(value).success)) throw financialConflict();
  const customerValue = safeSum([input.merchandise_net_minor, input.merchandise_tax_minor,
    input.shipping_net_minor, input.shipping_tax_minor]);
  if (customerValue !== safeSum([input.external_minor, input.credit_minor])) throw financialConflict();
  return safeSum([input.merchandise_net_minor, input.platform_subsidy_minor]);
}
export function commissionCalculation(input: CommissionComponents, basisPoints: number) {
  const basis = commissionBasis(input);
  return { ...input, basis_minor: basis, commission_minor: commissionAt(basis, basisPoints) };
}

export function commissionConfigurationAllowed(actor: string, env: NodeJS.ProcessEnv = process.env) {
  return !!actor && (env.COMMISSION_CONFIGURE_USER_IDS ?? "").split(",").map(id => id.trim()).includes(actor);
}
