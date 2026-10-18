"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PickingLine, PickingOrder, MerchantMember, OrderShortages } from "@gospaza/contracts";
import { AuthError, PickingError } from "@gospaza/api-client";
import { pickingClient, pickingError, pickingLabels, assigneeLabel } from "../../picking-client";
import { merchantClient, merchantError } from "../../merchant-client";
import { useMerchant } from "../shell";

type Action = { kind: "claim" } | { kind: "line"; line: string; quantity: number; shortage: boolean }
  | { kind: "reassign"; member: string } | { kind: "complete" };
function LineEditor({ line, disabled, onEdit, onCancel, onSave }: {
  line: PickingLine; disabled: boolean; onEdit(): void; onCancel(): void; onSave(quantity: number, shortage: boolean): void;
}) {
  const [quantity, setQuantity] = useState(String(line.picked_quantity));
  const [shortage, setShortage] = useState(line.shortage_recorded);
  const [error, setError] = useState("");
  return <form noValidate onSubmit={(event) => {
    event.preventDefault();
    const value = Number(quantity);
    if (!/^[0-9]+$/.test(quantity) || !Number.isSafeInteger(value)) { setError("Enter a whole picked quantity of zero or more."); return; }
    if (!disabled) onSave(value, shortage);
  }}>
    <fieldset disabled={disabled}>
      <legend>Record original goods</legend>
      <label>Picked quantity for {line.title}<input type="number" inputMode="numeric" min="0" step="1" value={quantity}
        onChange={(event) => { setQuantity(event.target.value); setError(""); onEdit(); }} /></label>
      <label className="checkbox"><input type="checkbox" checked={shortage} onChange={(event) => { setShortage(event.target.checked); onEdit(); }} />Short or unavailable: {line.title}</label>
      <p>Save an absolute quantity. Clear the shortage marker when all original goods are found.</p>
      {error && <p role="alert">{error}</p>}
      <button type="submit">Save {line.title}</button>
      <button type="button" onClick={onCancel}>Discard changes for {line.title}</button>
    </fieldset>
  </form>;
}
function Detail({ id }: { id: string }) {
  const { tenant, refresh } = useMerchant();
  const self = tenant.membership.id;
  const mayPick = tenant.membership.capabilities.includes("MERCHANT_PICKING_PERFORM");
  const mayReassign = tenant.membership.capabilities.includes("MERCHANT_PICKING_REASSIGN");
  const [shortages, setShortages] = useState<OrderShortages | null>(null);
  const [order, setOrder] = useState<PickingOrder | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [epoch, setEpoch] = useState(0), [editing, setEditing] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"complete" | "reassign" | null>(null);
  const [members, setMembers] = useState<MerchantMember[] | null>(null), [target, setTarget] = useState("");
  const [teamError, setTeamError] = useState("");
  const actions = useRef<{ read(): void; write(action: Action): void; team(): void } | null>(null);
  useEffect(() => {
    let active = true, writing = false, generation = 0, teamGeneration = 0;
    let current: PickingOrder | null = null;
    const alive = (version: number) => active && version === generation;
    async function read() {
      const version = ++generation;
      try {
        const [response, shortageResponse] = await Promise.all([pickingClient.detail(id), pickingClient.shortages(id)]);
        if (!alive(version)) return;
        current = response.picking; setOrder(current); setShortages(shortageResponse); setError("");
        setEpoch((value) => value + 1); setEditing(null); setConfirmation(null);
        ++teamGeneration; setMembers(null); setTarget("");
      } catch (cause) {
        if (!alive(version)) return;
        current = null; setOrder(null); setShortages(null); setConfirmation(null); setError(pickingError(cause));
        if (cause instanceof PickingError && [401, 403].includes(cause.status)) void refresh();
      } finally { if (alive(version)) setLoading(false); }
    }
    async function write(action: Action) {
      const snapshot = current;
      if (!active || writing || !snapshot) return;
      const assigned = snapshot.assigned_member_id === self && mayPick;
      if (action.kind === "claim" ? !mayPick || snapshot.status !== "NOT_STARTED"
        : snapshot.status !== "IN_PROGRESS" || (action.kind === "reassign" ? !mayReassign : !assigned)) return;
      writing = true; const version = ++generation;
      setBusy(true); setNotice(""); setError(""); ++teamGeneration;
      try {
        if (action.kind === "claim") await pickingClient.claim(id);
        else if (action.kind === "line") await pickingClient.updateLine(id, action.line, {
          expected_revision: snapshot.revision, picked_quantity: action.quantity, shortage_recorded: action.shortage,
        });
        else if (action.kind === "reassign") await pickingClient.reassign(id, { expected_revision: snapshot.revision, target_member_id: action.member });
        else await pickingClient.complete(id, { expected_revision: snapshot.revision, confirmed: true });
        if (!alive(version)) return;
        setNotice("Picking saved. Showing the latest state.");
      } catch (cause) {
        if (!alive(version)) return;
        setNotice(pickingError(cause));
        if (cause instanceof PickingError && [401, 403].includes(cause.status)) void refresh();
      } finally {
        if (active) {
          current = null; setOrder(null); setShortages(null); setConfirmation(null); setLoading(true);
          await read(); // Read only after success, conflict or uncertainty. Never replay a write.
          writing = false; if (active) setBusy(false);
        }
      }
    }
    async function team() {
      if (!active || writing || !mayReassign || current?.status !== "IN_PROGRESS") return;
      const version = ++teamGeneration;
      setConfirmation("reassign"); setMembers(null); setTeamError(""); setTarget("");
      try {
        const response = await merchantClient.members();
        if (active && version === teamGeneration) setMembers(response.members.filter((member) => member.status === "ACTIVE"));
      } catch (cause) {
        if (!active || version !== teamGeneration) return;
        setTeamError(merchantError(cause));
        if (cause instanceof AuthError && [401, 403].includes(cause.status ?? 0)) void refresh();
      }
    }
    const reload = () => { if (active && !writing) { current = null; setLoading(true); setConfirmation(null); void read(); } };
    actions.current = { read: reload, write: (action) => { void write(action); }, team: () => { void team(); } };
    const foreground = () => { if (document.visibilityState === "visible") reload(); };
    void read();
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
    return () => { active = false; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [id, self, mayPick, mayReassign, refresh]);
  const disabled = loading || busy || !!error;
  const assigned = order?.status === "IN_PROGRESS" && order.assigned_member_id === self && mayPick;
  const ready = !!shortages && !!order?.lines.length && order.lines.every((line) => {
    const omitted = line.omitted_quantity ?? 0;
    const resolution = shortages.shortages.find((item) => item.line_id === line.id);
    return line.picked_quantity + omitted === line.ordered_quantity && line.unresolved_quantity === 0
      && (omitted > 0 ? resolution?.status === "RESOLVED_OMITTED"
        && resolution.picked_quantity === line.picked_quantity && resolution.omitted_quantity === omitted
        : !line.shortage_recorded && resolution?.status !== "CUSTOMER_DECISION_REQUIRED");
  });
  return <div className="application-content picking-page" aria-busy={loading || busy}>
    <Link href="/merchant/picking">All picking orders</Link>
    <h1>{order ? "Pick order #" + order.display_id : "Picking details"}</h1>
    <button disabled={busy} onClick={() => actions.current?.read()}>Refresh picking</button>
    {loading && <p role="status">Loading picking…</p>}
    {busy && <p role="status">Saving picking…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {order && <>
      <h2>{pickingLabels[order.status]}</h2>
      <p>Assignee: {assigneeLabel(order.assigned_member_id, self)}</p>
      {shortages && <p>Customer preference: {shortages.preference.preference === "CONTACT_ME" ? "Ask before leaving unavailable items out" : "Leave unavailable items out"}{!shortages.preference.chosen_at ? " (default, not explicitly selected)" : ""}.</p>}
      {order.status === "COMPLETED" && <p>Picking is complete. No further picking changes are available.</p>}
      {order.status === "IN_PROGRESS" && !assigned && <p>This pick is read-only for you. Only the assigned employee may record goods.</p>}
      {order.status === "NOT_STARTED" && mayPick && <button className="picking-primary" disabled={disabled} onClick={() => actions.current?.write({ kind: "claim" })}>Claim picking</button>}
      <div className="picking-lines">{order.lines.map((line) => <article className="picking-card" key={line.id} aria-label={line.title}>
        <h3>{line.title}</h3><p>{line.variant_title}{line.sku ? " · " + line.sku : ""}</p>
        <dl className="picking-counts"><div><dt>Ordered</dt><dd>{line.ordered_quantity}</dd></div><div><dt>Picked</dt><dd>{line.picked_quantity}</dd></div><div><dt>Omitted</dt><dd>{line.omitted_quantity ?? 0}</dd></div><div><dt>Unresolved</dt><dd>{line.unresolved_quantity}</dd></div></dl>
        <p>Shortage: {(line.omitted_quantity ?? 0) > 0 ? "Resolved by omission" : line.shortage_recorded ? "Yes — original goods still needed" : "No"}</p>
        {shortages?.shortages.find((item) => item.line_id === line.id)?.status === "CUSTOMER_DECISION_REQUIRED" && <p>Waiting for the customer’s decision. Continue picking other lines.</p>}
        {(line.omitted_quantity ?? 0) > 0 && <p>This quantity will not be supplied. Any payment adjustment has not yet been processed. This line can no longer be edited.</p>}
        {assigned && (line.omitted_quantity ?? 0) === 0 && shortages?.shortages.find((item) => item.line_id === line.id)?.status !== "RESOLVED_OMITTED" && <LineEditor key={line.id + ":" + epoch} line={line} disabled={disabled || (editing !== null && editing !== line.id)}
          onEdit={() => setEditing(line.id)} onCancel={() => { setEditing(null); setEpoch((value) => value + 1); }}
          onSave={(quantity, shortage) => actions.current?.write({ kind: "line", line: line.id, quantity, shortage })} />}
      </article>)}</div>
      {assigned && <section aria-label="Complete picking">
        <p>{ready ? "All quantities are physically picked or resolved by omission. Ready to complete picking." : "Completion is blocked until every quantity is physically picked or resolved by omission."}</p>
        {editing && <p>Save or discard your line changes before completing or reassigning.</p>}
        {confirmation === "complete" ? <>
          <p>Complete this pick? Picking cannot be reopened.</p>
          <button className="picking-primary" disabled={disabled || !ready || !!editing} onClick={() => actions.current?.write({ kind: "complete" })}>Confirm completion</button>
          <button disabled={busy} onClick={() => setConfirmation(null)}>Keep picking</button>
        </> : <button className="picking-primary" disabled={disabled || !ready || !!editing} onClick={() => setConfirmation("complete")}>Complete picking</button>}
      </section>}
      {mayReassign && order.status === "IN_PROGRESS" && <section aria-label="Reassign picking">
        <button disabled={disabled || !!editing} onClick={() => actions.current?.team()}>Reassign picking</button>
        {confirmation === "reassign" && <form onSubmit={(event) => { event.preventDefault(); if (!disabled && target) actions.current?.write({ kind: "reassign", member: target }); }}>
          <p>Change the active assignee only. Recorded quantities and shortages stay unchanged.</p>
          {teamError && <p role="alert">{teamError}</p>}
          {!members && !teamError && <p role="status">Loading eligible team members…</p>}
          {members && <><label>New assignee<select value={target} disabled={disabled} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose an active employee</option>
            {members.filter((member) => member.id !== order.assigned_member_id).map((member) => <option key={member.id} value={member.id}>{member.role} · {assigneeLabel(member.id, self)}</option>)}
          </select></label><button type="submit" disabled={disabled || !target}>Confirm reassignment</button></>}
          <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Keep current assignee</button>
        </form>}
      </section>}
    </>}
  </div>;
}
export default function PickingDetail({ id }: { id: string }) {
  const { tenant } = useMerchant();
  return tenant.membership.capabilities.includes("MERCHANT_PICKING_VIEW") ? <Detail key={tenant.membership.id} id={id} /> : <h1>Picking access unavailable</h1>;
}
