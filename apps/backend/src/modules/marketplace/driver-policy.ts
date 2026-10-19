import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";
import type { DriverStatus, DriverAffiliationStatus, DriverAffiliationKind, MerchantDriverAction } from "@gospaza/contracts";

export const driverStatuses = ["INCOMPLETE", "PENDING_REVIEW", "CHANGES_REQUIRED", "ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;
export const affiliationStatuses = ["REQUESTED", "ENDORSED", "ACTIVE", "REJECTED", "REVOKED"] as const;
export const openAffiliations = ["REQUESTED", "ENDORSED", "ACTIVE"];
export const driverEmpty = z.object({}).strict();
export const driverPage = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();
export const driverReviewPage = driverPage.extend({ status: z.enum(driverStatuses).optional() }).strict();
const revision = z.number().int().min(1).max(2147483646);
export const driverRevision = z.object({ expected_revision: revision }).strict();
export const driverFields = z.object({ display_name: z.string().trim().min(1).max(120), contact_phone: z.string().trim().min(7).max(30).regex(/^\+?[0-9 ()-]+$/) }).strict();
export const driverEdit = driverFields.partial().extend({ expected_revision: revision }).strict().refine(v => v.display_name !== undefined || v.contact_phone !== undefined);
export const driverAffiliationRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PLATFORM"), expected_revision: revision }).strict(),
  z.object({ kind: z.literal("MERCHANT"), merchant_store_id: resourceId, expected_revision: revision }).strict(),
]);
export const driverDecision = z.object({ expected_revision: revision, confirmed: z.literal(true), reason: z.string().trim().min(1).max(500) }).strict();
export type DriverAction = "EDIT" | "SUBMIT" | "REQUEST" | "WITHDRAW" | "ENDORSE" | "DECLINE" | "REVOKE" | "APPROVE" | "REQUIRE_CHANGES" | "SUSPEND" | "REACTIVATE" | "DEACTIVATE" | "ACTIVATE";
export function driverParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid driver input.");
  return parsed.data;
}
export function driverConflict(): never { throw new MedusaError(MedusaError.Types.CONFLICT, "Driver state changed or is not eligible. Refresh before continuing.", "DRIVER_CONFLICT"); }
export function driverMissing(): never { throw new MedusaError(MedusaError.Types.NOT_FOUND, "Driver resource not found."); }
export type DriverCommandInput =
  | z.infer<typeof driverEdit>
  | z.infer<typeof driverAffiliationRequest>
  | z.infer<typeof driverRevision>
  | z.infer<typeof driverDecision>;

export function driverCommand(action: DriverAction, body: unknown): DriverCommandInput {
  if (action === "EDIT") return driverParse(driverEdit, body);
  if (action === "REQUEST") return driverParse(driverAffiliationRequest, body);
  if (action === "SUBMIT" || action === "WITHDRAW") return driverParse(driverRevision, body);
  return driverParse(driverDecision, body);
}
export function driverFingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function lifecycleTransition(status: DriverStatus, action: DriverAction): DriverStatus {
  if (action === "SUBMIT" && (status === "INCOMPLETE" || status === "CHANGES_REQUIRED")) return "PENDING_REVIEW";
  if (action === "APPROVE" && status === "PENDING_REVIEW") return "ACTIVE";
  if (action === "REQUIRE_CHANGES" && status === "PENDING_REVIEW") return "CHANGES_REQUIRED";
  if (action === "SUSPEND" && status === "ACTIVE") return "SUSPENDED";
  if (action === "REACTIVATE" && status === "SUSPENDED") return "ACTIVE";
  if (action === "DEACTIVATE" && ["ACTIVE", "SUSPENDED", "CHANGES_REQUIRED"].includes(status)) return "DEACTIVATED";
  return driverConflict();
}
export function driverApprovalEligibility(profile: { status: DriverStatus }, affiliation: { status: DriverAffiliationStatus } | null, nativeValid: boolean) {
  if (!nativeValid) return { eligible: false, reason: "IDENTITY_UNAVAILABLE" } as const;
  if (profile.status !== "ACTIVE") return { eligible: false, reason: "PROFILE_INACTIVE" } as const;
  if (!affiliation || affiliation.status !== "ACTIVE") return { eligible: false, reason: "AFFILIATION_INACTIVE" } as const;
  return { eligible: true, reason: "ELIGIBLE" } as const;
}
export function persistentEligibility(profile: { status: DriverStatus }, affiliation: { kind: DriverAffiliationKind; status: DriverAffiliationStatus; merchant_id: string | null; merchant_store_id: string | null } | null, target: { merchant_id: string; id: string } | null, nativeValid: boolean) {
  const approval = driverApprovalEligibility(profile, affiliation, nativeValid);
  if (!approval.eligible) return approval;
  if (!target) return { eligible: false, reason: "STORE_UNAVAILABLE" } as const;
  if (affiliation?.kind === "MERCHANT" && (affiliation.merchant_id !== target.merchant_id || affiliation.merchant_store_id !== target.id)) return { eligible: false, reason: "STORE_MISMATCH" } as const;
  return approval;
}

export function merchantDriverActions(profile: { status: DriverStatus }, affiliation: { kind: DriverAffiliationKind; status: DriverAffiliationStatus } | null | undefined): MerchantDriverAction[] {
  if (profile.status === "DEACTIVATED" || affiliation?.kind !== "MERCHANT") return [];
  if (affiliation.status === "REQUESTED") return profile.status === "SUSPENDED" ? ["decline"] : ["endorse", "decline"];
  return ["ENDORSED", "ACTIVE"].includes(affiliation.status) ? ["revoke"] : [];
}
