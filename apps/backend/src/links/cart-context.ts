import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Cart from "@medusajs/medusa/cart";

export default defineLink(
  { linkable: Marketplace.linkable.cartMarketplaceContext, field: "medusa_cart_id" },
  Cart.linkable.cart,
  { readOnly: true },
);
