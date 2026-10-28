"use client";
import { useCallback, useState } from "react";
import { createRecipientClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { useMerchant } from "../shell";
const client=createRecipientClient(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/application");
function Receipt({id}:{id:string}) {
  const load=useCallback(()=>client.merchantReturn(id),[id]);
  const resource=useDriverResource(load,denied), value=resource.data;
  return <section aria-label="Physical return receipt"><h2>Physical return receipt</h2>
    {resource.error && <p role="alert">Return unavailable.</p>}
    {resource.notice && <p role="status">Review the latest custody result before another action.</p>}
    <button onClick={()=>void resource.refresh()}>Refresh return</button>
    {value && <><p>{value.return_state?.replaceAll("_"," ")}</p>
      <ul>{value.physical_manifest.map(item=><li key={item.id}>Original order line {item.id}: {item.quantity} units</li>)}</ul>
      <p>Acknowledge only physical custody of the entire recorded order. This does not restock inventory, cancel the native Order or issue any refund or credit.</p>
      {value.awaiting_store_receipt && <form onSubmit={event=>{event.preventDefault();void resource.mutate(()=>client.receiveReturn(id,value.revision));}}>
        <label><input type="checkbox" required disabled={resource.busy} />I have physically received the entire recorded return at this store</label>
        <button disabled={resource.busy}>Acknowledge physical receipt</button></form>}
      {!value.awaiting_store_receipt && value.return_state!=="RETURNED_TO_STORE" && <p>Awaiting driver arrival at the original store.</p>}
      {value.return_state==="RETURNED_TO_STORE" && <p>Physical custody acknowledged. Financial review remains pending.</p>}
    </>}
  </section>;
}
function Queue({offset,change}:{offset:number;change:(offset:number)=>void}) {
  const load=useCallback(()=>client.returns(offset),[offset]);const resource=useDriverResource(load,denied);
  const [selected,setSelected]=useState<string|null>(null);
  return <><button onClick={()=>void resource.refresh()}>Refresh returns</button>
    {resource.error && <p role="alert">Returns unavailable.</p>}
    {resource.data && <><ul>{resource.data.items.map(item=><li key={item.delivery_id}><button onClick={()=>setSelected(item.delivery_id)}>Open return for order {item.order_reference}</button> · {item.state?.replaceAll("_"," ")}</li>)}</ul>
      {!resource.data.items.length && <p>No physical returns for this store.</p>}
      <button disabled={offset===0} onClick={()=>change(offset-20)}>Previous returns</button><button disabled={!resource.data.more} onClick={()=>change(offset+20)}>Next returns</button>
      {selected && <Receipt key={selected} id={selected} />}
    </>}
  </>;
}
export default function Returns() {
  const {tenant}=useMerchant();const [offset,setOffset]=useState(0);
  return <section className="application-content"><h1>Store physical returns</h1>{tenant.membership.capabilities.includes("MERCHANT_RETURN_RECEIVE") ? <Queue key={offset} offset={offset} change={setOffset} /> : <p>Physical return receipt access is unavailable.</p>}</section>;
}
