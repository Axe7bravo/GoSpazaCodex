import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Order from "@medusajs/medusa/order";

export default defineLink(
  { linkable: Marketplace.linkable.orderOperation, field: "medusa_order_id" },
  Order.linkable.order,
  { readOnly: true },
);
