import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { restrictedParse } from "../../../../../modules/marketplace/restricted-policy";
import { RestrictedCommerce } from "../../../../../lib/restricted-commerce";
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.auth_context?.actor_type !== "user" || !req.auth_context.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  const query = restrictedParse(z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict(), req.query);
  res.json(await new RestrictedCommerce(req.scope).reviewQueue(req.auth_context.actor_id, query.offset));
}
