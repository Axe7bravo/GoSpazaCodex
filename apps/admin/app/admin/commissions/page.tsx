"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AuthError, platformCommission } from "@gospaza/api-client";
import type { PublishCommission } from "@gospaza/contracts";
import { SessionBoundary } from "@gospaza/ui/auth";
import { FinanceFeedback } from "@gospaza/ui/financial";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { commissionRate } from "@gospaza/ui/order-economics";
import { orderTime } from "@gospaza/ui/orders";
import { authClient } from "../../auth-client";

const client=platformCommission(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/login");
function Rules({merchant}:{merchant:string}) {
  const [offset,page]=useState(0), [scheduled,schedule]=useState(false), [clear,setClear]=useState(false);
  const [draft,review]=useState<PublishCommission|null>(null), [message,notify]=useState(""), [busy,setBusy]=useState(false);
  const writing=useRef(false);
  const load=useCallback(()=>client.history(merchant,offset),[merchant,offset]);
  const r=useDriverResource(load,denied), history=r.data;
  function prepare(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!history?.can_publish) return;
    const data=new FormData(e.currentTarget), raw=String(data.get("bps")??""), reason=String(data.get("reason")??"").trim();
    const date=scheduled?new Date(String(data.get("effective")??"")):null;
    if(!reason || (!clear && (!/^\d{1,5}$/.test(raw)||Number(raw)>10000)) ||
      (date && (!Number.isFinite(date.getTime())||date.getTime()<=Date.now()))) {
      notify("Check the rate, reason and future effective time.");return;
    }
    notify("");review({scope:merchant?"MERCHANT":"PLATFORM",...(merchant?{merchant_id:merchant}:{}),decision:clear?"CLEAR":"SET",
      ...(clear?{}:{basis_points:Number(raw)}),...(date?{effective_at:date.toISOString()}:{}),
      reason,expected_revision:history.revision,request_id:crypto.randomUUID(),confirmed:true});
  }
  async function publish() {
    if(!draft || !history?.can_publish || writing.current) return;
    writing.current=true;setBusy(true);
    try { await client.publish(draft);notify("Publication acknowledged. Check the refreshed history."); }
    catch(error) {notify(error instanceof AuthError && error.status===409?
      "Publication conflict. Review the refreshed rules before publishing again.":"Unable to confirm publication. Check the refreshed history.");}
    finally {review(null);await r.refresh();writing.current=false;setBusy(false);}
  }
  return <section><h2>{merchant?"Merchant "+merchant:"Platform default"}</h2>
    <FinanceFeedback loaded={!!history} error={r.error} refresh={()=>void r.refresh()}/>
    {history && <><p>Current effective rate: {commissionRate(history.effective?.basis_points??null)}
      {merchant && history.effective && !history.effective.merchant_id?" (platform default)":""}</p>
      {history.items.length?<div className="table-scroll"><table><caption>Rule history</caption><thead><tr>
        {["Revision","Decision","Rate","Timing","Effective","Recorded","Reason"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
        {history.items.map(row=><tr key={row.id}><td>{row.revision}</td><td>{row.decision==="CLEAR"?"Clear override":merchant?"Merchant override":"Platform default"}</td>
          <td>{row.decision==="CLEAR"?"Follows platform default":commissionRate(row.basis_points)}</td>
          <td>{{CURRENT:"Current",FUTURE:"Future",HISTORICAL:"Historical"}[row.timing]}</td>
          <td>{orderTime(row.effective_at)}</td><td>{orderTime(row.recorded_at)}</td><td>{row.reason}</td></tr>)}</tbody></table></div>:<p>No published decisions on this page.</p>}
      <button disabled={!offset||busy} onClick={()=>{review(null);page(offset-20);}}>Previous page</button>
      <button disabled={history.items.length<20||busy} onClick={()=>{review(null);page(offset+20);}}>Next page</button>
      {history.can_publish && offset===0 && <><h2>Publish a commission decision</h2>
        {draft?<><h3>Review decision</h3><p>{merchant?"Merchant "+merchant:"Platform default"} · {clear?"Clear to platform default":"Set rate "+commissionRate(draft.basis_points??null)}</p>
          <p>{draft.effective_at?orderTime(draft.effective_at):"Effective immediately"}</p><p>Reason: {draft.reason}</p>
          <button disabled={busy} onClick={()=>void publish()}>Confirm publication</button><button disabled={busy} onClick={()=>review(null)}>Back</button></>:
          <form onSubmit={prepare}>{merchant && <label>Decision <select value={clear?"CLEAR":"SET"} onChange={e=>setClear(e.target.value==="CLEAR")}>
            <option value="SET">Set merchant override</option><option value="CLEAR">Clear to platform default</option></select></label>}
            {!clear && <label>Rate in basis points (100 = 1%) <input name="bps" type="number" min="0" max="10000" step="1" required/></label>}
            <label>Effective time <select value={scheduled?"future":"now"} onChange={e=>schedule(e.target.value==="future")}>
              <option value="now">Immediate</option><option value="future">Future</option></select></label>
            {scheduled && <label>Effective local date and time <input name="effective" type="datetime-local" required/></label>}
            <label>Reason <input name="reason" required maxLength={240}/></label><button disabled={busy}>Review decision</button></form>}</>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
function Console() {
  const [merchant,setMerchant]=useState("");
  return <section className="application-content"><Link href="/">Admin home</Link>
    <form onSubmit={e=>{e.preventDefault();setMerchant(String(new FormData(e.currentTarget).get("merchant")??"").trim());}}>
      <label>Merchant reference (empty for platform default) <input name="merchant" maxLength={100}/></label>
      <button>View rules</button></form><Rules key={merchant} merchant={merchant}/></section>;
}
export default function Page() {
  return <main className="application-layout"><SessionBoundary client={authClient} title="Commission rules">
    {actor=>actor.type==="user" && <Console key={actor.id}/>}</SessionBoundary></main>;
}
