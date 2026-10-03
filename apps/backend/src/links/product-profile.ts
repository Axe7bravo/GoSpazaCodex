import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Native from "@medusajs/medusa/product";
export default defineLink(
  { linkable: Marketplace.linkable.productMarketplaceProfile, field: "medusa_product_id" },
  Native.linkable.product,
  { readOnly: true },
);
