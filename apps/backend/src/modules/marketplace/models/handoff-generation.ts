import { model } from "@medusajs/framework/utils";
export default model.define("handoff_generation", {
  id: model.id({ prefix: "hgen" }).primaryKey(), delivery_id: model.text(), number: model.number(), nonce: model.text(), key_id: model.text(),
  state: model.enum(["ACTIVE", "SUPERSEDED", "EXHAUSTED", "CONSUMED"]), failed_attempts: model.number().default(0), expires_at: model.dateTime(),
}).indexes([{ on: ["delivery_id", "number"], unique: true }, { on: ["delivery_id"], unique: true, where: "state='ACTIVE'" }]);
