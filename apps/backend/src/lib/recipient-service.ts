import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type MarketplaceService from "../modules/marketplace/service";
import { requireCapability, resourceId } from "../modules/marketplace/team-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { restrictedParse } from "../modules/marketplace/restricted-policy";
import { recipientInput, evaluateRestrictedRecipientCompliance, recipientConflict, deliveryDocumentPolicy } from "../modules/marketplace/recipient-policy";
import { handoffRevision, type HandoffGeneration } from "../modules/marketplace/handoff-policy";
import { pickupManifest, type PickupOperation } from "../modules/marketplace/pickup-policy";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { PickupService, type PickupScope } from "./pickup-service";
import { HandoffService } from "./handoff-service";
import { RestrictedCommerce } from "./restricted-commerce";
import { deliveryInvoice, type InvoiceRow } from "./restricted-delivery-document";
import { readOperationalOrder } from "./order-operation-native";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";

type Decision = ReturnType<typeof evaluateRestrictedRecipientCompliance>;
export interface RecipientRow { id: string; delivery_id: string; commitment_id: string; driver_profile_id: string; generation_id: string;
  document_id: string; outcome: Decision["outcome"]; reason: string | null; evidence: Decision["evidence"]; expected_revision: number; verified_at: Date }
export interface RestrictedReturnRow { id: string; delivery_id: string; compliance_id: string; commitment_id: string; merchant_store_id: string;
  fulfillment_id: string; physical_manifest: { id: string; quantity: number }[]; state: "RETURN_REQUIRED" | "RETURNING_TO_STORE" | "RETURNED_TO_STORE";
  failed_at: Date; started_at: Date | null; driver_arrived_at: Date | null; returned_at: Date | null; received_by: string | null }
