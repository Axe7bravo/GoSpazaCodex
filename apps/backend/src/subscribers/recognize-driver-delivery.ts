import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { DriverEarnings } from "../lib/driver-earning";
import { driverEarningEventOrder } from "../modules/marketplace/driver-earning-policy";

export default async function recognizeDriverDelivery({ event: { data }, container }: SubscriberArgs<unknown>) {
  const order = driverEarningEventOrder(data);
  if (order) await new DriverEarnings(container).recognize(order);
}
export const config: SubscriberConfig = { event: "gospaza.delivery-completed", context: { subscriberId: "driver-successful-delivery-earning" } };
