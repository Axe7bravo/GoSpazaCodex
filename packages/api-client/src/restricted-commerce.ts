import type { RestrictedClassificationDTO, RestrictedRegistrationDTO, RestrictedRegistrationSubmission, RestrictedRegistrationDecision, PurchaserEligibilityDTO, Restriction, AlcoholClass } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
export function createRestrictedCommerceClient(baseUrl: string, fetcher: typeof fetch = fetch, publishableKey = "") {
  const request = driverTransport(baseUrl,fetcher,publishableKey ? { "x-publishable-api-key": publishableKey } : {});
  return {
    queue: (offset=0) => request<{items:{store_id:string;name:string;status:string}[];more:boolean}>("/admin/gospaza/restricted-commerce/stores?offset="+offset),
    adminRegistration: (store:string) => request<RestrictedRegistrationDTO>("/admin/gospaza/restricted-commerce/stores/"+encodeURIComponent(store)),
    review: (store:string, input:RestrictedRegistrationDecision) => request<RestrictedRegistrationDTO>("/admin/gospaza/restricted-commerce/stores/"+encodeURIComponent(store),"POST",{
      action:input.action,expected_revision:input.expected_revision,confirmed:input.confirmed,reason:input.reason,
      ...(input.action === "approve" ? {conditions_confirmed:input.conditions_confirmed,trading_policy:input.trading_policy} : {}),
    }),
    adminClassification: (store:string, product:string) => request<RestrictedClassificationDTO>("/admin/gospaza/restricted-commerce/stores/"+encodeURIComponent(store)+"/products/"+encodeURIComponent(product)),
    reviewClassification: (store:string, product:string, input:{restriction:Restriction;alcohol_class:AlcoholClass|null;expected_identity:string;confirmed:true;reason:string}) =>
      request<RestrictedClassificationDTO>("/admin/gospaza/restricted-commerce/stores/"+encodeURIComponent(store)+"/products/"+encodeURIComponent(product),"POST",{
        restriction:input.restriction,alcohol_class:input.alcohol_class,expected_identity:input.expected_identity,confirmed:input.confirmed,reason:input.reason,
      }),
    upload: (input:{display_name:string;mime_type:string;content:string}) => request<{id:string}>("/merchant/restricted-commerce/documents","POST",{
      document_type:"LIQUOR_DOCUMENT",display_name:input.display_name,mime_type:input.mime_type,content:input.content,
    }),
    evidenceUrl: (id:string,store?:string) => new URL((store ? "/admin/gospaza/restricted-commerce/stores/"+encodeURIComponent(store) : "/merchant/restricted-commerce")+"/documents/"+encodeURIComponent(id),baseUrl).href,
    purchaser: () => request<PurchaserEligibilityDTO>("/store/gospaza/purchaser-eligibility"),
    registration: () => request<RestrictedRegistrationDTO>("/merchant/restricted-commerce"),
    submit: (input: RestrictedRegistrationSubmission) => request<RestrictedRegistrationDTO>("/merchant/restricted-commerce","POST",{
      registration_number: input.registration_number, category: input.category, issuing_authority: input.issuing_authority,
      valid_from: input.valid_from, valid_until: input.valid_until, evidence_ids: input.evidence_ids,
    }),
    classification: (product: string) => request<RestrictedClassificationDTO>("/merchant/restricted-commerce/products/"+encodeURIComponent(product)),
    propose: (product: string, restriction: Restriction, alcohol_class: AlcoholClass | null) =>
      request<{ proposed: Restriction; review_required: true }>("/merchant/restricted-commerce/products/"+encodeURIComponent(product),"POST",{ restriction,alcohol_class }),
  };
}
