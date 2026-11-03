import { model } from "@medusajs/framework/utils";
export default model.define("provider_refund_attempt", {
  id: model.id({ prefix: "rfat" }).primaryKey(), refund_operation_id: model.text(), attempt_number: model.number(),
  idempotency_key: model.text(), request_json: model.text(), request_fingerprint: model.text(), request_version: model.text(),
  status: model.text(), provider_refund_id: model.text().nullable(), first_sent_at: model.dateTime().nullable(),
  lease_until: model.dateTime().nullable(), verified_event_id: model.text().nullable(), response_status: model.number().nullable(),
});
