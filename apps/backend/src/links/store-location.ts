import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Native from "@medusajs/medusa/stock-location";
export default defineLink(
  { linkable: Marketplace.linkable.merchantStore, field: "medusa_stock_location_id" },
  Native.linkable.stockLocation,
  { readOnly: true },
);
