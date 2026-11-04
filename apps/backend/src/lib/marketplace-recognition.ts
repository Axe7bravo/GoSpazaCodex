import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { financialParse, lineAllocations } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { physicalManifest, pickupInput } from "../modules/marketplace/pickup-policy";
import { recognitionEvidence, recognizeManifest, RecognitionConflict, adjustmentAllocations } from "../modules/marketplace/recognition-policy";
import { COMMISSION_POLICY } from "../modules/marketplace/commission-policy";
import { PickingService } from "./picking-service";

function proven(value:unknown):asserts value {
  if (!value) throw new RecognitionConflict("RECOGNITION_EVIDENCE_MISMATCH");
}
export async function saleLifecycle(trx:Knex.Transaction,container:MedusaContainer,op:{id:string;status:string;rejected_at:unknown},posted:boolean,hasSnapshot:boolean) {
  const delivery=await trx("delivery_operation").where({order_operation_id:op.id}).whereNull("deleted_at").first();
  if(posted && delivery?.status!=="DELIVERED") throw new RecognitionConflict("POSTING_SOURCE_CONFLICT");
  if(op.status==="REJECTED") {
    proven(!posted && !delivery?.delivered_at && op.rejected_at && await trx("order_decision_event")
      .where({order_operation_id:op.id,to_status:"REJECTED"}).whereNull("deleted_at").first());
    return {state:"KNOWN_ZERO",reason:"MERCHANT_REJECTED"} as const;
  }
  const returned=delivery && await trx("restricted_return").where({delivery_id:delivery.id}).whereNull("deleted_at").first();
  if(returned) {
    proven(!posted && !delivery.delivered_at && await trx("recipient_compliance")
      .where({id:returned.compliance_id,delivery_id:delivery.id,outcome:"FAILED"}).first());
    return {state:"KNOWN_ZERO",reason:"FAILED_RESTRICTED_HANDOFF"} as const;
  }
  if(delivery?.status==="DELIVERED" && !hasSnapshot) return {state:"SNAPSHOT_REQUIRED"} as const;
  const session=await trx("pick_session").where({order_operation_id:op.id,status:"COMPLETED"}).whereNull("deleted_at").first();
  if(!session) { proven(delivery?.status!=="DELIVERED"); return {state:"PENDING"} as const; }
  if(delivery?.status!=="DELIVERED" && await trx("pick_line").where({pick_session_id:session.id})
    .whereNull("deleted_at").where("picked_quantity",">",0).first()) return {state:"PENDING"} as const;
  proven(op.status==="ACCEPTED");
  const picking=await new PickingService(container).completedForRecognition(trx,op.id);
  const manifest=physicalManifest(picking.physical);
  if(!manifest.length) {
    proven(delivery?.status!=="DELIVERED");
    return {state:"KNOWN_ZERO",reason:"FULL_UNFULFILLABLE"} as const;
  }
  if(delivery?.status!=="DELIVERED") return {state:"PENDING"} as const;
  return {state:"DELIVERED",delivery,session,picking,manifest} as const;
}
export class MarketplaceRecognition {
  private readonly db:Knex;
  constructor(private readonly container:MedusaContainer, db?:Knex) {
    this.db=db??container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  async recognize(order:string) {
    financialParse(resourceId,order);
    const initial=await this.db("order_operation").where({medusa_order_id:order}).whereNull("deleted_at").first();
    if(!initial) return {state:"NO_ORDER"} as const;
    return this.db.transaction(async trx=>{
      await trx("merchant").where({id:initial.merchant_id}).forUpdate().first();
      const op=await trx("order_operation").where({id:initial.id,merchant_id:initial.merchant_id,medusa_order_id:order}).whereNull("deleted_at").forUpdate().first();
      if(!op) return {state:"NO_ORDER"} as const;
      const snapshot=await trx("order_finance_snapshot").where({order_operation_id:op.id}).forUpdate().first();
      const posted=snapshot && await trx("marketplace_finance_posting").where({snapshot_id:snapshot.id}).first();
      try {
        const lifecycle=await saleLifecycle(trx,this.container,op,!!posted,!!snapshot);
        if(lifecycle.state!=="DELIVERED") return lifecycle;
        const {delivery,session,picking,manifest}=lifecycle;
        if(!snapshot) return {state:"SNAPSHOT_REQUIRED"} as const;
        if(snapshot.state!=="RESOLVED" || await trx("order_finance_exception").where({snapshot_id:snapshot.id}).first())
          return {state:"UNRESOLVED"} as const;
        proven(snapshot.policy_version===COMMISSION_POLICY && snapshot.currency==="zar" && snapshot.order_id===order
          && snapshot.merchant_id===op.merchant_id && snapshot.store_id===op.merchant_store_id
          && delivery.medusa_order_id===order && delivery.merchant_id===op.merchant_id && delivery.merchant_store_id===op.merchant_store_id
          && delivery.pick_session_id===session.id && delivery.delivered_at);
        const completion=await trx("delivery_completion").where({delivery_id:delivery.id,state:"SUCCEEDED",native_done:true}).whereNull("deleted_at").first();
        proven(completion && completion.receipt?.delivered_at && completion.receipt.fulfillment_id===delivery.native_fulfillment_id);
        const ship=await trx("pickup_operation").where({id:completion.ship_operation_id,delivery_id:delivery.id,action:"SHIP",state:"SUCCEEDED",
          fulfillment_id:delivery.native_fulfillment_id}).whereNull("deleted_at").first();
        const input=pickupInput.safeParse(ship?.input);
        proven(input.success && input.data.order_id===order && input.data.commitment_id===completion.commitment_id
          && input.data.picking_fingerprint===picking.session.source_lines_fingerprint
          && JSON.stringify(input.data.items)===JSON.stringify(manifest));
        proven(await trx("dispatch_commitment").where({id:completion.commitment_id,delivery_id:delivery.id,status:"COMPLETED"}).first());
        const event=await trx("dispatch_event").where({target_type:"DELIVERY",target_id:delivery.id,action:"DELIVERED"}).first();
        proven(event && event.evidence?.commitment_id===completion.commitment_id);
        const frozen=recognitionEvidence.safeParse(snapshot.evidence);
        proven(frozen.success && frozen.data.lines.length===picking.physical.length);
        const evidence=frozen.data;
        for(const p of picking.physical) proven(evidence.lines.some(l=>l.id===p.id && l.quantity===p.ordered));
        // M18 can materialize an entitlement after recognition. Its omitted
        // range must be exactly the suffix already excluded by physical picking.
        const adjustments=await trx("financial_adjustment").where({order_operation_id:op.id,status:"APPROVED"}).orderBy("id");
        for(const a of adjustments) {
          if(a.reason==="GOODWILL") continue;
          if(a.reason!=="ITEM_OMITTED" || a.financial_cause!=="MERCHANT" || a.source_type!=="TERMINAL_OMISSION")
            throw new RecognitionConflict("UNRESOLVED_ADJUSTMENT_ATTRIBUTION");
          const parsed=adjustmentAllocations.safeParse(a.allocations);
          proven(parsed.success && a.economics_fingerprint===evidence.native_economics_fingerprint);
          const first=parsed.data[0], physical=picking.physical.find(p=>p.id===first?.economic_key);
          const line=evidence.lines.find(l=>l.id===physical?.id);
          proven(physical && line && physical.omitted>0 && await trx("shortage_resolution as r")
            .join("pick_line as l","l.id","r.pick_line_id").where({"r.id":a.source_id,"r.revision":a.source_revision,
              "r.status":"RESOLVED_OMITTED","l.medusa_order_line_id":line.id,"l.pick_session_id":session.id})
            .whereNull("r.invalidated_at").whereNull("r.deleted_at").first());
          const expected=lineAllocations(line,physical.picked,physical.ordered);
          proven(parsed.data.length===expected.length && expected.every(e=>parsed.data.some(a=>a.component===e.component
            && a.economic_key===e.economic_key && a.start_unit===e.start_unit && a.end_unit===e.end_unit && a.amount_minor===e.amount_minor)));
        }
        const result=recognizeManifest(evidence,manifest,snapshot.basis_points);
        const at=new Date(delivery.delivered_at);
        const fingerprint=createHash("sha256").update(JSON.stringify([snapshot.fingerprint,snapshot.rule_id,completion.id,
          completion.receipt.fulfillment_id,ship.id,session.id,event.id,event.revision,at.toISOString(),result])).digest("hex");
        if(posted) {
          if(posted.source_fingerprint!==fingerprint) throw new RecognitionConflict("POSTING_SOURCE_CONFLICT");
          return {state:"RECOGNIZED",id:String(posted.id)} as const;
        }
        const id="mfp_"+randomUUID();
        await trx("marketplace_finance_posting").insert({id,snapshot_id:snapshot.id,kind:"DELIVERY_RECOGNITION",
          completion_id:completion.id,event_id:event.id,source_revision:event.revision,rule_id:snapshot.rule_id,
          policy_version:"M19_C_V1",economic_at:at,...result.effects,units:JSON.stringify(result.ranges),source_fingerprint:fingerprint});
        return {state:"RECOGNIZED",id} as const;
      } catch(error) {
        const reason=error instanceof RecognitionConflict ? error.reason :
          MedusaError.isMedusaError(error) && ["PICKING_CONFLICT","FINANCIAL_EVIDENCE_CONFLICT","PICKUP_UNAVAILABLE"].includes(error.code??"")
            ? "RECOGNITION_EVIDENCE_MISMATCH":null;
        if(!reason || !snapshot) throw error;
        await trx("order_finance_exception").insert({id:"fexc_"+randomUUID(),snapshot_id:snapshot.id,reason,source_id:op.id})
          .onConflict(["snapshot_id","reason","source_id"]).ignore();
        return {state:"UNRESOLVED",reason} as const;
      }
    });
  }
  async repair(after?:string,through?:string) {
    const page=this.db("order_finance_snapshot as s").join("delivery_operation as d","d.order_operation_id","s.order_operation_id")
      .where({"s.state":"RESOLVED","d.status":"DELIVERED"}).whereNull("d.deleted_at");
    if(after) page.where("s.id",">",financialParse(resourceId,after));
    if(through) page.where("s.id","<=",financialParse(resourceId,through));
    const rows=await page.select("s.id","s.order_id").orderBy("s.id").limit(25);
    let unresolved=0;
    const deferred:string[]=[];
    for(const row of rows) {
      try { if((await this.recognize(row.order_id)).state==="UNRESOLVED") unresolved++; }
      catch { deferred.push(row.id); }
    }
    return {examined:rows.length,unresolved,deferred,next_cursor:rows.length===25?rows.at(-1)?.id:null};
  }
}
