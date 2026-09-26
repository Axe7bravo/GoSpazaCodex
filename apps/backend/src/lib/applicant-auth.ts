import { MedusaError } from "@medusajs/framework/utils";
import { authenticate } from "@medusajs/framework/http";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction, AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { requireMerchantTenant } from "./merchant-tenancy";
const applicant = authenticate("merchant", ["session"], { allowUnregistered: true });
export function merchantBoundary(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  // An unprovisioned merchant identity is admitted ONLY to the application journey.
  const applicationRoute = /^\/merchant\/(?:applications(?:\/|$)|applicant\/me\/?$)/i.test(req.originalUrl.split("?")[0] ?? "");
  return applicant(req, res, (error?: unknown) => {
    if (error) { next(error); return; }
    if (applicationRoute) { next(); return; }
    return requireMerchantTenant(req, res, next);
  });
}
export function applicantIdentity(req: MedusaRequest): string {
  const context = (req as AuthenticatedMedusaRequest).auth_context;
  if (context?.actor_type !== "merchant" || !context.auth_identity_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Applicant authentication required.");
  return context.auth_identity_id;
}
