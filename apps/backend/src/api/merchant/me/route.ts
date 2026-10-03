import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { merchantContext } from "../../../lib/merchant-tenancy";
import { requireCapability } from "../../../modules/marketplace/team-policy";
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  const context = merchantContext(req);
  requireCapability(context.membership.member_type, "MERCHANT_CONTEXT_VIEW");
  res.json(context);
}
