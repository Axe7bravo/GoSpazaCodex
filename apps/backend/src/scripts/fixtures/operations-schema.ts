import type { Knex } from "@medusajs/framework/mikro-orm/knex";
// Source contract inputs are isolated, not a rewrite of earlier milestone
// lifecycle verifiers. The dispatch/rescue core keeps installed constraints.
export const operationsCoreTables = ["delivery_operation", "dispatch_commitment", "dispatch_event", "driver_availability", "store_dispatch_configuration", "dispatch_work", "delivery_rescue_command"];
export const operationsInputTables = ["merchant", "merchant_store", "merchant_application", "merchant_application_document", "merchant_application_review", "driver_profile", "driver_affiliation", "driver_event",
  "checkout_completion", "checkout_attempt", "delivery_reservation", "cart_marketplace_context", "order_operation", "pick_session", "pick_line", "pick_event", "shortage_resolution", "order_decision_event",
  "pickup_operation", "delivery_completion", "restricted_return", "handoff_generation", "recipient_compliance", "driver_compensation_snapshot", "driver_compensation_activation", "driver_compensation_terms",
  "financial_adjustment", "refund_operation", "store_credit_operation", "returned_inventory_disposition", "order_finance_snapshot", "order_finance_exception", "merchant_period_statement", "payable_settlement",
  "merchant_settlement_discrepancy", "settlement_exclusion", "driver_payment", "driver_payment_resolution", "driver_payment_reconciliation", "driver_payment_discrepancy", "driver_earning_exception", "driver_compensation_exception",
  "notification_intent", "notification_delivery", "restricted_registration", "financial_adjustment_event", "restricted_event", "order_operation_repair_cursor", "pickup_work", "provider_operation", "omission_reservation_release",
  "notification_worker_health", "notification_attempt", "notification_attempt_started", "notification_attempt_result", "notification_webhook_receipt", "notification_runtime_observation",
  "marketplace_service_zone", "merchant_store_service_zone", "delivery_option_configuration", "delivery_slot", "service_zone_event"];
export const operationsEvidenceTables = [...operationsInputTables, ...operationsCoreTables];
export async function createOperationsSchema(root: Knex, db: Knex, schema: string) {
  await root.raw("create schema ??", [schema]);
  await db.raw("create table m23_acceptance_marker(run text primary key,version integer not null)");
  for (const table of operationsEvidenceTables) {
    await db.raw(`create table ??.?? (like public.?? ${operationsCoreTables.includes(table) ? "including all" : "including defaults"})`, [schema, table, table]);
    if (!operationsCoreTables.includes(table)) {
      const columns = await root("information_schema.columns").where({ table_schema: "public", table_name: table, is_nullable: "NO" }).select("column_name");
      for (const column of columns) await db.raw("alter table ??.?? alter column ?? drop not null", [schema, table, column.column_name]);
      const hasId = await root("information_schema.columns").where({ table_schema: "public", table_name: table, column_name: "id" }).first();
      if (hasId) await db.raw("alter table ??.?? add unique(id)", [schema, table]);
    }
  }
  await db.raw("alter table merchant_store add unique(id,merchant_id)");
  for (const table of operationsCoreTables) {
    const constraints = await root.raw("select conname,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid=?::regclass and contype='f'", ["public." + table]);
    for (const constraint of constraints.rows) await db.raw(`alter table ??.?? add constraint ?? ${String(constraint.definition).replaceAll("public.", schema + ".")}`, [schema, table, constraint.conname]);
  }
  for (const fn of ["gospaza_delivery_rescue_transition(delivery_operation,delivery_operation)", "gospaza_dispatch_guard()", "gospaza_dispatch_consistency()", "gospaza_rescue_guard()", "gospaza_rescue_consistency()", "gospaza_driver_comp_selection(timestamp with time zone)"]) {
    const { rows: [row] } = await root.raw("select pg_get_functiondef(?::regprocedure) as definition", ["public." + fn]);
    await db.raw(String(row.definition).replaceAll("public.", schema + "."));
  }
  for (const table of ["delivery_operation", "dispatch_commitment", "driver_availability", "store_dispatch_configuration", "dispatch_event"]) {
    await db.raw(`create trigger acceptance_guard before ${table === "dispatch_event" ? "update" : "insert or update"} on ?? for each row execute function gospaza_dispatch_guard()`, [table]);
    if (table !== "dispatch_event") await db.raw("create constraint trigger acceptance_consistency after insert or update on ?? deferrable initially deferred for each row execute function gospaza_dispatch_consistency()", [table]);
  }
  await db.raw("create trigger receipt_guard before insert or update or delete on delivery_rescue_command for each row execute function gospaza_rescue_guard()");
  await db.raw("create trigger generation_guard before insert or update on delivery_operation for each row execute function gospaza_rescue_guard()");
  await db.raw("create constraint trigger receipt_consistency after insert on delivery_rescue_command deferrable initially deferred for each row execute function gospaza_rescue_consistency()");
  await db.raw("create constraint trigger rescue_consistency after update on delivery_operation deferrable initially deferred for each row execute function gospaza_rescue_consistency()");
}
