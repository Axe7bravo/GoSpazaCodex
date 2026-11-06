"use client";
import Link from "next/link";
import { createNotificationOperationsClient } from "@gospaza/api-client";
import { NotificationOperations } from "@gospaza/ui/notifications";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "../../auth-client";
const client = createNotificationOperationsClient(process.env.NEXT_PUBLIC_API_URL!);
export default function Notifications() {
  return <main className="application-layout"><SessionBoundary client={authClient} title="Platform notification operations">
    {identity => <><Link href="/">Admin home</Link><NotificationOperations key={"id" in identity ? identity.id : undefined} client={client} /></>}
  </SessionBoundary></main>;
}
