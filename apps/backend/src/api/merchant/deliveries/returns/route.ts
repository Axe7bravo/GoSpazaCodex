import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "@medusajs/framework/zod";
import { restrictedParse } from "../../../../modules/marketplace/restricted-policy";
import { applicantIdentity } from "../../../../lib/applicant-auth";
import { RecipientService } from "../../../../lib/recipient-service";
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const query = restrictedParse(z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict(), req.query);
  res.json(await new RecipientService(req.scope).merchantQueue(applicantIdentity(req), query.offset));
}
