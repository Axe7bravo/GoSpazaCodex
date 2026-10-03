import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Native from "@medusajs/medusa/sales-channel";
export default defineLink(
  { linkable: Marketplace.linkable.merchant, field: "medusa_sales_channel_id" },
  Native.linkable.salesChannel,
  { readOnly: true },
);
