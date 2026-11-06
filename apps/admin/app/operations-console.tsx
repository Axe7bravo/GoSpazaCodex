"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AuthError, createOperationsClient } from "@gospaza/api-client";
import { operationsLookupTypes } from "@gospaza/contracts";
import type { DeliveryDiagnostic, DeliveryRescueCommand, OperationsLookupType, OperationsSource, OperationsTimelineSource } from "@gospaza/contracts";
import { SessionBoundary } from "@gospaza/ui/auth";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { authClient } from "./auth-client";
import { AttentionTable, DeliveryView, ExactLookupForm, HealthView, OrderView, OverviewView, RescueReview, TimelineView } from "./operations-presentation";
import { rescueAndRefresh } from "./operations-rescue";
const client = createOperationsClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
function Feedback({ error, loaded, refresh }: { error: string; loaded: boolean; refresh: () => void }) {
  return <>{error ? <p role="alert">Operational information is unavailable or access is not permitted.</p> : !loaded && <p role="status">Loading operational information…</p>}<button onClick={refresh}>Refresh authoritative state</button></>;
}
function Lookup() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.lookup>>>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), type = String(form.get("type")), id = String(form.get("id") ?? "").trim();
    if (!operationsLookupTypes.includes(type as OperationsLookupType) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) { setError("Choose a record type and exact ID."); return; }
    setBusy(true); setError(""); setResult(undefined);
    try { setResult(await client.lookup(type as OperationsLookupType, id)); }
    catch (cause) { setError(cause instanceof AuthError ? cause.message : "Operational lookup unavailable."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Exact-ID lookup"><h2>Exact-ID lookup</h2><ExactLookupForm busy={busy} submit={submit}/>
    {error && <p role="alert">{error}</p>}{result && <p>{result.type} · {result.reference} · {result.status} {result.link && <Link href={result.link}>Open context</Link>}</p>}</section>;
}
function Timeline({ id, kind }: { id: string; kind: "order" | "delivery" }) {
  const [source, setSource] = useState<OperationsTimelineSource>(), [cursor, setCursor] = useState<string>();
  const load = useCallback(() => kind === "order" ? client.orderTimeline(id, source, cursor) : client.deliveryTimeline(id, source, cursor), [id, kind, source, cursor]);
  const r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <><TimelineView data={r.data}/>
    <button disabled={!cursor && !source} onClick={() => { setSource(undefined); setCursor(undefined); }}>First source pages</button>
    {r.data.pages.filter(page => page.next_cursor).map(page => <button key={page.source} onClick={() => { setSource(page.source); setCursor(page.next_cursor ?? undefined); }}>Next {page.source} events</button>)}</>}</>;
}
function RescueAction({ data, refresh }: { data?: DeliveryDiagnostic; refresh: () => Promise<boolean> }) {
  const [draft, setDraft] = useState<DeliveryRescueCommand>(), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [notice, setNotice] = useState("");
  const writing = useRef(false);
  async function execute() {
    if (!draft || writing.current || !data) return;
    writing.current = true; setBusy(true); setNotice("");
    try {
      const outcome = await rescueAndRefresh(() => client.rescue(data.id, draft), refresh);
      if (outcome === "UNCERTAIN") { setUncertain(true); setNotice("The result is unconfirmed. Check the original request; do not start another rescue."); }
      else {
        setDraft(undefined); setUncertain(false);
        setNotice(outcome === "RECORDED" ? "Search reopening recorded. Showing current authoritative dispatch state."
          : outcome === "CONFLICT" ? "Delivery state changed. Rescue is no longer available for that search. Review the latest state." : "Rescue unavailable or access is no longer permitted.");
      }
    } finally { writing.current = false; setBusy(false); }
  }
  return <section aria-label="Controlled dispatch rescue">{notice && <p role="status">{notice}</p>}
    {draft ? <>{data && <RescueReview data={data} command={draft}/>}<button disabled={busy || !data} onClick={() => void execute()}>{uncertain ? "Check original rescue request" : "Confirm search reopening"}</button>
      {!uncertain && <button disabled={busy} onClick={() => setDraft(undefined)}>Back</button>}</>
      : data?.can_rescue && data.rescue.eligible && <form onSubmit={event => {
        event.preventDefault(); setNotice(""); setDraft({ request_id: crypto.randomUUID(), expected_revision: data.revision, expected_generation: data.generation,
          expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true });
      }}><label htmlFor="rescue-reason">Operational reason</label><select id="rescue-reason" name="reason"><option value="RETRY_DISPATCH_SEARCH">Retry stranded dispatch search</option></select><button>Review search reopening</button></form>}
  </section>;
}
function Overview() {
  const load = useCallback(() => client.overview(), []), r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <OverviewView data={r.data}/>}<Lookup/></>;
}
function Attention() {
  const load = useCallback(() => client.overview(), []), r = useDriverResource(load, denied);
  const [selected, setSelected] = useState<OperationsSource>();
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <><label>Authorized source<select value={selected ?? ""} onChange={e => setSelected((e.target.value || undefined) as OperationsSource | undefined)}>
    <option value="">Choose a source</option>{r.data.sections.map(section => <option key={section.source} value={section.source}>{section.source}</option>)}</select></label>
    {selected ? <SourcePage key={selected} source={selected}/> : <p>Select an authorized source to inspect its current attention.</p>}</>}<Lookup/></>;
}
function SourcePage({ source }: { source: OperationsSource }) {
  const [cursor, setCursor] = useState<string>(), load = useCallback(() => client.attention(source, cursor), [source, cursor]), r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <><AttentionTable page={r.data}/>
    <button disabled={!cursor} onClick={() => setCursor(undefined)}>First page</button><button disabled={!r.data.next_cursor} onClick={() => setCursor(r.data?.next_cursor ?? undefined)}>Next page</button></>}</>;
}
function Order({ id }: { id: string }) {
  const load = useCallback(() => client.order(id), [id]), r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <><OrderView data={r.data}/><Timeline kind="order" id={id}/></>}</>;
}
function Delivery({ id }: { id: string }) {
  const load = useCallback(() => client.delivery(id), [id]), r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <DeliveryView data={r.data}/>}
    <RescueAction data={r.data} refresh={r.refresh}/>{r.data && <Timeline kind="delivery" id={id}/>}</>;
}
function Health() {
  const load = useCallback(() => client.health(), []), r = useDriverResource(load, denied);
  return <><Feedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>{r.data && <HealthView data={r.data}/>}</>;
}
export default function OperationsConsole({ mode, id }: { mode: "overview" | "orders" | "attention" | "order" | "delivery" | "health"; id?: string }) {
  return <main className="application-layout"><SessionBoundary client={authClient} title="Platform operations">{identity => <div className="application-content" key={"id" in identity ? identity.id : undefined}>
    <nav aria-label="Operations navigation"><Link href="/">Admin home</Link>{" · "}<Link href="/admin/operations">Operations overview</Link>{" · "}<Link href="/admin/operations/health">Worker signals</Link></nav>
    {mode === "overview" ? <Overview/> : mode === "attention" ? <Attention/> : mode === "orders" ? <Lookup/> : mode === "health" ? <Health/>
      : mode === "order" && id ? <Order key={id} id={id}/> : mode === "delivery" && id ? <Delivery key={id} id={id}/> : <p role="alert">A valid exact record ID is required.</p>}
  </div>}</SessionBoundary></main>;
}
