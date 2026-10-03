import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Fulfillment from "@medusajs/medusa/fulfillment";

export default defineLink(
  { linkable: Marketplace.linkable.deliveryOptionConfiguration, field: "medusa_shipping_option_id" },
  Fulfillment.linkable.shippingOption,
  { readOnly: true },
);
