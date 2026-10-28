"use client";
import { useCallback, useState } from "react";
import { createRestrictedCommerceClient } from "@gospaza/api-client";
import type { AlcoholClass } from "@gospaza/contracts";
import { useDriverResource } from "@gospaza/ui/driver-resource";
const client=createRestrictedCommerceClient(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/application");
export default function Classification({id}:{id:string}) {
  const load=useCallback(()=>client.classification(id),[id]);const resource=useDriverResource(load,denied);
  const [alcohol,setAlcohol]=useState(false);const [category,setCategory]=useState<AlcoholClass>("WINE");
  return <section aria-label="Restricted product classification"><h2>Restricted product classification</h2>
    {resource.error && <p role="alert">Classification unavailable.</p>}
    {resource.notice && <p role="status">Proposal recorded or awaiting confirmation. Review the latest platform classification.</p>}
    <button onClick={()=>void resource.refresh()}>Refresh classification</button>
    {resource.data && <><p>Merchant proposal: {resource.data.proposed}</p>
      <p>Platform review: {resource.data.review ? resource.data.review.restriction+" · "+(resource.data.review.current?"Current":"Invalidated — new review required") : "Review required"}</p>
      <p>A proposal does not approve alcohol sales or downgrade a platform-reviewed alcohol classification. Material catalogue changes require another review.</p>
      <form onSubmit={event=>{event.preventDefault();void resource.mutate(()=>client.propose(id,alcohol?"ALCOHOL":"NONE",alcohol?category:null));}}>
        <label>Proposed classification<select value={alcohol?"ALCOHOL":"NONE"} onChange={event=>setAlcohol(event.target.value==="ALCOHOL")}><option value="NONE">None</option><option value="ALCOHOL">Alcohol</option></select></label>
        {alcohol && <label>Alcohol class<select value={category} onChange={event=>{const v=event.target.value;if(v==="WINE"||v==="BEER"||v==="SPIRITS"||v==="OTHER")setCategory(v);}}>{["WINE","BEER","SPIRITS","OTHER"].map(v=><option key={v}>{v}</option>)}</select></label>}
        <button disabled={resource.busy}>Propose classification</button>
      </form></>}
  </section>;
}
