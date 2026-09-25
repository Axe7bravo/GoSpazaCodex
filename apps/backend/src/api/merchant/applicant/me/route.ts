import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { applicantIdentity } from "../../../../lib/applicant-auth";
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  applicantIdentity(req);
  res.json({ applicant: true });
}
