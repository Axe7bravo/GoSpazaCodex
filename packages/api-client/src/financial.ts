import type { AdminFinancialOrder, CustomerFinancialResolution, DispositionDecision, DispositionLine, FinancialAdjustmentView, MerchantAdjustment } from "@gospaza/contracts";
import { driverTransport } from "./drivers";

export function customerFinance(base:string,key:string,fetcher:typeof fetch=fetch) {
  const request=driverTransport(base,fetcher,{"x-publishable-api-key":key});
  return {
    order:(id:string)=>request<CustomerFinancialResolution>("/store/gospaza/orders/"+encodeURIComponent(id)+"/financial-resolution"),
    balance:()=>request<{currency:"zar";balance_minor:number}>("/store/gospaza/balance"),
    apply:(use:boolean)=>request<{gross_minor:number;applied_minor:number;external_payable_minor:number}>("/store/gospaza/balance","POST",{use_balance:use}),
  };
}
export function merchantFinance(base:string,fetcher:typeof fetch=fetch) {
  const request=driverTransport(base,fetcher);
  const path=(id:string)=>"/merchant/deliveries/"+encodeURIComponent(id)+"/dispositions";
  return {
    order:(id:string)=>request<{adjustments:MerchantAdjustment[]}>("/merchant/orders/"+encodeURIComponent(id)+"/financial-resolution"),
    lines:(id:string)=>request<{items:DispositionLine[]}>(path(id)),
    decide:(id:string,line:string,decision:DispositionDecision)=>request(path(id),"POST",{line_id:line,decision,confirmed:true}),
  };
}
export function adminFinance(base:string,fetcher:typeof fetch=fetch) {
  const request=driverTransport(base,fetcher);
  return { order:(id:string)=>request<AdminFinancialOrder>("/admin/gospaza/orders/"+encodeURIComponent(id)+"/financial-resolution"),
    list:(offset:number)=>request<{adjustments:FinancialAdjustmentView[];limit:number;offset:number}>(
    "/admin/gospaza/financial-adjustments?limit=20&offset="+offset) };
}
