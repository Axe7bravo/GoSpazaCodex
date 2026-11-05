import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";

export const COMPENSATION_POLICY = "M21_B_V1";
export const COMPENSATION_LOCK = 21021001;
const decision = z.object({ request_id: resourceId, expected_revision: z.number().int().min(0).max(2147483646),
  reason: z.string().trim().min(1).max(240), confirmed: z.literal(true),
  effective_at: z.string().datetime({ offset: true }).refine(v => !/[.]\d{4}/.test(v), "Millisecond precision required.").optional() });
// Zero-rate enablement is not approved. There are no caller-selectable payer,
// affiliation, merchant, zone or pricing-method fields.
export const compensationPublication = decision.extend({ amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal("zar") }).strict();
export const compensationActivation = decision.strict();
export const compensationPage = z.object({ after: resourceId.optional(), limit: z.coerce.number().int().min(1).max(25).default(20) }).strict();
export type CompensationState = "RESOLVED_GOSPAZA_PAYABLE" | "RESOLVED_NON_GOSPAZA_PAYABLE" | "MISSING_COMPENSATION_TERMS" | "HISTORICAL_PREACTIVATION";
export function compensationAllowed(actor: string, write = false, env: NodeJS.ProcessEnv = process.env) {
  const granted = (name: string) => !!actor && (env[name] ?? "").split(",").map(v => v.trim()).includes(actor);
  return granted("DRIVER_COMPENSATION_MANAGE_USER_IDS") || !write && granted("DRIVER_EARNINGS_VIEW_USER_IDS");
}
export function compensationConflict() {
  return new MedusaError(MedusaError.Types.CONFLICT, "Compensation decision changed or is unavailable.", "DRIVER_COMPENSATION_CONFLICT");
}
// PostgreSQL owns exact timestamp selection; this owns the resulting classification.
export function compensationState(path: "MERCHANT" | "PLATFORM", activated: boolean, hasTerms: boolean): CompensationState {
  if (!activated) return "HISTORICAL_PREACTIVATION";
  if (path === "MERCHANT") return "RESOLVED_NON_GOSPAZA_PAYABLE";
  return hasTerms ? "RESOLVED_GOSPAZA_PAYABLE" : "MISSING_COMPENSATION_TERMS";
}
