"use client";
import Link from "next/link";
import { createNotificationClient } from "@gospaza/api-client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { NoticeInbox } from "@gospaza/ui/notifications";
import { authClient } from "../auth-client";
const client = createNotificationClient(process.env.NEXT_PUBLIC_API_URL!, "customer", fetch, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
export default function Notifications() {
  return <main className="storefront"><SessionBoundary client={authClient} title="Your notifications">
    {(_identity, customer) => <><nav className="shop-nav" aria-label="Account navigation"><Link href="/account">Account</Link><Link href="/">Stores</Link></nav>
      <NoticeInbox key={customer?.id} client={client} surface="customer" /></>}
  </SessionBoundary></main>;
}
