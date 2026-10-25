import { defineLink } from "@medusajs/framework/utils";
import Marketplace from "../modules/marketplace";
import Fulfillment from "@medusajs/medusa/fulfillment";
export default defineLink({ linkable: Marketplace.linkable.deliveryOperation, field: "native_fulfillment_id" }, Fulfillment.linkable.fulfillment, { readOnly: true });
