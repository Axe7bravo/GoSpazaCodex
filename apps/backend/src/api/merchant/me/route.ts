import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { merchantContext } from "../../../lib/merchant-tenancy";
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.json(merchantContext(req));
}
