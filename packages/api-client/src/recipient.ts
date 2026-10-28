import type { RecipientObservation, RecipientState, CustomerRestrictedHandoff, RestrictedDeliveryInvoice } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
export function createRecipientClient(baseUrl:string,fetcher:typeof fetch=fetch,publishableKey="") {
  const request=driverTransport(baseUrl,fetcher,publishableKey?{"x-publishable-api-key":publishableKey}:{});
  const driver=(id:string)=>"/driver/deliveries/"+encodeURIComponent(id);
  return {
    returns:(offset=0)=>request<{items:{delivery_id:string;order_reference:string;state:RecipientState["return_state"];awaiting_store_receipt:boolean}[];more:boolean}>("/merchant/deliveries/returns?offset="+offset),
    read:(id:string)=>request<RecipientState>(driver(id)+"/recipient"),
    document:(id:string)=>request<{document:RestrictedDeliveryInvoice}>(driver(id)+"/document"),
    merchantDocument:(orderId:string)=>request<{document:RestrictedDeliveryInvoice}>("/merchant/orders/"+encodeURIComponent(orderId)+"/restricted-document"),
    verify:(id:string,input:RecipientObservation)=>request<RecipientState>(driver(id)+"/recipient","POST",{
      expected_revision:input.expected_revision,recipient_role:input.recipient_role,document_type:input.document_type,
      document_viewed:input.document_viewed,date_of_birth:input.date_of_birth,school_uniform_observed:input.school_uniform_observed,
      recipient_declares_school_going_learner:input.recipient_declares_school_going_learner,recipient_appears_intoxicated:input.recipient_appears_intoxicated,
      recipient_refused_verification:input.recipient_refused_verification,invoice_address_matches:input.invoice_address_matches,
    }),
    startReturn:(id:string,revision:number)=>request<RecipientState>(driver(id)+"/return/start","POST",{expected_revision:revision}),
    returnArrival:(id:string,revision:number)=>request<RecipientState>(driver(id)+"/return/arrive","POST",{expected_revision:revision}),
    merchantReturn:(id:string)=>request<RecipientState&{physical_manifest:{id:string;quantity:number}[]}>("/merchant/deliveries/"+encodeURIComponent(id)+"/return"),
    receiveReturn:(id:string,revision:number)=>request<RecipientState>("/merchant/deliveries/"+encodeURIComponent(id)+"/return","POST",{expected_revision:revision}),
    customer:(id:string)=>request<CustomerRestrictedHandoff>("/store/gospaza/orders/"+encodeURIComponent(id)+"/restricted-handoff"),
  };
}
