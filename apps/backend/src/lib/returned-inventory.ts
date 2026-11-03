import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer, IInventoryService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { pickupManifest, pickupInput, type PickupOperation } from "../modules/marketplace/pickup-policy";
import { financialParse, financialConflict } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import type MarketplaceService from "../modules/marketplace/service";
import { NativePickup } from "./pickup-native";

export const dispositionInput=z.object({line_id:resourceId,decision:z.enum(["RESTOCK","NON_SELLABLE"]),confirmed:z.literal(true)}).strict();
const missing=()=>new MedusaError(MedusaError.Types.NOT_FOUND,"Returned inventory unavailable.");
export class ReturnedInventory {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer, db?:Knex) { this.db=db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  async handle(actor:string,delivery:string,value?:unknown) {
    financialParse(resourceId,delivery);
    const command=value===undefined ? undefined:financialParse(dispositionInput,value);
    const claim=await withMerchantAuthorization(this.db,this.container.resolve<MarketplaceService>("marketplace"),actor,"MERCHANT_INVENTORY_MANAGE",async(trx,tenant)=>{
      const d=await trx("delivery_operation").where({id:delivery,merchant_id:tenant.merchant.id,merchant_store_id:tenant.store.id,status:"RETURNED_TO_STORE"}).first();
      if(!d) throw missing();
      const ret=await trx("restricted_return").where({delivery_id:d.id,merchant_store_id:tenant.store.id,state:"RETURNED_TO_STORE",fulfillment_id:d.native_fulfillment_id})
        .whereNotNull("received_by").whereNotNull("returned_at").forUpdate().first();
      if(!ret) throw missing();
      const items=pickupManifest.parse(ret.physical_manifest);
      await trx("returned_inventory_disposition").where({return_id:ret.id,status:"DISPATCHED"})
        .whereRaw("created_at < clock_timestamp() - interval '2 minutes'").update({status:"ATTENTION_REQUIRED",updated_at:trx.fn.now()});
      const decisions=await trx("returned_inventory_disposition").where({return_id:ret.id});
      if(!command) return {view:{items:items.map(item=>{
        const existing=decisions.find(row=>row.line_id===item.id);
        return {line_id:item.id,quantity:item.quantity,decision:existing?.decision ?? null,status:existing?.status ?? "UNDECIDED"};
      })}};
      const item=items.find(i=>i.id===command.line_id);
      if(!item) throw missing();
      const previous=decisions.find(row=>row.line_id===item.id);
      if(previous) {
        if(previous.decision!==command.decision) throw financialConflict();
        return {view:{line_id:item.id,quantity:item.quantity,decision:previous.decision,status:previous.status}};
      }
      const prepare=await trx<PickupOperation>("pickup_operation").where({delivery_id:d.id,action:"PREPARE",state:"SUCCEEDED"}).first();
      const shipped=await trx<PickupOperation>("pickup_operation").where({delivery_id:d.id,action:"SHIP",state:"SUCCEEDED"}).first();
      if(!prepare || !shipped) throw financialConflict();
      const input=pickupInput.parse(shipped.input);
      if(input.order_id!==d.medusa_order_id || input.fulfillment_id!==ret.fulfillment_id ||
        input.items.find(i=>i.id===item.id)?.quantity!==item.quantity) throw financialConflict();
      const verified=await new NativePickup(this.container).validate(shipped,prepare.id);
      if(verified.fulfillment_id!==ret.fulfillment_id) throw financialConflict();
      const changes=input.components.filter(c=>c.line_item_id===item.id && c.inventory_item_id!==null)
        .map(c=>({inventoryItemId:c.inventory_item_id as string,locationId:input.location_id,adjustment:c.quantity}));
      const write=command.decision==="RESTOCK" && changes.length>0;
      const status=write ? "DISPATCHED":"COMPLETED",id="idisp_"+randomUUID();
      await trx("returned_inventory_disposition").insert({id,return_id:ret.id,order_id:d.medusa_order_id,fulfillment_id:ret.fulfillment_id,
        line_id:item.id,quantity:item.quantity,store_id:tenant.store.id,actor_member_id:tenant.membership.id,decision:command.decision,status});
      return {view:{line_id:item.id,quantity:item.quantity,decision:command.decision,status},dispatch:write ? {id,changes}:undefined};
    });
    if(!claim.dispatch) return claim.view;
    let status="COMPLETED";
    try { await this.container.resolve<IInventoryService>(Modules.INVENTORY).adjustInventory(claim.dispatch.changes); }
    catch { status="ATTENTION_REQUIRED"; }
    const [updated]=await this.db("returned_inventory_disposition").where({id:claim.dispatch.id,status:"DISPATCHED"})
      .update({status,updated_at:this.db.fn.now()}).returning("status");
    return {...claim.view,status:updated?.status ?? "ATTENTION_REQUIRED"};
  }
}
