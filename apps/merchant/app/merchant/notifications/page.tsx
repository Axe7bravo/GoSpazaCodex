"use client";
import { createNotificationClient } from "@gospaza/api-client";
import { NoticeInbox } from "@gospaza/ui/notifications";
import { useMerchant } from "../shell";
const client = createNotificationClient(process.env.NEXT_PUBLIC_API_URL!, "merchant");
export default function Notifications() {
  const { tenant } = useMerchant();
  return <NoticeInbox key={tenant.membership.id + tenant.membership.member_type} client={client} surface="merchant" />;
}
