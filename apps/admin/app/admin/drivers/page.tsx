"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { DriverStatus } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback, DriverPages, driverLabel } from "@gospaza/ui/drivers";
import { driverClient, driverDenied } from "../../driver-client";
const statuses: DriverStatus[] = ["INCOMPLETE", "PENDING_REVIEW", "CHANGES_REQUIRED", "ACTIVE", "SUSPENDED", "DEACTIVATED"];
function Queue({ offset, status, change }: { offset: number; status?: DriverStatus; change: (offset: number) => void }) {
  const load = useCallback(() => driverClient.list(offset, status), [offset, status]);
  const resource = useDriverResource(load, driverDenied);
  return <>
    <button onClick={() => void resource.refresh()}>Refresh queue</button>
    <DriverFeedback error={resource.error} loading={!resource.data} />
    {resource.data && <>
      {!resource.data.items.length && <p>No drivers match this review queue.</p>}
      <ul className="driver-grid">{resource.data.items.map(profile => <li className="driver-card" key={profile.id}>
        <h2><Link href={"/admin/drivers/" + encodeURIComponent(profile.id)}>{profile.display_name || "Incomplete driver"}</Link></h2>
        <p>{driverLabel(profile.status)} · Revision {profile.revision}</p>
        <p>{profile.contact_phone}</p>
      </li>)}</ul>
      <DriverPages offset={offset} limit={20} more={offset + 20 < resource.data.count} change={change} />
    </>}
  </>;
}
export default function Drivers() {
  const [status, setStatus] = useState<DriverStatus | undefined>("PENDING_REVIEW");
  const [offset, setOffset] = useState(0);
  return <main className="driver-workspace"><p className="brand">GoSpaza</p><Link href="/">Admin home</Link><h1>Driver review</h1>
    <label>Profile status<select value={status ?? ""} onChange={e => { setStatus(statuses.find(s => s === e.target.value)); setOffset(0); }}>
      <option value="">All profiles</option>{statuses.map(s => <option key={s} value={s}>{driverLabel(s)}</option>)}
    </select></label>
    <Queue key={(status ?? "all") + offset} offset={offset} status={status} change={setOffset} />
  </main>;
}
