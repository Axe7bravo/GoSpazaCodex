import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { z } from "@medusajs/framework/zod";
import { checkoutAddress } from "../modules/marketplace/checkout-policy";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import { readOperationalOrder } from "./order-operation-native";
import { physicalManifest, pickupManifest } from "../modules/marketplace/pickup-policy";
import { deliveryDocumentPolicy, recipientConflict } from "../modules/marketplace/recipient-policy";
import { RestrictedCommerce } from "./restricted-commerce";

export const deliveryInvoice = z.object({ document_number: z.string(), policy_version: z.string(),
  order_id: z.string(), order_reference: z.string(), ordered_at: z.string(), address: checkoutAddress,
  merchant_id: z.string(), merchant_store_id: z.string(), seller_name: z.string(),
  premises: z.object({ address_line_1: z.string(), address_line_2: z.string(), city: z.string(), province: z.string(), postal_code: z.string(), country_code: z.string() }),
  registration_id: z.string(), registration_number: z.string(), registration_category: z.string(),
  physical_manifest: pickupManifest,
  goods: z.array(z.object({ line_id: z.string(), variant_id: z.string(), description: z.string(), sku: z.string().nullable(), quantity: z.number().int().positive() })),
}).strict();
export type DeliveryInvoice = z.infer<typeof deliveryInvoice>;
export interface InvoiceRow { id: string; order_operation_id: string; medusa_order_id: string; snapshot: DeliveryInvoice }

export class RestrictedDeliveryDocument {
  constructor(private readonly container: MedusaContainer) {}
  async ensure(trx: Knex.Transaction, operationId: string, handoff: CompletedOrderHandoff,
    physical: { id: string; ordered: number; picked: number; omitted: number }[]) {
    const policy = deliveryDocumentPolicy(), restriction = handoff.snapshot.restricted_commerce;
    if (!policy || !restriction?.restricted_content_present) throw recipientConflict();
    const authority = await new RestrictedCommerce(this.container).supplyAuthority(trx,handoff.merchant_store_id,restriction.classifications,"dispatch");
    if (authority.registration.id !== restriction.registration_id) throw recipientConflict();
    const order = await readOperationalOrder(this.container,handoff), manifest = physicalManifest(physical);
    const orderedAt = new Date(order.created_at);
    if (!Number.isFinite(orderedAt.getTime()) || orderedAt > authority.now) throw recipientConflict();
    const address = z.record(z.string(),z.unknown()).parse(order.shipping_address);
    if (Object.entries(handoff.snapshot.address).some(([key,value]) => (address[key] ?? "") !== value)) throw recipientConflict();
    const existing = await trx<InvoiceRow>("restricted_delivery_document").where({ order_operation_id: operationId }).first();
    if (existing) {
      const saved = deliveryInvoice.parse(existing.snapshot);
      // JSONB key order is irrelevant. Native address/physical identity must remain exact.
      if (saved.order_id !== order.id || saved.merchant_store_id !== handoff.merchant_store_id
        || saved.registration_number !== authority.submission.registration_number || saved.registration_category !== authority.submission.category
        || Object.entries(saved.premises).some(([key,value]) => authority.store[key as keyof typeof authority.store] !== value)
        || JSON.stringify(saved.physical_manifest.map(i => [i.id,i.quantity])) !== JSON.stringify(manifest.map(i => [i.id,i.quantity]))
        || Object.entries(saved.address).some(([key,value]) => address[key] !== value && !(value === "" && address[key] == null))) throw recipientConflict();
      return existing;
    }
    const merchant = await trx<{ legal_name: string }>("merchant").where({ id: handoff.merchant_id }).first();
    if (!merchant?.legal_name) throw recipientConflict();
    const id = "rdoc_"+randomUUID();
    const goods = manifest.flatMap(line => {
      const item = order.items?.find(i => i.id === line.id);
      if (!item?.variant_id) throw recipientConflict();
      const classification = restriction.classifications.find(c => c.variant_id === item.variant_id);
      if (!classification) throw recipientConflict();
      return classification.restriction === "ALCOHOL" ? [{ line_id: item.id, variant_id: item.variant_id,
        description: item.title + (item.variant_title ? " — " + item.variant_title : ""), sku: item.variant_sku ?? null, quantity: line.quantity }] : [];
    });
    const s = authority.store;
    const snapshot = deliveryInvoice.parse({ document_number: id, policy_version: policy.version, order_id: order.id,
      order_reference: String(order.display_id), ordered_at: orderedAt.toISOString(), address: handoff.snapshot.address,
      merchant_id: handoff.merchant_id, merchant_store_id: s.id, seller_name: merchant.legal_name,
      premises: { address_line_1:s.address_line_1,address_line_2:s.address_line_2,city:s.city,province:s.province,postal_code:s.postal_code,country_code:s.country_code },
      registration_id: authority.registration.id, registration_number: authority.submission.registration_number,
      registration_category: authority.submission.category, physical_manifest: manifest, goods });
    await trx("restricted_delivery_document").insert({ id,order_operation_id:operationId,medusa_order_id:order.id,snapshot:JSON.stringify(snapshot) });
    await new RestrictedCommerce(this.container).event(trx,s,"document-policy",id,"DELIVERY_DOCUMENT_RETAINED",{ order_id:order.id,policy_version:policy.version });
    return { id,order_operation_id:operationId,medusa_order_id:order.id,snapshot };
  }
}
