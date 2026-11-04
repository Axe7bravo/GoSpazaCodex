import type { AdminOrderEconomics, CommissionHistory, CommissionRuleView, MerchantOrderEconomics, PublishCommission } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
export function platformCommission(base:string, fetcher:typeof fetch=fetch) {
  const request=driverTransport(base,fetcher);
  const path="/admin/gospaza/commission-rules";
  return {
    history:(merchant:string,offset=0)=> {
      const query=new URLSearchParams({limit:"20",offset:String(offset)});
      if(merchant) query.set("merchant_id",merchant);
      return request<CommissionHistory>(path+"?"+query);
    },
    publish:(input:PublishCommission)=>request<CommissionRuleView>(path,"POST",input),
    order:(id:string)=>request<AdminOrderEconomics>("/admin/gospaza/orders/"+encodeURIComponent(id)+"/finance-snapshot"),
  };
}
export function merchantCommission(base:string,fetcher:typeof fetch=fetch) {
  const request=driverTransport(base,fetcher);
  return { order:(id:string)=>request<MerchantOrderEconomics>("/merchant/orders/"+encodeURIComponent(id)+"/economics") };
}
