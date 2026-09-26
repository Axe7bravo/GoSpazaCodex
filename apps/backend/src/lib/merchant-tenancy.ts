import { MedusaError } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import type MarketplaceService from "../modules/marketplace/service";
import { applicantIdentity } from "./applicant-auth";
export type MerchantContext = Awaited<ReturnType<MarketplaceService["resolveTenant"]>>;
type TenantRequest = MedusaRequest & { merchantContext?: MerchantContext };
export async function requireMerchantTenant(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  try {
    (req as TenantRequest).merchantContext = await req.scope.resolve<MarketplaceService>("marketplace").resolveTenant(applicantIdentity(req));
    next();
  } catch (error) {
    if (error instanceof MedusaError && error.type === MedusaError.Types.UNAUTHORIZED) { res.status(401).json({ message: "Active merchant membership required." }); return; }
    next(error);
  }
}
export function merchantContext(req: MedusaRequest): MerchantContext {
  const context = (req as TenantRequest).merchantContext;
  if (!context) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant context required.");
  return context;
}
