"use client";
import Link from "next/link";
import { use, useCallback } from "react";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverDecisionForm, DriverFeedback, driverLabel } from "@gospaza/ui/drivers";
import { useMerchant } from "../../shell";
import { driverClient } from "../../../driver-client";
function Detail({ id }: { id: string }) {
  const { tenant, refresh } = useMerchant();
  const denied = useCallback(() => { void refresh(); }, [refresh]);
  const load = useCallback(() => driverClient.detail(id), [id]);
  const resource = useDriverResource(load, denied);
  const item = resource.data?.item;
  const allowed = tenant.membership.capabilities.includes("MERCHANT_DRIVER_AFFILIATION_MANAGE");
  const labels = { endorse: "Endorse request", decline: "Decline request", revoke: "Revoke affiliation" };
  const actions = item && allowed ? item.available_actions.map(value => ({ value, label: labels[value] })) : [];
  return <div className="driver-workspace"><Link href="/merchant/drivers">All drivers</Link><h1>Driver affiliation</h1>
    <button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh driver</button>
    <DriverFeedback error={resource.error} notice={resource.notice} loading={!resource.data} />
    {item && <>
      <section className="driver-card"><h2>{item.display_name || "Driver request"}</h2>
        <p>Affiliation: {driverLabel(item.affiliation.status)}</p>
        <p>{item.persistently_eligible ? "Eligible for delivery work" : "Not eligible for delivery work"}</p>
        {item.contact_phone && <p>{item.contact_phone}</p>}
        <p>Endorsement is not platform approval. Revocation ends this store affiliation and does not create a platform affiliation.</p>
      </section>
      {allowed && <DriverDecisionForm key={item.profile_revision} actions={actions} revision={item.profile_revision} busy={resource.busy}
        decide={(action, input) => resource.mutate(async () => {
          if (action === "endorse" || action === "decline" || action === "revoke") await driverClient.decide(id, action, input);
        })} />}
    </>}
  </div>;
}
export default function Driver({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { tenant } = useMerchant();
  return tenant.membership.capabilities.includes("MERCHANT_DRIVER_VIEW")
    ? <Detail key={tenant.membership.id + ":" + id} id={id} /> : <h1>Driver access unavailable</h1>;
}
