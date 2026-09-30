import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";

export const cartHintInput = z.object({ cart_id: z.string().regex(/^cart_[a-zA-Z0-9_-]{1,100}$/).optional() }).strict();
export function assertCartRegion(region: { currency_code: string; countries?: { iso_2: string }[] } | null | undefined) {
  if (!region || region.currency_code !== "zar" || !region.countries?.some((country) => country.iso_2.toLowerCase() === "za")) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Configure the native Store default region for ZA and ZAR before creating carts.");
  }
}
