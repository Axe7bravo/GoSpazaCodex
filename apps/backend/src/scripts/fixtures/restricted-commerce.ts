import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { nativeProducts } from "../../lib/catalogue-native";
import { productRestrictionIdentity } from "../../lib/restricted-commerce";

// Explicit fixture approval, never imported by a route, service or loader.
// IDs are supplied by the verifier which created the isolated catalogue.
export async function reviewFixtureGrocery(container: MedusaContainer, productId: string) {
  if (!["test","development"].includes(process.env.APP_ENV ?? "")) throw new Error("Fixture review is local-only.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const profile = await db<{ id: string; requires_age_verification: boolean }>("product_marketplace_profile")
    .where({ medusa_product_id: productId }).first();
  const [product] = await nativeProducts(container,[productId]);
  if (!profile || !product || profile.requires_age_verification) throw new Error("Expected explicit unrestricted fixture.");
  await db("restriction_review").insert({ id: "rrev_"+randomUUID(), product_profile_id: profile.id, revision: 1,
    identity_fingerprint: productRestrictionIdentity(product,false), restriction: "NONE", alcohol_class: null,
    reviewer_id: "local-fixture", reason: "Explicit isolated grocery test fixture" });
}
