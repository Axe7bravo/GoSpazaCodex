import type { MedusaContainer, Logger } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { OmissionReservations } from "../lib/omission-reservations";
export default async function reconcileOmissions(container:MedusaContainer) {
  if(process.env.OMISSION_RESERVATION_WORKER_ENABLED!=="true") return;
  const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const rows=await db("shortage_resolution as s").join("pick_line as l","l.id","s.pick_line_id").join("pick_session as p","p.id","l.pick_session_id")
    .leftJoin("delivery_operation as d","d.order_operation_id","p.order_operation_id").leftJoin("omission_reservation_release as r","r.resolution_id","s.id")
    .where({"s.status":"RESOLVED_OMITTED","p.status":"COMPLETED","s.financial_review_required":true}).whereNull("s.invalidated_at").whereNull("s.deleted_at")
    .where(b=>b.whereIn("d.status",["DELIVERED","RETURNED_TO_STORE"]).orWhereNotExists(db("pick_line as pl").whereRaw("pl.pick_session_id=p.id")
      .whereNull("pl.deleted_at").where("pl.picked_quantity",">",0).select("pl.id")))
    .where(b=>b.whereNull("r.status").orWhere("r.status","DISPATCHED")).select("s.id").orderBy("s.id").limit(20);
  const service=new OmissionReservations(container);
  for(const row of rows) {
    try { await service.reconcile(row.id); }
    catch { container.resolve<Logger>(ContainerRegistrationKeys.LOGGER).warn("Omitted reservation requires inspection: "+row.id); }
  }
}
export const config={name:"gospaza-reconcile-omitted-reservations",schedule:"*/1 * * * *"};
