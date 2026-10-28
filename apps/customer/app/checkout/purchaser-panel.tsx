"use client";
import { createRestrictedCommerceClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
const client = createRestrictedCommerceClient(process.env.NEXT_PUBLIC_API_URL!, fetch, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const denied = () => window.location.replace("/login");
export default function PurchaserPanel() {
  const resource = useDriverResource(client.purchaser, denied);
  const state = resource.data?.state;
  return <section aria-label="Restricted purchases"><h3>Restricted purchases</h3>
    <p>Ordinary groceries do not require alcohol purchaser verification.</p>
    {state === "VERIFIED" ? <p>Purchaser verification confirmed. Store eligibility and permitted supply times are still checked at checkout.</p>
      : state === "EXPIRED" ? <p>Purchaser verification has expired. Restricted checkout is unavailable.</p>
      : state === "UNAVAILABLE" || resource.error ? <p>Purchaser verification is currently unavailable. Alcohol checkout cannot proceed.</p>
      : state ? <p>Purchaser verification is required before alcohol checkout.</p> : <p>Checking purchaser verification…</p>}
    <p>The person receiving restricted goods must be verified at the door, even if the purchaser was verified earlier.</p>
    <button onClick={() => void resource.refresh()}>Refresh purchaser status</button>
  </section>;
}
