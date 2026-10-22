import { model } from "@medusajs/framework/utils";
export default model.define("dispatch_event", {
  id: model.id({ prefix: "dsevt" }).primaryKey(), target_id: model.text(), target_type: model.enum(["DELIVERY","AVAILABILITY","CONFIGURATION"]), revision: model.number(), action: model.text(), actor_type: model.enum(["driver","user","system"]), actor_id: model.text().nullable(), occurred_at: model.dateTime(), evidence: model.json(),
}).indexes([{ on: ["target_type","target_id","revision"], unique: true }]);