export async function returnFor(s: PickupScope) { return s.trx<RestrictedReturnRow>("restricted_return").where({ delivery_id:s.d.id }).forUpdate().first(); }
export async function recipientSatisfied(s: PickupScope, generationId: string | undefined) {
  if (!s.d.restricted_content_present) return true;
  if (!generationId || await returnFor(s)) return false;
  return !!await s.trx<RecipientRow>("recipient_compliance").where({ delivery_id:s.d.id,commitment_id:s.c.id,
    driver_profile_id:s.c.driver_profile_id,generation_id:generationId,outcome:"SATISFIED" }).first();
}
function transportCopy(snapshot: unknown) {
  const document=deliveryInvoice.parse(snapshot);
  return {document_number:document.document_number,order_reference:document.order_reference,ordered_at:document.ordered_at,
    address:{address_1:document.address.address_1,address_2:document.address.address_2,city:document.address.city,
      province:document.address.province,postal_code:document.address.postal_code,country_code:document.address.country_code},
    seller_name:document.seller_name,premises:document.premises,
    registration_number:document.registration_number,registration_category:document.registration_category,
    goods:document.goods.map(item=>({description:item.description,sku:item.sku,quantity:item.quantity}))};
}
export class RecipientService {
  private readonly db: Knex;
  private readonly pickup: PickupService;
  async merchantQueue(identity: string, offset: number) {
    const marketplace = this.container.resolve<MarketplaceService>("marketplace");
    return withMerchantAuthorization(this.db, marketplace, identity, "MERCHANT_RETURN_RECEIVE", async (trx, tenant) => {
      const rows = await trx("restricted_return as physical_return")
        .join("delivery_operation as delivery", "delivery.id", "physical_return.delivery_id")
        .join("restricted_delivery_document as document", "document.order_operation_id", "delivery.order_operation_id")
        .where("delivery.merchant_id", tenant.merchant.id).where("physical_return.merchant_store_id", tenant.store.id)
        .orderBy("physical_return.failed_at", "desc").orderBy("delivery.id")
        .select("delivery.id as delivery_id", "physical_return.state", "physical_return.driver_arrived_at")
        .select(trx.raw("document.snapshot->>'order_reference' as order_reference")).limit(21).offset(offset);
      return { items: rows.slice(0, 20).map(row => ({ delivery_id: row.delivery_id, order_reference: row.order_reference, state: row.state,
        awaiting_store_receipt: !!row.driver_arrived_at && row.state !== "RETURNED_TO_STORE" })), more: rows.length > 20 };
    });
  }
  constructor(private readonly container: MedusaContainer) {
    this.db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); this.pickup=new PickupService(container);
  }
  async event(s: PickupScope, target: string, action: string, actor: string, evidence: object = {}) {
    await new RestrictedCommerce(this.container).event(s.trx,{ id:s.d.merchant_store_id,merchant_id:s.d.merchant_id },actor,target,action,evidence);
  }
  private async changed(s: PickupScope, action: string, returned = false, attention = false) {
    const revision=s.d.revision+1, now=await databaseTime(s.trx);
    await s.trx("delivery_operation").where({ id:s.d.id }).update({ revision,updated_at:now,...(returned?{status:"RETURNED_TO_STORE"}:attention?{status:"ATTENTION_REQUIRED",reason:"COMPLIANCE_RECOVERY_REQUIRED"}:{}) });
    await s.trx("dispatch_event").insert({ id:"dsevt_"+randomUUID(),target_type:"DELIVERY",target_id:s.d.id,revision,
      action,actor_type:"system",actor_id:null,occurred_at:now,evidence:JSON.stringify({commitment_id:s.c.id,...(returned?{commitment_status:"RETURNED",capacity_released:true}:{})}) });
    s.d.revision=revision;
  }
  async blockChangedSupply(s:PickupScope) {
    // An already-won recipient result is not rewritten into its opposite. A
    // later seller-policy loss retains custody for explicit operational recovery.
    if(s.d.status!=="ATTENTION_REQUIRED") {
      await this.event(s,s.d.id,"COMPLIANCE_RECOVERY_REQUIRED","supply-policy");
      await this.changed(s,"COMPLIANCE_RECOVERY_REQUIRED",false,true);
    }
  }
  async supplyValid(s: PickupScope) {
    if (!deliveryDocumentPolicy()) throw recipientConflict();
    const handoff=await readOrderHandoff(s.trx,s.d.medusa_order_id), restriction=handoff?.snapshot.restricted_commerce;
    if (!handoff || !restriction?.restricted_content_present) throw recipientConflict();
    const authority=await new RestrictedCommerce(this.container).supplyAuthority(s.trx,s.d.merchant_store_id,restriction.classifications,"handoff");
    const doc=await s.trx<InvoiceRow>("restricted_delivery_document").where({order_operation_id:s.d.order_operation_id,medusa_order_id:s.d.medusa_order_id}).first();
    if (!doc) throw recipientConflict();
    const snapshot=deliveryInvoice.parse(doc.snapshot), order=await readOperationalOrder(this.container,handoff);
    if (snapshot.merchant_store_id!==s.d.merchant_store_id || snapshot.order_id!==s.d.medusa_order_id
      || snapshot.registration_id!==authority.registration.id || snapshot.registration_number!==authority.submission.registration_number
      || snapshot.registration_category!==authority.submission.category
      || Object.entries(snapshot.premises).some(([key,value])=>authority.store[key as keyof typeof authority.store]!==value)) throw recipientConflict();
    for (const [key,value] of Object.entries(snapshot.address)) {
      const actual=order.shipping_address?.[key as keyof NonNullable<typeof order.shipping_address>];
      if ((actual??"")!==value) throw recipientConflict();
    }
    const shipment=await s.trx<{input:{items:unknown}}>("pickup_operation").where({delivery_id:s.d.id,action:"SHIP",state:"SUCCEEDED"}).first();
    const transported=pickupManifest.parse(shipment?.input.items);
    if (JSON.stringify(snapshot.physical_manifest.map(item=>[item.id,item.quantity]))!==JSON.stringify(transported.map(item=>[item.id,item.quantity]))) throw recipientConflict();
    return doc;
  }
  async verify(identity: string,id: string,body: unknown) {
    const input=restrictedParse(recipientInput,body);
    await new HandoffService(this.container).admitRecipient(id,identity);
    return this.pickup.locked(id,identity,async s => {
      const generations=await s.trx<HandoffGeneration>("handoff_generation").where({delivery_id:id}).orderBy("number").forUpdate();
      const current=generations.at(-1), now=await databaseTime(s.trx);
      if (!s.d.restricted_content_present || !s.d.arrived_at || !current || s.c.status!=="ASSIGNED") throw recipientConflict();
      const decision=evaluateRestrictedRecipientCompliance(input,now);
      const winner=await s.trx<RecipientRow>("recipient_compliance").where({generation_id:current.id}).forUpdate().first();
      if (winner) {
        // Replay compares the bounded decision, never retains or fingerprints DOB.
        if (winner.expected_revision!==input.expected_revision || winner.outcome!==decision.outcome && winner.reason!=="COMPLIANCE_RECOVERY_REQUIRED"
          || Object.entries(decision.evidence).some(([k,v]) => winner.evidence[k as keyof Decision["evidence"]]!==v)) throw recipientConflict();
        return this.projection(s,winner);
      }
      if (s.d.status!=="ASSIGNED" || s.d.revision!==input.expected_revision || current.state!=="ACTIVE" || now>=new Date(current.expires_at)
        || await s.trx("delivery_completion").where({delivery_id:id}).first() || await returnFor(s)) throw recipientConflict();
      const {ship}=await new HandoffService(this.container).shipment(s);
      const doc=await s.trx<InvoiceRow>("restricted_delivery_document").where({order_operation_id:s.d.order_operation_id}).first();
      if (!doc) throw recipientConflict();
      try { await this.supplyValid(s); }
      catch(error) {
        if (!MedusaError.isMedusaError(error)) throw error;
        decision.outcome="FAILED";decision.reason="COMPLIANCE_RECOVERY_REQUIRED";
      }
      const result:RecipientRow={id:"rcmp_"+randomUUID(),delivery_id:id,commitment_id:s.c.id,driver_profile_id:s.c.driver_profile_id,
        generation_id:current.id,document_id:doc.id,...decision,expected_revision:input.expected_revision,verified_at:now};
      await this.event(s,result.id,"RECIPIENT_VERIFICATION_STARTED",s.c.driver_profile_id,{document_type:result.evidence.document_type,document_viewed:result.evidence.document_viewed});
      await s.trx("recipient_compliance").insert({...result,evidence:JSON.stringify(result.evidence)});
      await this.event(s,result.id,"RECIPIENT_"+result.outcome,s.c.driver_profile_id,{outcome:result.outcome,reason:result.reason,policy_version:result.evidence.policy_version});
      if(result.outcome==="FAILED") {
        const ret="rret_"+randomUUID();
        await s.trx("restricted_return").insert({id:ret,delivery_id:id,compliance_id:result.id,commitment_id:s.c.id,merchant_store_id:s.d.merchant_store_id,
          fulfillment_id:s.d.native_fulfillment_id,physical_manifest:JSON.stringify(pickupManifest.parse(ship.input.items)),state:"RETURN_REQUIRED",failed_at:now});
        await this.event(s,ret,"RETURN_REQUIRED",s.c.driver_profile_id);
      }
      await this.changed(s,result.outcome==="FAILED"?"RESTRICTED_RETURN_REQUIRED":"RECIPIENT_SATISFIED");
      return this.projection(s,result);
    },true);
  }
  private async projection(s:PickupScope,winner?:RecipientRow) {
    const ret=await returnFor(s);
    if (!winner) {
      const generation=await s.trx<HandoffGeneration>("handoff_generation").where({delivery_id:s.d.id}).orderBy("number","desc").first();
      if (generation) winner=await s.trx<RecipientRow>("recipient_compliance").where({generation_id:generation.id}).first();
    }
    const doc=await s.trx<InvoiceRow>("restricted_delivery_document").where({order_operation_id:s.d.order_operation_id}).first();
    return {delivery_id:s.d.id,revision:s.d.revision,compliance:winner?.outcome??"REQUIRED",
      return_state:ret?.state??null,awaiting_store_receipt:!!ret?.driver_arrived_at&&!ret.returned_at,
      financial_review_required:!!ret||await this.priorFinancialReview(s),origin_store:doc?{name:doc.snapshot.seller_name,address:doc.snapshot.premises}:null};
  }
  private async priorFinancialReview(s:PickupScope) {
    // M16's immutable physical custody input already retains M13 omission evidence.
    const ship=await s.trx<PickupOperation>("pickup_operation").where({delivery_id:s.d.id,action:"SHIP",state:"SUCCEEDED"}).first();
    return ship?.input.financial_review_required===true;
  }
  async read(identity:string,id:string) {
    return this.pickup.locked(id,identity,async s=>{
      if(!s.d.restricted_content_present) throw recipientConflict();
      const g=await s.trx<HandoffGeneration>("handoff_generation").where({delivery_id:id}).orderBy("number","desc").first();
      const winner=g?await s.trx<RecipientRow>("recipient_compliance").where({generation_id:g.id}).first():undefined;
      return this.projection(s,winner);
    },true);
  }
  async returnAction(identity:string,id:string,action:"start"|"arrive",body:unknown) {
    const input=restrictedParse(handoffRevision,body);
    return this.pickup.locked(id,identity,async s=>{
      const ret=await returnFor(s); if(!ret) throw recipientConflict();
      if(ret.state==="RETURNED_TO_STORE" || action==="start"&&ret.started_at || action==="arrive"&&ret.driver_arrived_at) return this.projection(s);
      if(s.c.status!=="ASSIGNED" || s.d.revision!==input.expected_revision || action==="arrive"&&!ret.started_at) throw recipientConflict();
      const now=await databaseTime(s.trx);
      await s.trx("restricted_return").where({id:ret.id}).update(action==="start"?{state:"RETURNING_TO_STORE",started_at:now,updated_at:now}:{driver_arrived_at:now,updated_at:now});
      await this.event(s,ret.id,action==="start"?"RETURN_STARTED":"RETURN_ARRIVED",s.c.driver_profile_id);
      await this.changed(s,action==="start"?"RETURN_STARTED":"RETURN_ARRIVED");
      return this.projection(s);
    },true);
  }
  async merchant(identity:string,id:string,body?:unknown) {
    restrictedParse(resourceId,id);
    const input=body===undefined?undefined:restrictedParse(handoffRevision,body);
    const marketplace=this.container.resolve<MarketplaceService>("marketplace"), initial=await marketplace.resolveTenant(identity);
    requireCapability(initial.membership.member_type,"MERCHANT_RETURN_RECEIVE");
    const observed=await this.db("delivery_operation").where({id,merchant_id:initial.merchant.id}).first();
    if(!observed) throw new MedusaError(MedusaError.Types.NOT_FOUND,"Delivery unavailable.");
    return this.pickup.locked(id,undefined,async s=>{
      // Pickup's merchant-first prefix already holds the owning merchant row.
      const tenant=await marketplace.resolveTenant(identity,s.trx);
      requireCapability(tenant.membership.member_type,"MERCHANT_RETURN_RECEIVE");
      if(tenant.merchant.id!==s.d.merchant_id) throw new MedusaError(MedusaError.Types.NOT_FOUND,"Delivery unavailable.");
      const ret=await returnFor(s);if(!ret) throw recipientConflict();
      if(input&&ret.state!=="RETURNED_TO_STORE") {
        if(ret.state!=="RETURNING_TO_STORE"||!ret.driver_arrived_at||s.c.status!=="ASSIGNED"||s.d.revision!==input.expected_revision) throw recipientConflict();
        const now=await databaseTime(s.trx);
        await s.trx("restricted_return").where({id:ret.id}).update({state:"RETURNED_TO_STORE",received_by:tenant.membership.id,returned_at:now,updated_at:now});
        await this.event(s,ret.id,"STORE_RECEIPT_ACKNOWLEDGED",tenant.membership.id);
        await s.trx("dispatch_commitment").where({id:s.c.id,status:"ASSIGNED"}).update({status:"RETURNED",revision:s.c.revision+1,updated_at:now});
        await this.changed(s,"RETURNED_TO_STORE",true);
      }
      return {...await this.projection(s),physical_manifest:ret.physical_manifest};
    },true);
  }
  async driverDocument(identity:string,id:string) {
    return this.pickup.locked(id,identity,async s=>{
      const doc=await s.trx<InvoiceRow>("restricted_delivery_document").where({order_operation_id:s.d.order_operation_id}).first();
      if(!doc||s.c.status!=="ASSIGNED") throw recipientConflict();
      if(!await s.trx("restricted_event").where({target_id:doc.id,actor_id:s.c.driver_profile_id,action:"DELIVERY_COPY_AVAILABLE"}).first())
        await this.event(s,doc.id,"DELIVERY_COPY_AVAILABLE",s.c.driver_profile_id);
      return {document:transportCopy(doc.snapshot)};
    });
  }
  async customer(customer:string,orderId:string) {
    const id=await new HandoffService(this.container).ownedDelivery(customer,orderId);
    return this.pickup.locked(id,undefined,async s=>{
      const ret=await returnFor(s);
      const handoff=await new HandoffService(this.container).presentation(s);
      return {state:ret?.state??(handoff.state==="ATTENTION_REQUIRED"?"ATTENTION_REQUIRED":handoff.state==="ARRIVED"&&handoff.compliance_required?"AGE_VERIFICATION_REQUIRED":"UNAVAILABLE"),financial_review_required:!!ret||await this.priorFinancialReview(s)};
    },true);
  }
  async merchantDocument(identity:string,orderId:string) {
    restrictedParse(resourceId,orderId);
    const marketplace=this.container.resolve<MarketplaceService>("marketplace");
    return withMerchantAuthorization(this.db,marketplace,identity,"MERCHANT_ORDER_VIEW",async(trx,tenant)=>{
      const row=await trx<InvoiceRow>("restricted_delivery_document as doc").join("order_operation as o","o.id","doc.order_operation_id")
        .where({"o.merchant_id":tenant.merchant.id,"doc.medusa_order_id":orderId}).select("doc.*").first();
      if(!row) throw new MedusaError(MedusaError.Types.NOT_FOUND,"Document unavailable.");
      return {document:transportCopy(row.snapshot)};
    });
  }
}
