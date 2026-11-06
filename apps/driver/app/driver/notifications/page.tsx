"use client";
import Link from "next/link";
import { createNotificationClient } from "@gospaza/api-client";
import { NoticeInbox } from "@gospaza/ui/notifications";
import { SessionBoundary } from "@gospaza/ui/auth";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback } from "@gospaza/ui/drivers";
import { authClient, driverClient } from "../../auth-client";
const client = createNotificationClient(process.env.NEXT_PUBLIC_API_URL!, "driver");
const denied = () => window.location.replace("/login");
function DriverNotices() {
  const profile = useDriverResource(driverClient.restore, denied);
  return <><DriverFeedback loading={profile.data === undefined && !profile.error} error={profile.error} />
    {profile.data === null && <p>Your driver profile is unavailable. Open delivery work to review your account.</p>}
    {profile.data && <NoticeInbox key={profile.data.profile.id} client={client} surface="driver" />}</>;
}
export default function Notifications() {
  return <main className="driver-workspace driver-mobile"><SessionBoundary client={authClient} title="Driver notifications">
    {() => <><nav aria-label="Driver navigation"><Link href="/">Delivery work</Link><Link href="/driver/earnings">Earnings and payments</Link></nav>
      <DriverNotices /></>}
  </SessionBoundary></main>;
}
