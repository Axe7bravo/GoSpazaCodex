import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { MarketplaceRecognition } from "../lib/marketplace-recognition";
import { resourceId } from "../modules/marketplace/team-policy";

export default async function recognizeDeliveredOrder({event:{data},container}:SubscriberArgs<{order_id:string}>) {
  const order=resourceId.safeParse(data?.order_id);
  if(order.success) await new MarketplaceRecognition(container).recognize(order.data);
}
export const config:SubscriberConfig={event:"gospaza.delivery-completed",context:{subscriberId:"marketplace-earned-sale"}};
