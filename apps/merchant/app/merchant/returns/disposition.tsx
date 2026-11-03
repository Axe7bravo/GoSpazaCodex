"use client";
import { useCallback, useState } from "react";
import { merchantFinance } from "@gospaza/api-client";
import type { DispositionDecision, DispositionLine } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";

const client=merchantFinance(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/application");
function Decision({line,busy,submit}:{line:DispositionLine;busy:boolean;submit:(decision:DispositionDecision)=>void}) {
  const [choice,setChoice]=useState<DispositionDecision|null>(null);
  if(line.status==="ATTENTION_REQUIRED") return <p role="alert">Stock update needs review. Do not submit it again.</p>;
  if(line.status==="DISPATCHED") return <p>Stock update in progress.</p>;
  if(line.status==="COMPLETED") return <p>{line.decision==="RESTOCK" ? "Restock completed." : "Recorded as non-sellable."}</p>;
  return <><p>Choose how to handle all {line.quantity} returned units.</p>
    <button disabled={busy} onClick={()=>setChoice("RESTOCK")}>Restock</button>
    <button disabled={busy} onClick={()=>setChoice("NON_SELLABLE")}>Mark non-sellable</button>
    {choice && <p>{choice==="RESTOCK" ? "Return sellable units to stock?" : "Keep these units out of available stock?"}{" "}
      <button disabled={busy} onClick={()=>{submit(choice);setChoice(null);}}>Confirm stock decision</button>
      <button disabled={busy} onClick={()=>setChoice(null)}>Cancel</button></p>}</>;
}
export default function Disposition({id}:{id:string}) {
  const load=useCallback(()=>client.lines(id),[id]);
  const r=useDriverResource(load,denied);
  return <section><h3>Returned stock</h3><button disabled={r.busy} onClick={()=>void r.refresh()}>Refresh stock decisions</button>
    {r.error ? <p role="alert">Stock decisions are unavailable.</p> : !r.data && <p role="status">Loading returned lines…</p>}
    {r.notice && <p role="status">Review the latest recorded stock decision below before taking further action.</p>}
    {r.data && !r.data.items.length && <p>No returned lines.</p>}
    {r.data?.items.map(line=><section key={line.line_id}><h4>Order line {line.line_id}</h4><p>{line.quantity} units received</p>
      <Decision line={line} busy={r.busy} submit={decision=>void r.mutate(()=>client.decide(id,line.line_id,decision))}/></section>)}
  </section>;
}
