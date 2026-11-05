"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { AuthError,platformSettlements } from "@gospaza/api-client";
import type { SettlementEvidence } from "@gospaza/contracts";
import { SessionBoundary } from "@gospaza/ui/auth";
import { FinanceFeedback } from "@gospaza/ui/financial";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { SettlementStatement, SettlementTable, settlementMoney,settlementEventLabel } from "@gospaza/ui/settlements";
import { orderTime } from "@gospaza/ui/orders";
import { authClient } from "../../auth-client";
import { SettlementOperations, type ReviewedOperation } from "./operations";
const client=platformSettlements(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/login");
function Evidence({payable}:{payable:string}) {
  const [data,setData]=useState<SettlementEvidence|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function read() {setBusy(true);setData(null);setError("");try {setData(await client.evidence(payable));}
    catch {setError("Restricted payout evidence is unavailable. Refresh access.");} finally {setBusy(false);}}
  return <section aria-label="Restricted payment evidence"><button disabled={busy} onClick={()=>void read()}>View payout evidence</button>
    {error && <p role="alert">{error}</p>}{data && <>
      {data.receipt && <dl><dt>Verified beneficiary reference</dt><dd>{data.receipt.beneficiary_reference}</dd>
        <dt>Originating channel/account reference</dt><dd>{data.receipt.origin_reference}</dd><dt>External transfer ID</dt><dd>{data.receipt.external_transfer_id}</dd>
        <dt>Evidence reference</dt><dd>{data.receipt.evidence_reference??"None recorded"}</dd></dl>}
      {data.approvals.map((a,i)=><p key={a.recorded_at+i}>{a.action} · {orderTime(a.recorded_at)} · {a.reason}</p>)}
      {data.failures.map(f=><p key={f.id}>Failed attempt: {f.failure_category} · {f.evidence_reference} · {f.beneficiary_reference}</p>)}
      {data.discrepancies.map(d=><p key={d.id}>{d.category} · {d.status} · {d.evidence_reference}</p>)}
    </>}</section>;
}
function Detail({id}:{id:string}) {
  const router=useRouter(),[epoch,refreshReview]=useState(0),[actionNotice,notify]=useState("");
  const load=useCallback(()=>client.detail(id),[id]);const r=useDriverResource(load,denied),d=r.data;
  async function write(draft:ReviewedOperation) {
    notify("");
    await r.mutate(async()=>{
      try {switch(draft.action) {
        case "PREPARE":return await client.prepare(id,draft.body);
        case "SUPERSEDE":{const result=await client.supersede(id,draft.body);router.replace("/admin/settlements/"+encodeURIComponent(result.statement_id));return;}
        case "APPROVE":return await client.approve(d?.statement.payable_id??"",draft.body);
        case "PAY":return await client.recordPayout(d?.statement.payable_id??"",draft.body);
        case "FAIL":return await client.recordFailure(d?.statement.payable_id??"",draft.body);
        case "RETRY":return await client.retry(d?.statement.payable_id??"",draft.body);
        case "RECONCILE":return await client.reconcile(d?.statement.payable_id??"",draft.body);
      }} catch(error) {notify(error instanceof AuthError?error.message:"Unable to confirm the operation. Review the refreshed statement.");throw error;}
    });
  }
  return <section className="application-content"><Link href="/admin/settlements">All settlements</Link><h1>Settlement detail</h1>
    <button disabled={r.busy} onClick={()=>{refreshReview(n=>n+1);void r.refresh();}}>Refresh statement</button>
    <FinanceFeedback loaded={!!d} error={r.error} refresh={()=>void r.refresh()}/>{(actionNotice||r.notice) && <p role="status">{actionNotice||r.notice}</p>}
    {d && <><SettlementStatement detail={d}/><p>Policy: {d.policy_version}</p>
      <p>Approved amount: {!d.statement.payable_id?"No positive payable":d.approved_amount_minor===null?"Not approved":settlementMoney(d.approved_amount_minor)}</p>
      {!!d.discrepancies.length && <section aria-label="Payment discrepancies"><h2>Payment discrepancies</h2><ul>{d.discrepancies.map(a=><li key={a.id}>{a.category.replaceAll("_"," ")} · Open · {orderTime(a.recorded_at)}</li>)}</ul></section>}
      <h2>Settlement history</h2><ul>{d.history.map((a,i)=><li key={a.action+a.recorded_at+i}>{settlementEventLabel[a.action]??"Settlement event"} · {orderTime(a.recorded_at)} · Platform actor {a.actor_id}</li>)}</ul>
      {!!d.failures.length && <><h2>Failed payout attempts</h2><ul>{d.failures.map(f=><li key={f.id}>{f.category.replaceAll("_"," ")} · {orderTime(f.attempted_at)}</li>)}</ul></>}
      {d.can_read_evidence && d.statement.payable_id && <Evidence key={d.statement.payable_id+":"+d.payable_revision} payable={d.statement.payable_id}/>}
      <SettlementOperations key={[id,d.statement_revision,d.payable_revision,d.actions.join(),epoch].join(":")} detail={d} write={write} busy={r.busy}/></>}
  </section>;
}
function List() {
  const [after,page]=useState<string|undefined>();const load=useCallback(()=>client.list(after),[after]);const r=useDriverResource(load,denied);
  return <section className="application-content"><Link href="/">Admin home</Link><h1>Merchant settlements</h1>
    <FinanceFeedback loaded={!!r.data} error={r.error} refresh={()=>void r.refresh()}/>
    {r.data && <><SettlementTable rows={r.data.items} href="/admin/settlements"/>
      <button disabled={!after} onClick={()=>page(undefined)}>First page</button><button disabled={!r.data.next_after} onClick={()=>page(r.data?.next_after??undefined)}>Next page</button></>}
  </section>;
}
export default function SettlementConsole({id}:{id?:string}) {
  return <main className="application-layout"><SessionBoundary client={authClient} title="Platform settlement workspace">
    {actor=>actor.type==="user" && (id?<Detail key={actor.id+id} id={id}/>:<List key={actor.id}/>)}</SessionBoundary></main>;
}
