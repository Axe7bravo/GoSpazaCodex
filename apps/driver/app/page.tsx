"use client";
import { useCallback, useId, useState } from "react";
import type { FormEvent } from "react";
import type { DriverAccountDTO, DriverAffiliationInput } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback, DriverPages, DriverSummary, driverLabel } from "@gospaza/ui/drivers";
import { authClient, driverClient } from "./auth-client";
const denied = () => window.location.replace("/login");
const historyLoad = () => driverClient.history();

function ProfileForm({ account, busy, save }: { account: DriverAccountDTO; busy: boolean; save: (fields: { display_name: string; contact_phone: string }) => Promise<void> }) {
  const [name, setName] = useState(account.profile.display_name);
  const [phone, setPhone] = useState(account.profile.contact_phone);
  return <form className="driver-card" onSubmit={e => { e.preventDefault(); void save({ display_name: name.trim(), contact_phone: phone.trim() }); }}>
    <fieldset disabled={busy}><legend>Profile details</legend>
      <label>Display name<input required maxLength={120} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Contact phone<input required type="tel" minLength={7} maxLength={30} autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
      <button type="submit">Save profile</button>
    </fieldset>
  </form>;
}
function StoreChoice({ choose, selected }: { choose: (id: string) => void; selected: string }) {
  const [offset, setOffset] = useState(0);
  return <StorePage key={offset} offset={offset} change={value => { choose(""); setOffset(value); }} choose={choose} selected={selected} />;
}
function StorePage({ offset, change, choose, selected }: { offset: number; change: (offset: number) => void; choose: (id: string) => void; selected: string }) {
  const storeId = useId();
  const load = useCallback(() => driverClient.targets(offset), [offset]);
  const resource = useDriverResource(load, denied);
  return <>
    <DriverFeedback error={resource.error} loading={!resource.data} />
    {resource.error && <button type="button" onClick={() => void resource.refresh()}>Retry stores</button>}
    {resource.data && <>
      {!resource.data.items.length ? <p>No stores accepting requests on this page.</p> : <><label htmlFor={storeId}>Merchant store</label><select id={storeId} required value={selected} onChange={e => choose(e.target.value)}>
        <option value="">Choose a store</option>{resource.data.items.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
      </select></>}
      <DriverPages offset={offset} limit={20} more={resource.data.items.length === 20} change={change} />
    </>}
  </>;
}
function AffiliationRequest({ revision, busy, request }: { revision: number; busy: boolean; request: (input: DriverAffiliationInput) => Promise<void> }) {
  const kindId = useId();
  const [kind, setKind] = useState<"PLATFORM" | "MERCHANT">("PLATFORM");
  const [store, setStore] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (kind === "MERCHANT" && !store)) return;
    await request(kind === "PLATFORM" ? { kind, expected_revision: revision } : { kind, expected_revision: revision, merchant_store_id: store });
  }
  return <form onSubmit={submit} className="driver-card"><fieldset disabled={busy}>
    <legend>Request an affiliation</legend>
    <label htmlFor={kindId}>Affiliation type</label><select id={kindId} value={kind} onChange={e => { setKind(e.target.value === "MERCHANT" ? "MERCHANT" : "PLATFORM"); setStore(""); }}>
      <option value="PLATFORM">Platform</option><option value="MERCHANT">Merchant</option>
    </select>
    {kind === "MERCHANT" && <StoreChoice choose={setStore} selected={store} />}
    <p>{kind === "MERCHANT" ? "The merchant must endorse your request before platform approval." : "The platform must approve your request. Requesting does not make you eligible."}</p>
    <button type="submit" disabled={kind === "MERCHANT" && !store}>Request affiliation</button>
  </fieldset></form>;
}
function HistoryPage({ offset, change }: { offset: number; change: (offset: number) => void }) {
  const load = useCallback(() => offset === 0 ? historyLoad() : driverClient.history(offset), [offset]);
  const resource = useDriverResource(load, denied);
  return <section aria-label="Affiliation history"><h2>Affiliation history</h2>
    <DriverFeedback error={resource.error} loading={!resource.data} />
    <button onClick={() => void resource.refresh()}>Refresh history</button>
    {resource.data && <>
      {!resource.data.items.length && <p>No affiliation requests yet.</p>}
      <ul>{resource.data.items.map(item => <li className="driver-card" key={item.id}>{driverLabel(item.kind)} · {driverLabel(item.status)}<p>Requested {new Date(item.created_at).toLocaleDateString("en-ZA")}</p></li>)}</ul>
      <DriverPages offset={offset} limit={20} more={offset + 20 < resource.data.count} change={change} />
    </>}
  </section>;
}
export default function Page() {
  const resource = useDriverResource(driverClient.restore, denied);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [withdraw, setWithdraw] = useState(false);
  const account = resource.data;
  const editable = account && ["INCOMPLETE", "CHANGES_REQUIRED"].includes(account.profile.status);
  return <main className="driver-workspace driver-mobile">
    <p className="brand">GoSpaza</p><h1>Driver portal</h1>
    <div className="driver-actions"><button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh profile</button>
      {account !== undefined && <button disabled={resource.busy} onClick={() => void resource.mutate(async () => { await authClient.logout(); denied(); })}>Sign out</button>}</div>
    <DriverFeedback error={resource.error} notice={resource.notice} loading={account === undefined} />
    {account === null && <section className="driver-card"><h2>Create your driver profile</h2>
      <p>This uses your signed-in GoSpaza identity. No new password is needed. Approval is required before delivery work.</p>
      <button disabled={resource.busy} onClick={() => void resource.mutate(driverClient.bootstrap)}>Create driver profile</button>
    </section>}
    {account && <>
      <h2>{account.profile.display_name || "Your driver profile"}</h2>
      <DriverSummary account={account} />
      {editable ? <ProfileForm key={"profile:" + account.profile.revision} account={account} busy={resource.busy}
        save={fields => resource.mutate(() => driverClient.update(account.profile.revision, fields))} />
        : <section className="driver-card"><h2>Profile details</h2><p>{account.profile.display_name}</p><p>{account.profile.contact_phone}</p><p>Profile details are read-only in this state.</p></section>}
      {!account.affiliation && ["INCOMPLETE", "CHANGES_REQUIRED", "ACTIVE"].includes(account.profile.status) &&
        <AffiliationRequest key={"affiliation:" + account.profile.revision} revision={account.profile.revision} busy={resource.busy} request={input => resource.mutate(() => driverClient.requestAffiliation(input))} />}
      {account.affiliation && account.profile.status !== "DEACTIVATED" && <section className="driver-card">
        <p>Only one affiliation can be open. Withdrawing closes it; it never converts to another affiliation.</p>
        <label className="driver-check"><input type="checkbox" checked={withdraw} disabled={resource.busy} onChange={e => setWithdraw(e.target.checked)} />Confirm withdrawal of current affiliation</label>
        <button disabled={resource.busy || !withdraw} onClick={() => {
          const affiliation = account.affiliation;
          if (affiliation) void resource.mutate(() => driverClient.withdraw(affiliation.id, account.profile.revision));
          setWithdraw(false);
        }}>Withdraw affiliation</button>
      </section>}
      {editable && <button disabled={resource.busy || !account.profile.display_name || !account.profile.contact_phone || !account.affiliation}
        onClick={() => void resource.mutate(() => driverClient.submit(account.profile.revision))}>
        {account.profile.status === "CHANGES_REQUIRED" ? "Resubmit for review" : "Submit for review"}</button>}
      <HistoryPage key={account.profile.revision + ":" + historyOffset} offset={historyOffset} change={setHistoryOffset} />
    </>}
  </main>;
}
