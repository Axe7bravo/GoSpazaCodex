import type { MerchantSettlementDetail, PlatformSettlementDetail, PlatformSettlementSummary, SettlementSummary, SettlementPage, SettlementEvidence,
  SettlementDecisionInput, RecordSettlementPayout, RecordSettlementFailure, RetrySettlement, ReconcileSettlement } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
import { AuthError } from "./auth";
const ref=encodeURIComponent;
function transport(base:string,fetcher:typeof fetch) {
  const send=driverTransport(base,fetcher);
  return async<T>(path:string,method="GET",body?:unknown):Promise<T>=>{
    try {return await send<T>(path,method,body);} catch(error) {
      if(!(error instanceof AuthError)) throw error;
      throw new AuthError(error.kind,error.status===409?"Statement changed or evidence conflicts. Refresh and review before submitting again."
        :error.status===403||error.status===404?"Statement or action is unavailable for this account."
        :error.status===400?"Check the transfer evidence and required fields.":"Settlement information is unavailable. Refresh before taking another action.",error.status);
    }
  };
}
export function platformSettlements(base:string,fetcher:typeof fetch=fetch) {
  const send=transport(base,fetcher),statements="/admin/gospaza/merchant-settlements",payments="/admin/gospaza/merchant-payouts";
  return {
    list:(after?:string)=>send<SettlementPage<PlatformSettlementSummary>>(statements+(after?"?after="+ref(after):"")),
    detail:(id:string)=>send<PlatformSettlementDetail>(statements+"/"+ref(id)),
    evidence:(id:string)=>send<SettlementEvidence>(payments+"/"+ref(id)+"/evidence"),
    prepare:(id:string,input:SettlementDecisionInput)=>send(statements+"/"+ref(id)+"/prepare","POST",input),
    supersede:(id:string,input:SettlementDecisionInput)=>send<{statement_id:string}>(statements+"/"+ref(id)+"/supersede","POST",input),
    approve:(id:string,input:SettlementDecisionInput)=>send(payments+"/"+ref(id)+"/approve","POST",input),
    recordPayout:(id:string,input:RecordSettlementPayout)=>send(payments+"/"+ref(id)+"/payout","POST",input),
    recordFailure:(id:string,input:RecordSettlementFailure)=>send(payments+"/"+ref(id)+"/failed-attempt","POST",input),
    retry:(id:string,input:RetrySettlement)=>send(payments+"/"+ref(id)+"/retry","POST",input),
    reconcile:(id:string,input:ReconcileSettlement)=>send(payments+"/"+ref(id)+"/reconcile","POST",input),
  };
}
export function merchantSettlements(base:string,fetcher:typeof fetch=fetch) {
  const send=transport(base,fetcher),path="/merchant/settlements";
  return {list:(after?:string)=>send<SettlementPage<SettlementSummary>>(path+(after?"?after="+ref(after):"")),
    detail:(id:string)=>send<MerchantSettlementDetail>(path+"/"+ref(id))};
}
