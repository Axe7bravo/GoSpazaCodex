"use client";
import Link from "next/link";
import { use, useCallback } from "react";
import type { DriverProfileAction, DriverAffiliationAction } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverDecisionForm, DriverFeedback, DriverSummary } from "@gospaza/ui/drivers";
import { driverClient, driverDenied } from "../../../driver-client";
function Review({ id }: { id: string }) {
  const load = useCallback(() => driverClient.detail(id), [id]);
  const resource = useDriverResource(load, driverDenied);
  const account = resource.data;
  const actions: { value: DriverProfileAction; label: string }[] = [];
  const affiliations: { value: DriverAffiliationAction; label: string }[] = [];
  if (account) {
    const { profile, affiliation } = account;
    const activatable = affiliation && (affiliation.kind === "MERCHANT" ? affiliation.status === "ENDORSED" : affiliation.status === "REQUESTED");
    if (profile.status === "PENDING_REVIEW") {
      if (activatable) actions.push({ value: "approve", label: "Approve profile and activate affiliation" });
      actions.push({ value: "require-changes", label: "Require changes" });
    }
    if (profile.status === "ACTIVE") actions.push({ value: "suspend", label: "Suspend profile" });
    if (profile.status === "SUSPENDED" && affiliation?.status === "ACTIVE") actions.push({ value: "reactivate", label: "Reactivate profile" });
    if (["ACTIVE", "SUSPENDED", "CHANGES_REQUIRED"].includes(profile.status)) actions.push({ value: "deactivate", label: "Deactivate profile permanently" });
    if (profile.status !== "DEACTIVATED" && affiliation) {
      if (profile.status === "ACTIVE" && activatable) affiliations.push({ value: "activate", label: "Activate affiliation" });
      if (affiliation.status === "REQUESTED") affiliations.push({ value: "decline", label: "Decline affiliation" });
      affiliations.push({ value: "revoke", label: "Revoke affiliation" });
    }
  }
  return <main className="driver-workspace"><Link href="/admin/drivers">Driver review queue</Link><h1>Review driver</h1>
    <button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh driver</button>
    <DriverFeedback error={resource.error} notice={resource.notice} loading={!account} />
    {account && <>
      <h2>{account.profile.display_name || "Incomplete driver"}</h2><p>{account.profile.contact_phone}</p>
      <p>Profile revision: {account.profile.revision}</p>
      <DriverSummary account={account} />
      {account.affiliation?.merchant_store_id && <p>Merchant store reference: {account.affiliation.merchant_store_id}</p>}
      <section aria-label="Profile decisions"><h2>Profile decision</h2>
        <DriverDecisionForm key={account.profile.revision} revision={account.profile.revision} actions={actions} busy={resource.busy}
          decide={(action, input) => resource.mutate(async () => {
            const selected = actions.find(item => item.value === action);
            if (selected) await driverClient.decide(id, selected.value, input);
          })} />
      </section>
      <section aria-label="Affiliation decisions"><h2>Affiliation decision</h2>
        <DriverDecisionForm key={account.profile.revision} revision={account.profile.revision} actions={affiliations} busy={resource.busy}
          decide={(action, input) => resource.mutate(async () => {
            const selected = affiliations.find(item => item.value === action);
            if (selected && account.affiliation) await driverClient.affiliation(id, account.affiliation.id, selected.value, input);
          })} />
      </section>
    </>}
  </main>;
}
export default function Driver({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Review key={id} id={id} />;
}
