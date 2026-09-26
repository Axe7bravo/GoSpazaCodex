import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
export const reviewActions = ["start-review", "request-information", "reject", "approve"] as const;
export type ReviewAction = typeof reviewActions[number];
export const emptyReviewInput = z.object({}).strict();
export const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
export const approvalInput = z.object({ confirmed: z.literal(true), reason: z.string().trim().min(1).max(2000) }).strict();
export function editableApplication(status: string) { return status === "DRAFT" || status === "MORE_INFORMATION_REQUIRED"; }
export function reviewTransition(status: string, action: ReviewAction) {
  const from = action === "start-review" ? "SUBMITTED" : "UNDER_REVIEW";
  if (status !== from) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Application state changed or this review action is not allowed. Refresh before retrying.");
  return { "start-review": "UNDER_REVIEW", "request-information": "MORE_INFORMATION_REQUIRED", reject: "REJECTED", approve: "APPROVED" }[action];
}
