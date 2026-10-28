import { model } from "@medusajs/framework/utils";
export default model.define("dispatch_commitment", {
  id: model.id({ prefix: "dcommit" }).primaryKey(), delivery_id: model.text(), driver_profile_id: model.text(), generation: model.number(), path: model.enum(["MERCHANT","PLATFORM"]), status: model.enum(["OFFERED","ASSIGNED","DECLINED","EXPIRED","CANCELLED","COMPLETED","RETURNED"]), revision: model.number().default(1), availability_generation: model.text(), affiliation_id: model.text(), profile_revision: model.number(), affiliation_revision: model.number(), expires_at: model.dateTime(), assigned_at: model.dateTime().nullable(), decided_at: model.dateTime().nullable(), reason: model.text().nullable(),
}).indexes([
  { on: ["delivery_id","generation","driver_profile_id"], unique: true },
  { on: ["driver_profile_id"], unique: true, where: "status in ('OFFERED','ASSIGNED')" },
  { on: ["delivery_id"], unique: true, where: "status in ('OFFERED','ASSIGNED')" },
]);
