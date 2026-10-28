import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { handoffRevision } from "./handoff-policy";

export const recipientPolicyVersion = "FS-RECIPIENT-1";
export const recipientDocument = z.enum(["IDENTITY_DOCUMENT", "DRIVERS_LICENCE", "PASSPORT"]);
export const recipientRole = z.enum(["PURCHASER", "ALTERNATE_ADULT"]);
export const recipientFailure = z.enum(["NO_ACCEPTABLE_ID", "UNDER_MINIMUM_AGE", "SCHOOL_GOING_LEARNER", "SCHOOL_UNIFORM",
  "APPARENT_INTOXICATION", "RECIPIENT_REFUSED_VERIFICATION", "DELIVERY_ADDRESS_MISMATCH", "COMPLIANCE_RECOVERY_REQUIRED"]);
export const recipientInput = handoffRevision.extend({ recipient_role: recipientRole,
  document_type: recipientDocument.nullable(), document_viewed: z.boolean(), date_of_birth: z.string().max(10).nullable(),
  school_uniform_observed: z.boolean(), recipient_declares_school_going_learner: z.boolean(),
  recipient_appears_intoxicated: z.boolean(), recipient_refused_verification: z.boolean(), invoice_address_matches: z.boolean(),
}).strict();
export type RecipientInput = z.infer<typeof recipientInput>;
export const recipientConflict = () => new MedusaError(MedusaError.Types.CONFLICT, "Restricted handoff requires attention. Refresh before continuing.", "RESTRICTED_HANDOFF_UNAVAILABLE");
export function ageThreshold(dob: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || !Number.isFinite(now.getTime())) throw recipientConflict();
  const born = new Date(dob + "T00:00:00Z");
  if (!Number.isFinite(born.getTime()) || born.toISOString().slice(0,10) !== dob) throw recipientConflict();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  const today = part("year") + "-" + part("month") + "-" + part("day");
  if (dob > today) throw recipientConflict();
  // A leap-day anniversary falls on 1 March in a non-leap year under this policy.
  const boundary = new Date(born); boundary.setUTCFullYear(born.getUTCFullYear()+18);
  const anniversary = boundary.toISOString().slice(0,10);
  return today >= anniversary;
}
export function evaluateRestrictedRecipientCompliance(input: RecipientInput, now: Date) {
  const age = input.date_of_birth === null ? false : ageThreshold(input.date_of_birth, now);
  const reason = input.recipient_refused_verification ? "RECIPIENT_REFUSED_VERIFICATION"
    : !input.invoice_address_matches ? "DELIVERY_ADDRESS_MISMATCH"
    : !input.document_viewed || !input.document_type || input.date_of_birth === null ? "NO_ACCEPTABLE_ID"
    : !age ? "UNDER_MINIMUM_AGE"
    : input.school_uniform_observed ? "SCHOOL_UNIFORM"
    : input.recipient_declares_school_going_learner ? "SCHOOL_GOING_LEARNER"
    : input.recipient_appears_intoxicated ? "APPARENT_INTOXICATION" : null;
  // Explicit projection: raw DOB is never part of durable evidence or a fingerprint.
  return { outcome: reason ? "FAILED" as const : "SATISFIED" as const, reason,
    evidence: { recipient_role: input.recipient_role, document_type: input.document_type, document_viewed: input.document_viewed,
      age_threshold_satisfied: age, school_uniform_observed: input.school_uniform_observed,
      recipient_declares_school_going_learner: input.recipient_declares_school_going_learner,
      recipient_appears_intoxicated: input.recipient_appears_intoxicated,
      recipient_refused_verification: input.recipient_refused_verification, invoice_address_matches: input.invoice_address_matches,
      policy_version: recipientPolicyVersion } };
}
export function deliveryDocumentPolicy() {
  const version = process.env.DELIVERY_DOCUMENT_POLICY_VERSION?.trim();
  return process.env.DELIVERY_DOCUMENT_POLICY_APPROVED === "true" && version && version.length <= 100 ? { version } : null;
}
