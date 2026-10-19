"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback, DriverPages, driverLabel } from "@gospaza/ui/drivers";
import { useMerchant } from "../shell";
import { driverClient } from "../../driver-client";
function RosterPage({ offset, change }: { offset: number; change: (offset: number) => void }) {
  const { refresh } = useMerchant();
  const denied = useCallback(() => { void refresh(); }, [refresh]);
  const load = useCallback(() => driverClient.list(offset), [offset]);
  const resource = useDriverResource(load, denied);
  return <>
    <button onClick={() => void resource.refresh()}>Refresh drivers</button>
    <DriverFeedback error={resource.error} loading={!resource.data} />
    {resource.data && <>
      {!resource.data.items.length && <p>No open driver affiliations for this store.</p>}
      <ul className="driver-grid">{resource.data.items.map(item => <li className="driver-card" key={item.affiliation.id}>
        <h2><Link href={"/merchant/drivers/" + encodeURIComponent(item.affiliation.id)}>{item.display_name || "Driver request"}</Link></h2>
        <p>Affiliation: {driverLabel(item.affiliation.status)}</p>
        <p>{item.persistently_eligible ? "Eligible for delivery work" : "Not eligible for delivery work"}</p>
        {item.contact_phone && <p>{item.contact_phone}</p>}
      </li>)}</ul>
      <DriverPages offset={offset} limit={20} more={offset + 20 < resource.data.count} change={change} />
    </>}
  </>;
}
export default function Drivers() {
  const { tenant } = useMerchant();
  const [offset, setOffset] = useState(0);
  if (!tenant.membership.capabilities.includes("MERCHANT_DRIVER_VIEW")) return <h1>Driver access unavailable</h1>;
  return <div className="driver-workspace"><h1>Drivers</h1><p>Requests and current affiliations for your store. Endorsement still requires platform approval.</p>
    <RosterPage key={tenant.membership.id + ":" + offset} offset={offset} change={setOffset} />
  </div>;
}
