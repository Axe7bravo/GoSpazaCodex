import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";

export const restrictedId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true });
export const restriction = z.enum(["NONE", "ALCOHOL"]);
export const alcoholClass = z.enum(["WINE", "BEER", "SPIRITS", "OTHER"]);
export const registrationCategory = z.enum(["GROCER_WINE", "LIQUOR_STORE"]);
export const registrationStatus = z.enum(["PENDING_REVIEW", "CHANGES_REQUIRED", "ACTIVE", "SUSPENDED", "REVOKED"]);
const window = z.object({ day: z.number().int().min(0).max(6), start_minute: z.number().int().min(0).max(1439),
  end_minute: z.number().int().min(1).max(1440) }).strict().refine(w => w.start_minute < w.end_minute);
// Separate applicability: an unresolved stage is null, never an all-day grant.
export const tradingPolicy = z.object({ timezone: z.literal("Africa/Johannesburg"), source: text(500), version: text(100),
  permitted_alcohol_classes: z.array(alcoholClass).min(1).max(4),
  effective_from: instant, effective_until: instant.nullable(),
  regulatory_sale_windows: z.array(window).min(1).max(28), licence_sale_windows: z.array(window).min(1).max(28),
  store_sale_windows: z.array(window).min(1).max(28), dispatch_windows: z.array(window).min(1).max(28).nullable(),
  handoff_windows: z.array(window).min(1).max(28).nullable(),
}).strict().refine(p => !p.effective_until || Date.parse(p.effective_until) > Date.parse(p.effective_from));
export type TradingPolicy = z.infer<typeof tradingPolicy>;
export const registrationSubmission = z.object({ registration_number: text(100), category: registrationCategory,
  issuing_authority: text(200), valid_from: instant.nullable(), valid_until: instant.nullable(),
  evidence_ids: z.array(restrictedId).min(1).max(10),
}).strict().refine(r => !r.valid_from || !r.valid_until || Date.parse(r.valid_from) < Date.parse(r.valid_until));
export const registrationDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), confirmed: z.literal(true), reason: text(500),
    expected_revision: z.number().int().positive(), conditions_confirmed: z.literal(true),
    trading_policy: tradingPolicy }).strict(),
  z.object({ action: z.enum(["request-changes", "suspend", "reactivate", "revoke"]), confirmed: z.literal(true),
    reason: text(500), expected_revision: z.number().int().positive() }).strict(),
]);
export const classificationProposal = z.object({ restriction, alcohol_class: alcoholClass.nullable() }).strict()
  .refine(p => (p.restriction === "NONE") === (p.alcohol_class === null));
export const classificationDecision = z.object({ restriction, alcohol_class: alcoholClass.nullable(),
  confirmed: z.literal(true), reason: text(500), expected_identity: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  .refine(p => (p.restriction === "NONE") === (p.alcohol_class === null));
export function restrictedParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid restricted-commerce input.");
  return parsed.data;
}
export function restrictedBlocked(code: string): never { throw new MedusaError(MedusaError.Types.CONFLICT, code); }
export function categoryPermits(category: z.infer<typeof registrationCategory>, product: z.infer<typeof alcoholClass>): boolean {
  return category === "LIQUOR_STORE" || (category === "GROCER_WINE" && product === "WINE");
}
export function salePermitted(policy: TradingPolicy, now: Date): boolean {
  return supplyPermitted(policy, now, "sale");
}
export function supplyPermitted(policy: TradingPolicy, now: Date, stage: "sale" | "dispatch" | "handoff"): boolean {
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(policy.effective_from)
    || (policy.effective_until && now.getTime() >= Date.parse(policy.effective_until))) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: policy.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday") ?? "");
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const windows = stage === "sale" ? [policy.regulatory_sale_windows, policy.licence_sale_windows, policy.store_sale_windows]
    : [stage === "dispatch" ? policy.dispatch_windows : policy.handoff_windows];
  return day >= 0 && windows.every(list => list !== null && list.some(w => w.day === day && minute >= w.start_minute && minute < w.end_minute));
}

export const purchaserEvidence = z.object({ id: restrictedId, customer_id: restrictedId, method: text(100), method_version: text(100),
  policy_version: text(100), minimum_age: z.literal(18), provincial_requirements_satisfied: z.literal(true),
  state: z.enum(["UNVERIFIED", "PENDING", "VERIFIED", "EXPIRED", "REVOKED"]), verified_at: instant.nullable(), expires_at: instant.nullable(),
}).strict();
export type PurchaserEvidence = z.infer<typeof purchaserEvidence>;
export type PurchaserOutcome = { state: "VERIFIED"; evidence: PurchaserEvidence } | { state: "NOT_VERIFIED" | "EXPIRED" | "UNAVAILABLE" };
export interface PurchaserEligibilityProvider {
  evaluate(customerId: string, now: Date): Promise<PurchaserOutcome>;
}
// No environment switch, route or stored VERIFIED row can enable a nonexistent
// approved method. A future provider must be explicitly integrated and reviewed.
export const unavailablePurchaserProvider: PurchaserEligibilityProvider = {
  async evaluate() { return { state: "UNAVAILABLE" }; },
};
export function validatePurchaser(outcome: PurchaserOutcome, customer: string, now: Date): PurchaserEvidence {
  if (outcome.state !== "VERIFIED") return restrictedBlocked("PURCHASER_VERIFICATION_" + outcome.state);
  const evidence = restrictedParse(purchaserEvidence, outcome.evidence);
  if (evidence.customer_id !== customer || evidence.state !== "VERIFIED" || !evidence.verified_at
    || Date.parse(evidence.verified_at) > now.getTime()) return restrictedBlocked("PURCHASER_VERIFICATION_NOT_VERIFIED");
  if (evidence.expires_at && Date.parse(evidence.expires_at) <= now.getTime()) return restrictedBlocked("PURCHASER_VERIFICATION_EXPIRED");
  return evidence;
}
export const restrictedSnapshot = z.object({ version: z.literal(1), restricted_content_present: z.boolean(),
  classifications: z.array(z.object({ product_id: restrictedId, variant_id: restrictedId, revision_id: restrictedId,
    restriction, alcohol_class: alcoholClass.nullable() }).strict()
    .refine(c => (c.restriction === "NONE") === (c.alcohol_class === null))).min(1),
  registration_id: restrictedId.nullable(), registration_revision: z.number().int().positive().nullable(),
  trading_policy_version: text(100).nullable(), purchaser_evidence_id: restrictedId.nullable(),
}).strict().refine(s => s.restricted_content_present === s.classifications.some(c => c.restriction === "ALCOHOL"))
  .refine(s => !s.restricted_content_present || !!(s.registration_id && s.registration_revision && s.trading_policy_version && s.purchaser_evidence_id));
export type RestrictedSnapshot = z.infer<typeof restrictedSnapshot>;
export function restrictedDispatchBlock(snapshot: RestrictedSnapshot | undefined): string | null {
  if (!snapshot) return "DISPATCH_PRODUCT_EVIDENCE";
  return snapshot.restricted_content_present ? "RESTRICTED_DELIVERY_DOCUMENTATION_UNAVAILABLE" : null;
}
