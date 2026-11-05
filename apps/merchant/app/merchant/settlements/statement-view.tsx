"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { merchantSettlements } from "@gospaza/api-client";
import { FinanceFeedback } from "@gospaza/ui/financial";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { SettlementStatement, SettlementTable } from "@gospaza/ui/settlements";
import { useMerchant } from "../shell";
const client=merchantSettlements(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/login");
function Detail({id}:{id:string}) {
  const load=useCallback(()=>client.detail(id),[id]);const r=useDriverResource(load,denied);
  return <><Link href="/merchant/settlements">All statements</Link><h1>Settlement statement</h1>
    <button onClick={()=>void r.refresh()}>Refresh statement</button><FinanceFeedback loaded={!!r.data} error={r.error} refresh={()=>void r.refresh()}/>
    {r.data && <SettlementStatement detail={r.data}/>}</>;
}
function List() {
  const [after,page]=useState<string|undefined>();const load=useCallback(()=>client.list(after),[after]);const r=useDriverResource(load,denied);
  return <><h1>Settlement statements</h1><FinanceFeedback loaded={!!r.data} error={r.error} refresh={()=>void r.refresh()}/>
    {r.data && <><SettlementTable rows={r.data.items} href="/merchant/settlements"/><button disabled={!after} onClick={()=>page(undefined)}>First page</button>
      <button disabled={!r.data.next_after} onClick={()=>page(r.data?.next_after??undefined)}>Next page</button></>}</>;
}
export default function StatementView({id}:{id?:string}) {
  const {tenant}=useMerchant();if(!tenant.membership.capabilities.includes("MERCHANT_SETTLEMENT_VIEW")) return <p role="alert">Settlement statements are unavailable for your role.</p>;
  return <section className="application-content" key={tenant.membership.id}>{id?<Detail key={tenant.membership.id+id} id={id}/>:<List key={tenant.membership.id}/>}</section>;
}
