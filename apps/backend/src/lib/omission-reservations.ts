import { z } from "@medusajs/framework/zod";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IInventoryService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { shortageEvidence } from "../modules/marketplace/shortage-policy";
import { financialConflict } from "../modules/marketplace/financial-policy";
import { pickupInput } from "../modules/marketplace/pickup-policy";

const reservations=z.array(z.object({id:z.string(),inventory_item_id:z.string(),quantity:z.number().int().positive()}));
export class OmissionReservations {
  private readonly db:Knex;
  private readonly inventory:IInventoryService;
  constructor(private readonly container:MedusaContainer, db?:Knex) {
    this.db=db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.inventory=container.resolve<IInventoryService>(Modules.INVENTORY);
  }
  async reconcile(id:string) {
    const claim=await this.db.transaction(async trx=>{
      const source=await trx("shortage_resolution as s").join("pick_line as l","l.id","s.pick_line_id")
        .join("pick_session as p","p.id","l.pick_session_id").join("order_operation as o","o.id","p.order_operation_id")
        .join("merchant_store as m","m.id","o.merchant_store_id")
        .where({"s.id":id,"s.status":"RESOLVED_OMITTED","s.financial_review_required":true,"p.status":"COMPLETED","o.status":"ACCEPTED"})
        .whereNull("s.invalidated_at").whereNull("s.deleted_at").whereNull("l.deleted_at").whereNull("p.deleted_at")
        .select("s.evidence","o.id as op","o.medusa_order_id as order","o.checkout_completion_id","m.medusa_stock_location_id as location",
          "l.medusa_order_line_id as line","l.picked_quantity","l.ordered_quantity_at_start","p.id as session").forUpdate("s").first();
      if(!source) throw financialConflict();
      const evidence=shortageEvidence.parse(source.evidence);
      if(!source.location || evidence.native_order_id!==source.order || evidence.native_line_id!==source.line ||
        evidence.checkout_completion_id!==source.checkout_completion_id || evidence.picked!==Number(source.picked_quantity)
        || evidence.ordered!==Number(source.ordered_quantity_at_start)) throw financialConflict();
      const previous=await trx("omission_reservation_release").where({resolution_id:id}).first();
      if(previous) return {row:previous,dispatch:false};
      const delivery=await trx("delivery_operation").where({order_operation_id:source.op}).first();
      const physical=await trx("pick_line").where({pick_session_id:source.session}).whereNull("deleted_at").where("picked_quantity",">",0).first();
      if(physical && (!delivery || !["DELIVERED","RETURNED_TO_STORE"].includes(delivery.status))) return null;
      const native=await this.inventory.listReservationItems({line_item_id:source.line},{take:null});
      const query=this.container.resolve<{graph(i:unknown):Promise<{data:unknown[]}>}>(ContainerRegistrationKeys.QUERY);
      const result=await query.graph({entity:"order",fields:["id","items.id","items.detail.fulfilled_quantity","items.variant.manage_inventory",
        "items.variant.inventory_items.required_quantity","items.variant.inventory_items.inventory.id"],filters:{id:source.order}});
      const orders=z.array(z.object({id:z.string(),items:z.array(z.object({id:z.string(),detail:z.object({fulfilled_quantity:z.coerce.number().int().nonnegative()}),
        variant:z.object({manage_inventory:z.boolean(),inventory_items:z.array(z.object({required_quantity:z.coerce.number().int().positive(),inventory:z.object({id:z.string()})}))}).nullable()}))})).parse(result.data);
      const line=orders[0]?.items.find(l=>l.id===source.line);
      if(orders.length!==1 || orders[0]?.id!==source.order || !line?.variant || line.detail.fulfilled_quantity!==evidence.picked) throw financialConflict();
      const items=line.variant.manage_inventory ? line.variant.inventory_items:[];
      if(native.length!==items.length || line.variant.manage_inventory && !items.length) throw financialConflict();
      const rows=items.map(c=>{
        const r=native.find(row=>row.inventory_item_id===c.inventory.id);
        const quantity=evidence.missing*c.required_quantity;
        if(!r || r.location_id!==source.location || !Number.isSafeInteger(quantity) || Number(r.quantity)!==quantity) throw financialConflict();
        return {id:r.id,inventory_item_id:r.inventory_item_id,quantity};
      });
      if(evidence.picked) {
        const ship=await trx("pickup_operation").where({delivery_id:delivery.id,action:"SHIP",state:"SUCCEEDED"}).first();
        const expected=pickupInput.parse(ship?.input).reservations.filter(r=>r.line_item_id===source.line && r.remaining>0);
        if(expected.length!==rows.length || rows.some(r=>!expected.some(e=>e.id===r.id && e.inventory_item_id===r.inventory_item_id && e.remaining===r.quantity))) throw financialConflict();
      }
      const [row]=await trx("omission_reservation_release").insert({resolution_id:id,order_id:source.order,line_id:source.line,location_id:source.location,
        missing_quantity:evidence.missing,reservations:JSON.stringify(rows),status:rows.length ? "DISPATCHED":"COMPLETED"}).returning("*");
      return {row,dispatch:rows.length>0};
    });
    if(!claim || claim.row.status!=="DISPATCHED") return;
    const ids=reservations.parse(claim.row.reservations).map(r=>r.id);
    if(claim.dispatch) {
      try { await this.inventory.deleteReservationItems(ids); }
      catch { /* Inspect the exact reservation identities before recording the outcome. */ }
    }
    const live=await this.inventory.listReservationItems({id:ids},{take:null});
    if(!live.length || claim.dispatch) await this.db("omission_reservation_release").where({resolution_id:id,status:"DISPATCHED"})
      .update({status:live.length ? "ATTENTION_REQUIRED":"COMPLETED",updated_at:this.db.fn.now()});
    else await this.db("omission_reservation_release").where({resolution_id:id,status:"DISPATCHED"})
      .whereRaw("created_at < clock_timestamp() - interval '2 minutes'").update({status:"ATTENTION_REQUIRED",updated_at:this.db.fn.now()});
  }
}
