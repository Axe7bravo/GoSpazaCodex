"use client";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { DriverAccountDTO, DriverReviewInput } from "@gospaza/contracts";

export function driverLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
export function DriverSummary({ account }: { account: DriverAccountDTO }) {
  return <section aria-label="Driver status" className="driver-card">
    <dl>
      <dt>Profile</dt><dd>{driverLabel(account.profile.status)}</dd>
      <dt>Affiliation</dt><dd>{account.affiliation
        ? driverLabel(account.affiliation.kind) + " / " + driverLabel(account.affiliation.status)
        : "No open affiliation"}</dd>
      <dt>Eligibility</dt><dd>{account.eligibility.eligible ? "Eligible for delivery work" : "Not eligible for delivery work"}</dd>
    </dl>
    <p>Approval is not online availability. Store and delivery requirements are checked separately.</p>
    {account.affiliation?.status === "REQUESTED" && <p>{account.affiliation.kind === "MERCHANT"
      ? "Awaiting merchant endorsement, then platform approval." : "Awaiting platform approval. A request does not grant eligibility."}</p>}
    {account.affiliation?.status === "ENDORSED" && <p>Merchant endorsed. Awaiting platform approval.</p>}
    {account.profile.status === "CHANGES_REQUIRED" && <p>Your profile needs corrections. Review your name and contact number before resubmitting.</p>}
    {account.profile.status === "SUSPENDED" && <p>Your profile is suspended. You are not eligible for delivery work.</p>}
    {account.profile.status === "DEACTIVATED" && <p>This profile is deactivated and cannot be reopened here.</p>}
  </section>;
}
export function DriverFeedback({ error, notice, loading }: { error: string; notice?: string; loading: boolean }) {
  return <>{error && <p role="alert" className="auth-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && !error && <p role="status">Loading driver information…</p>}</>;
}
export function DriverPages({ offset, limit, more, change }: { offset: number; limit: number; more: boolean; change: (offset: number) => void }) {
  return <nav aria-label="Driver pages" className="driver-actions">
    <button type="button" disabled={offset === 0} onClick={() => change(Math.max(0, offset - limit))}>Previous</button>
    <span>Page {Math.floor(offset / limit) + 1}</span>
    <button type="button" disabled={!more || offset + limit > 10000} onClick={() => change(offset + limit)}>Next</button>
  </nav>;
}
export function DriverDecisionForm({ actions, revision, busy, decide }: {
  actions: { value: string; label: string }[]; revision: number; busy: boolean;
  decide: (action: string, input: DriverReviewInput) => Promise<void>;
}) {
  const actionId = useId();
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || !confirmed || !reason.trim() || busy) return;
    await decide(action, { expected_revision: revision, confirmed: true, reason: reason.trim() });
  }
  if (!actions.length) return <p>No decision is currently permitted.</p>;
  return <form onSubmit={submit} className="driver-card">
    <fieldset disabled={busy}>
      <legend>Record a decision</legend>
      <label htmlFor={actionId}>Action</label><select id={actionId} required value={action} onChange={e => { setAction(e.target.value); setConfirmed(false); }}>
        <option value="">Choose an action</option>{actions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <label>Reason<textarea required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label className="driver-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I confirm this decision</label>
      <button type="submit" disabled={!action || !reason.trim() || !confirmed}>{busy ? "Saving…" : "Confirm decision"}</button>
    </fieldset>
  </form>;
}
