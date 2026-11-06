import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { NotificationFoundation } from "../lib/notification-foundation";
import { NotificationMappings } from "../lib/notification-mappings";
import { NotificationConflict } from "../lib/notification-policy";
import type { NotificationActors } from "../lib/notification-recipients";
import { checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import { notificationSql } from "../modules/marketplace/notification-schema";
import { notificationMappingSql } from "../modules/marketplace/notification-mapping-schema";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import { notificationSignal } from "../subscribers/notification-discovery";

// Source-contract fixtures, not a repeat of M8–M21 domain/native acceptance.
// Real PostgreSQL executes the production source joins, strict M10 parser,
// picking evidence reader, currentness locks, audience freeze and B constraints.
// Native identity/Order reads are controlled at their existing module boundary;
// no public domain/finance records, provider calls or source guards are modified.
const fixtureTables: Record<string, string> = {
  merchant: "source_application_id text,status text", merchant_store: "merchant_id text,active boolean default true",
  merchant_application: "status text,applicant_identity_id text", merchant_member: "merchant_id text,auth_identity_id text,member_type text,status text",
  fixture_actor: "active boolean default true", fixture_order: "customer_id text,contact text,registered boolean default true,reference text",
  cart_marketplace_context: "medusa_cart_id text,merchant_id text,merchant_store_id text",
  checkout_attempt: "reservation_id text,cart_context_id text,medusa_cart_id text,state text,closed_at timestamptz,payment_accepted_at timestamptz,snapshot jsonb",
  checkout_completion: "checkout_attempt_id text,state text,native_state text,order_id text,terminal_receipt jsonb,workflow_id text,transaction_id text,execution_id text,run_id text",
  delivery_reservation: "status text,release_reason text,medusa_order_id text,cart_context_id text,merchant_store_id text,delivery_slot_id text,payment_accepted_at timestamptz,released_at timestamptz",
  order_operation: "medusa_order_id text,checkout_completion_id text,merchant_id text,merchant_store_id text,status text,revision integer default 0,rejected_at timestamptz",
  order_decision_event: "order_operation_id text,merchant_id text,merchant_store_id text,to_status text,decided_at timestamptz",
  pick_session: "order_operation_id text,status text,assigned_member_id text,revision integer default 1,completed_at timestamptz",
  pick_event: "pick_session_id text,revision integer,action text,occurred_at timestamptz",
  pick_line: "pick_session_id text,medusa_order_line_id text,ordered_quantity_at_start integer,picked_quantity integer,shortage_recorded boolean",
  shortage_resolution: "pick_session_id text,pick_line_id text,status text,invalidated_at timestamptz,evidence jsonb,financial_review_required boolean,resolved_at timestamptz",
  driver_profile: "auth_identity_id text,status text,revision integer default 1", driver_affiliation: "driver_profile_id text,revision integer default 1",
  delivery_operation: "order_operation_id text,medusa_order_id text,merchant_id text,merchant_store_id text,pick_session_id text,status text,revision integer,generation integer,native_fulfillment_id text,picked_up_at timestamptz,delivered_at timestamptz",
  dispatch_commitment: "delivery_id text,driver_profile_id text,generation integer,status text,expires_at timestamptz,profile_revision integer,affiliation_revision integer,affiliation_id text",
  dispatch_event: "target_type text,target_id text,revision integer,action text,occurred_at timestamptz,evidence jsonb",
  pickup_operation: "delivery_id text,action text,state text,native_state text,fulfillment_id text,terminal_receipt jsonb",
  delivery_completion: "delivery_id text,commitment_id text,ship_operation_id text,state text,native_done boolean,receipt jsonb",
  restricted_return: "delivery_id text,merchant_store_id text,commitment_id text,state text,failed_at timestamptz,started_at timestamptz,received_by text,returned_at timestamptz,physical_manifest jsonb",
  restricted_event: "target_id text,action text,actor_id text", returned_inventory_disposition: "return_id text,line_id text,status text",
  financial_adjustment: "medusa_order_id text,customer_id text,merchant_id text,merchant_store_id text,status text,default_method text,amount_minor bigint",
  financial_settlement: "adjustment_id text,method text,amount_minor bigint,currency text,state text",
  store_credit_operation: "adjustment_id text,settlement_id text,order_id text,customer_id text,store_id text,amount_minor bigint,currency text,status text,revision integer,settled_at timestamptz,account_id text,native_transaction_id text",
  refund_operation: "adjustment_id text,settlement_id text,order_id text,customer_id text,store_id text,amount_minor bigint,currency text,status text,revision integer,settled_at timestamptz,native_refund_id text,order_transaction_id text,current_attempt_id text",
  refund_event: "refund_operation_id text,revision integer,status text", provider_refund_attempt: "refund_operation_id text,status text,verified_event_id text,provider_refund_id text",
  merchant_period_statement: "merchant_id text,store_id text,status text,superseded_by text", payable_settlement: "statement_id text,amount_minor bigint,status text,revision integer",
  settlement_transition_audit: "statement_id text,action text,recorded_at timestamptz", merchant_settlement_command: "payable_id text,action text,new_revision integer,recorded_at timestamptz",
  merchant_payout_receipt: "command_id text,payable_id text,statement_id text,merchant_id text,store_id text,amount_minor bigint,currency text",
  merchant_payout_failure: "command_id text,payable_id text", merchant_settlement_discrepancy: "command_id text,payable_id text,status text",
  driver_payment: "driver_profile_id text,payer text,currency text,amount_minor bigint,initial_outcome text",
  driver_payment_command: "payment_id text,action text,recorded_at timestamptz",
  driver_payment_discrepancy: "payment_id text,command_id text", order_finance_exception: "snapshot_id text,recorded_at timestamptz", driver_earning_exception: "delivery_id text,recorded_at timestamptz",
};

export interface NotificationMappingFixture {
  db: Knex; mappings: NotificationMappings; foundation: NotificationFoundation; actors: NotificationActors; env: NodeJS.ProcessEnv; clock: Date;
  seedOrder: (name: string, at?: Date, contact?: string | null) => Promise<{ order: string; customer: string }>;
}
export default async function verifyNotificationMappings({ container }: ExecArgs, runtimeProof?: (fixture: NotificationMappingFixture) => Promise<void>) {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || new URL(process.env.REDIS_URL ?? "").pathname !== "/1") throw Error("Use the selected _test database and Redis /1.");
  const base = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("notification_mapping_audience"), "Apply the M22-C forward migration first.");
  const schema = "m22c_verify_" + randomUUID().replaceAll("-", "");
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 10 } });
  let created = false;
  try {
    await base.raw("create schema ??", [schema]); created = true;
    for (const sql of [...notificationSql, ...notificationMappingSql]) await db.raw(sql);
    await db.raw("create table fixture_clock(instant timestamptz not null)");
    const clock = new Date("2030-01-01T00:00:01.000Z"), previous = new Date("2029-12-31T00:00:00Z");
    await db("fixture_clock").insert({ instant: clock });
    await db.raw(`create or replace function gospaza_notification_now() returns timestamptz as $fixture$
      begin return (select instant from fixture_clock); end; $fixture$ language plpgsql`);
    for (const [table, columns] of Object.entries(fixtureTables)) await db.raw(`create table ?? (id text primary key,deleted_at timestamptz,
      created_at timestamptz default gospaza_notification_now(),updated_at timestamptz default gospaza_notification_now(),${columns})`, [table]);
    await db.raw("create table store_credit_operation_event(operation_id text,revision integer,status text,occurred_at timestamptz)");
    await db.raw("create table driver_payment_item(payment_id text,earning_id text,amount_minor bigint,primary key(payment_id,earning_id))");
    await db.raw("create table driver_payment_allocation(payment_id text,earning_id text primary key,driver_profile_id text,payer text,currency text,amount_minor bigint)");
    await db.raw("create table driver_payment_resolution(payment_id text primary key,outcome text,command_id text)");
    await db.raw("create table driver_payment_reconciliation(payment_id text primary key,command_id text)");
    const env = { APP_ENV: "test", NOTIFICATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "fixture-key", RESEND_FROM_EMAIL: "sender@example.test",
      NOTIFICATION_AUDIENCE_CUSTOMER_FINANCE_USER_IDS: "operator", FINANCIAL_VIEW_USER_IDS: "operator,unrelated", FINANCIAL_EXECUTE_REFUND_USER_IDS: "operator,unrelated",
      FINANCIAL_ISSUE_STORE_CREDIT_USER_IDS: "operator", NOTIFICATION_AUDIENCE_DRIVER_PAYMENT_USER_IDS: "operator", DRIVER_EARNINGS_VIEW_USER_IDS: "operator",
      DRIVER_PAYMENT_RECORD_USER_IDS: "operator", NOTIFICATION_AUDIENCE_SETTLEMENT_USER_IDS: "operator", SETTLEMENT_VIEW_USER_IDS: "operator", SETTLEMENT_APPROVE_USER_IDS: "operator" };
    for (const user of ["operator", "unrelated", "driver_identity", "foreign_driver_identity", "identity_OWNER", "identity_MANAGER", "identity_PICKER", "identity_REVOKED", "identity_FOREIGN"])
      await db("fixture_actor").insert({ id: user });
    await db("merchant").insert([{ id: "merchant", status: "ACTIVE", source_application_id: "application" }, { id: "foreign_merchant", status: "ACTIVE", source_application_id: "foreign_application" }]);
    await db("merchant_store").insert([{ id: "store", merchant_id: "merchant" }, { id: "foreign_store", merchant_id: "foreign_merchant" }]);
    await db("merchant_application").insert([{ id: "application", status: "APPROVED", applicant_identity_id: "identity_OWNER" }, { id: "foreign_application", status: "APPROVED", applicant_identity_id: "identity_FOREIGN" }]);
    for (const role of ["OWNER", "MANAGER", "PICKER", "REVOKED", "FOREIGN"]) await db("merchant_member").insert({ id: "member_" + role,
      merchant_id: role === "FOREIGN" ? "foreign_merchant" : "merchant", auth_identity_id: "identity_" + role,
      member_type: ["REVOKED", "FOREIGN"].includes(role) ? "OWNER" : role, status: role === "REVOKED" ? "INACTIVE" : "ACTIVE" });
    await db("driver_profile").insert([{ id: "driver", auth_identity_id: "driver_identity", status: "ACTIVE", revision: 1 },
      { id: "foreign_driver", auth_identity_id: "foreign_driver_identity", status: "ACTIVE", revision: 1 }]);
    await db("driver_affiliation").insert({ id: "affiliation", driver_profile_id: "driver", revision: 1 });
    const actors: NotificationActors = {
      order: async (handoff: CompletedOrderHandoff) => {
        const row = await db("fixture_order").where({ id: handoff.order_id, customer_id: handoff.snapshot.customer_id }).first();
        if (!row) throw new NotificationConflict();
        return { id: row.id, customerId: row.customer_id, registered: row.registered, contact: row.contact, reference: row.reference,
          lines: [{ id: "native_line", quantity: 1 }] };
      },
      merchant: async (memberId, trx) => {
        const runner = trx ?? db;
        const row = await runner("merchant_member as mm").join("merchant as m", "m.id", "mm.merchant_id").join("merchant_store as s", "s.merchant_id", "m.id")
          .join("merchant_application as a", "a.id", "m.source_application_id").join("fixture_actor as f", "f.id", "mm.auth_identity_id")
          .where({ "mm.id": memberId, "mm.status": "ACTIVE", "m.status": "ACTIVE", "a.status": "APPROVED", "f.active": true }).whereNull("mm.deleted_at")
          .select("mm.id", "mm.auth_identity_id", "mm.member_type", "m.id as merchant_id", "s.id as store_id").first();
        return row ? { memberId: row.id, identity: row.auth_identity_id, role: row.member_type, merchantId: row.merchant_id, storeId: row.store_id } : null;
      },
      driver: async (profile, fact) => !!await db("driver_profile as p").join("fixture_actor as a", "a.id", "p.auth_identity_id")
        .where({ "p.id": profile, "a.active": true }).modify(q => { if (fact.operationalDriver) q.where("p.status", "ACTIVE"); }).first(),
      user: async user => !!await db("fixture_actor").where({ id: user, active: true }).first(),
    };
    const mappings = new NotificationMappings(container, { db, actors, env });
    const foundation = new NotificationFoundation(db, env, async actor => actor === "operator");
    const seedOrder = async (name: string, at = clock, contact: string | null = "customer@example.test") => {
      const ids = { order: "order_" + name, customer: "customer_" + name, cart: "cart_" + name, context: "context_" + name, completion: "completion_" + name,
        attempt: "attempt_" + name, reservation: "reservation_" + name, operation: "operation_" + name };
      const snapshot = checkoutSnapshot.parse({ customer_id: ids.customer, cart_id: ids.cart, cart_context_id: ids.context, merchant_id: "merchant", merchant_store_id: "store",
        address_id: "address", address: { first_name: "Synthetic", last_name: "Customer", address_1: "1 Fixture Road", address_2: "", city: "City", province: "FS", postal_code: "9301", country_code: "za", phone: "" },
        reservation_id: ids.reservation, reservation_revision: 1, configuration_revision: 1, delivery_option_id: "option", shipping_option_id: "shipping", shipping_method_id: "method",
        currency_code: "zar", totals: { total_minor: 10000, subtotal_minor: 10000, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 0 },
        items: [{ id: "cartline", variant_id: "variant", quantity: 1, unit_price_minor: 10000, total_minor: 10000 }] });
      await db("fixture_order").insert({ id: ids.order, customer_id: ids.customer, contact, reference: "123" });
      await db("cart_marketplace_context").insert({ id: ids.context, medusa_cart_id: ids.cart, merchant_id: "merchant", merchant_store_id: "store" });
      await db("delivery_reservation").insert({ id: ids.reservation, status: "COMMITTED", medusa_order_id: ids.order, cart_context_id: ids.context, merchant_store_id: "store", delivery_slot_id: "slot", payment_accepted_at: at });
      await db("checkout_attempt").insert({ id: ids.attempt, reservation_id: ids.reservation, cart_context_id: ids.context, medusa_cart_id: ids.cart, state: "COMPLETED", closed_at: at, payment_accepted_at: at, snapshot: JSON.stringify(snapshot) });
      await db("checkout_completion").insert({ id: ids.completion, checkout_attempt_id: ids.attempt, state: "SUCCEEDED", native_state: "done", order_id: ids.order,
        workflow_id: "complete-cart", transaction_id: name + "_transaction", execution_id: name + "_execution", run_id: name + "_run", terminal_receipt: JSON.stringify({
          order_id: ids.order, cart_id: ids.cart, payment_id: "payment", capture_id: "capture", payment_collection_id: "collection", amount_minor: 10000, currency: "zar",
          workflow_id: "complete-cart", transaction_id: name + "_transaction", execution_id: name + "_execution", run_id: name + "_run", verified_at: at.toISOString() }) });
      await db("order_operation").insert({ id: ids.operation, medusa_order_id: ids.order, checkout_completion_id: ids.completion, merchant_id: "merchant", merchant_store_id: "store", status: "PENDING_ACCEPTANCE" });
      return ids;
    };
    const count = async (kind: string, extra: Record<string, string> = {}) => Number((await db("notification_intent").where({ kind, ...extra }).count("* as n").first())?.n);
    // D reuses setup and the exact C mapper without repeating every C scenario.
    if (runtimeProof) {
      await foundation.activate("operator", { request_id: "activate", reason: "M22-D private source/runtime verification" });
      await runtimeProof({ db, mappings, foundation, actors, env, clock, seedOrder });
      return;
    }
    const inactive = await seedOrder("inactive"); await mappings.discover("ORDER", inactive.order); assert.equal(await count("ORDER_CONFIRMED"), 0);
    await foundation.activate("operator", { request_id: "activate", reason: "M22-C private source-contract verification" });
    const old = await seedOrder("old", previous); await mappings.discover("ORDER", old.order); assert.equal(await count("ORDER_CONFIRMED"), 0);
    const order = await seedOrder("confirmed");
    const signal = notificationSignal({ name: "order.placed", data: { id: order.order, customer_id: "foreign", email: "foreign@example.test" } }); assert.ok(signal);
    await Promise.all([mappings.discover("ORDER", signal.id), mappings.discover("ORDER", signal.id)]);
    assert.equal(await count("ORDER_CONFIRMED", { recipient_id: order.customer }), 2);
    assert.equal(await count("NEW_ORDER_REQUIRING_ACTION", { recipient_id: "member_OWNER" }), 1);
    assert.equal(await count("NEW_ORDER_REQUIRING_ACTION", { recipient_id: "member_MANAGER" }), 1);
    assert.equal(await count("NEW_ORDER_REQUIRING_ACTION", { recipient_id: "member_PICKER" }), 0);
    for (const member of ["member_FOREIGN", "member_REVOKED"]) assert.equal(await count("NEW_ORDER_REQUIRING_ACTION", { recipient_id: member }), 0);
    await db("fixture_order").where({ id: order.order }).update({ contact: "new-contact@example.test" });
    await mappings.discover("ORDER", order.order);
    const email = await db("notification_intent").where({ kind: "ORDER_CONFIRMED", recipient_id: order.customer, channel: "EMAIL" }).first();
    assert.equal(email.destination, "customer@example.test"); assert.equal(email.envelope.to, "customer@example.test");
    await db("fixture_actor").insert({ id: "identity_LATE" });
    await db("merchant_member").insert({ id: "member_LATE", merchant_id: "merchant", auth_identity_id: "identity_LATE", member_type: "MANAGER", status: "ACTIVE" });
    await mappings.discover("ORDER", order.order); assert.equal(await count("NEW_ORDER_REQUIRING_ACTION", { recipient_id: "member_LATE" }), 0);
    const missing = await seedOrder("missing", clock, null); await mappings.discover("ORDER", missing.order);
    const missingMail = await db("notification_intent as i").join("notification_delivery as d", "d.intent_id", "i.id")
      .where({ "i.kind": "ORDER_CONFIRMED", "i.recipient_id": missing.customer, "i.channel": "EMAIL" }).first();
    assert.equal(missingMail.state, "SUPPRESSED"); assert.equal(missingMail.suppression_reason, "NO_RECIPIENT");
    assert.equal(await count("ORDER_CONFIRMED", { recipient_id: missing.customer, channel: "IN_APP" }), 1);
    const speculative = await seedOrder("speculative"); await db("checkout_completion").where({ id: speculative.completion }).update({ state: "DISPATCHED" });
    await mappings.discover("ORDER", speculative.order); assert.equal(await count("ORDER_CONFIRMED", { recipient_id: speculative.customer }), 0);
    await db("pick_session").insert({ id: "session", order_operation_id: order.operation, status: "IN_PROGRESS", assigned_member_id: "member_PICKER" });
    await db("pick_event").insert({ id: "claim", pick_session_id: "session", revision: 1, action: "CLAIM", occurred_at: clock });
    await db("shortage_resolution").insert({ id: "shortage", pick_session_id: "session", pick_line_id: "line", status: "CUSTOMER_DECISION_REQUIRED" });
    await mappings.discover("ORDER", order.order); assert.equal(await count("PICKING_OR_FULFILMENT_ATTENTION", { recipient_id: "member_PICKER" }), 1);
    await db("order_operation").where({ id: order.operation }).update({ status: "ACCEPTED" });
    await db("shortage_resolution").where({ id: "shortage" }).update({ invalidated_at: clock });
    await db("pick_line").insert({ id: "line", pick_session_id: "session", medusa_order_line_id: "native_line", ordered_quantity_at_start: 1, picked_quantity: 1, shortage_recorded: false });
    await db("pick_session").where({ id: "session" }).update({ status: "COMPLETED", revision: 2, completed_at: clock });
    await db("pick_event").insert({ id: "complete_pick", pick_session_id: "session", revision: 2, action: "COMPLETE", occurred_at: clock });
    await db("delivery_operation").insert({ id: "delivery", order_operation_id: order.operation, medusa_order_id: order.order, merchant_id: "merchant", merchant_store_id: "store", pick_session_id: "session", status: "OFFERED", revision: 2, generation: 1 });
    const offer = async (key: string, generation: number, expires: Date) => {
      await db("dispatch_commitment").insert({ id: key, delivery_id: "delivery", driver_profile_id: "driver", generation, status: "OFFERED", expires_at: expires, profile_revision: 1, affiliation_revision: 1, affiliation_id: "affiliation" });
      await db("dispatch_event").insert({ id: key + "_event", target_type: "DELIVERY", target_id: "delivery", revision: generation * 2, action: "OFFER_CREATED", occurred_at: clock, evidence: JSON.stringify({ commitment_id: key }) });
    };
    await offer("offer_a", 1, new Date(clock.getTime() + 30000));
    await Promise.all([mappings.discover("DELIVERY", "delivery"), mappings.discover("DELIVERY", "delivery")]);
    assert.equal(await count("DISPATCH_OFFER_CREATED", { recipient_id: "driver" }), 1);
    assert.equal(await count("DISPATCH_OFFER_CREATED", { recipient_id: "foreign_driver" }), 0);
    await db("dispatch_commitment").where({ id: "offer_a" }).update({ status: "EXPIRED" });
    await db("delivery_operation").where({ id: "delivery" }).update({ generation: 2, revision: 4 });
    await offer("offer_expired", 2, new Date(clock.getTime() - 1)); await mappings.discover("DELIVERY", "delivery");
    assert.equal(await count("DISPATCH_OFFER_CREATED", { recipient_id: "driver" }), 1);
    await db("dispatch_commitment").where({ id: "offer_expired" }).update({ status: "CANCELLED" });
    await db("delivery_operation").where({ id: "delivery" }).update({ generation: 3, revision: 6 });
    await offer("offer_b", 3, new Date(clock.getTime() + 30000)); await mappings.discover("DELIVERY", "delivery");
    assert.equal(await count("DISPATCH_OFFER_CREATED", { recipient_id: "driver" }), 2);
    await db("dispatch_commitment").where({ id: "offer_b" }).update({ status: "ASSIGNED" });
    await db("delivery_operation").where({ id: "delivery" }).update({ status: "ASSIGNED", revision: 7 });
    await db("dispatch_event").insert({ id: "assigned", target_type: "DELIVERY", target_id: "delivery", revision: 7, action: "ASSIGNED", occurred_at: clock, evidence: JSON.stringify({ commitment_id: "offer_b" }) });
    await mappings.discover("DELIVERY", "delivery"); assert.equal(await count("ASSIGNMENT_CONFIRMED", { recipient_id: "driver" }), 1);
    await db("pickup_operation").insert({ id: "ship", delivery_id: "delivery", action: "SHIP", state: "SUCCEEDED", native_state: "done", fulfillment_id: "fulfillment", terminal_receipt: JSON.stringify({ fulfillment_id: "fulfillment" }) });
    await db("delivery_operation").where({ id: "delivery" }).update({ native_fulfillment_id: "fulfillment", picked_up_at: clock });
    await db("dispatch_event").insert({ id: "picked", target_type: "DELIVERY", target_id: "delivery", revision: 8, action: "PICKED_UP", occurred_at: clock, evidence: JSON.stringify({ commitment_id: "offer_b" }) });
    await db("delivery_operation").where({ id: "delivery" }).update({ revision: 8 });
    await mappings.discover("DELIVERY", "delivery"); assert.equal(await count("ORDER_PICKED_UP", { recipient_id: order.customer }), 1);
    await db("delivery_operation").where({ id: "delivery" }).update({ status: "DELIVERED", revision: 9, delivered_at: clock });
    await db("dispatch_commitment").where({ id: "offer_b" }).update({ status: "COMPLETED" });
    await db("delivery_completion").insert({ id: "delivered", delivery_id: "delivery", commitment_id: "offer_b", ship_operation_id: "ship", state: "SUCCEEDED", native_done: true, receipt: JSON.stringify({ fulfillment_id: "fulfillment", delivered_at: clock.toISOString() }) });
    await db("dispatch_event").insert({ id: "delivered_event", target_type: "DELIVERY", target_id: "delivery", revision: 9, action: "DELIVERED", occurred_at: clock, evidence: JSON.stringify({ commitment_id: "offer_b" }) });
    await mappings.deliveredOrder(order.order); assert.equal(await count("DELIVERY_COMPLETED", { recipient_id: order.customer }), 2);
    const returnOrder = await seedOrder("return");
    await db("order_operation").where({ id: returnOrder.operation }).update({ status: "ACCEPTED" });
    await db("delivery_operation").insert({ id: "return_delivery", order_operation_id: returnOrder.operation, medusa_order_id: returnOrder.order,
      merchant_id: "merchant", merchant_store_id: "store", status: "ASSIGNED", revision: 4, generation: 1 });
    await db("dispatch_commitment").insert({ id: "return_commitment", delivery_id: "return_delivery", driver_profile_id: "driver", generation: 1, status: "ASSIGNED" });
    await db("restricted_return").insert({ id: "return", delivery_id: "return_delivery", merchant_store_id: "store", commitment_id: "return_commitment",
      state: "RETURN_REQUIRED", failed_at: clock, physical_manifest: JSON.stringify([{ id: "returned_line", quantity: 1 }]) });
    await db("restricted_event").insert({ id: "return_required", target_id: "return", action: "RETURN_REQUIRED" });
    await mappings.discover("DELIVERY", "return_delivery");
    assert.equal(await count("DELIVERY_FAILED_OR_RETURN_REQUIRED", { recipient_id: returnOrder.customer, channel: "IN_APP" }), 1);
    assert.equal(await count("DELIVERY_FAILED_OR_RETURN_REQUIRED", { recipient_id: returnOrder.customer, channel: "EMAIL" }), 0);
    assert.equal(await count("DELIVERY_COMPLETED", { recipient_id: returnOrder.customer }), 0);
    assert.equal(await count("DELIVERY_RETURN_ACTION_REQUIRED", { recipient_id: "member_PICKER" }), 1);
    await db("restricted_return").where({ id: "return" }).update({ state: "RETURNED_TO_STORE", received_by: "member_PICKER", returned_at: clock });
    await db("dispatch_commitment").where({ id: "return_commitment" }).update({ status: "RETURNED" });
    await db("delivery_operation").where({ id: "return_delivery" }).update({ status: "RETURNED_TO_STORE", revision: 5 });
    await db("restricted_event").insert({ id: "return_receipt", target_id: "return", action: "STORE_RECEIPT_ACKNOWLEDGED", actor_id: "member_PICKER" });
    await mappings.discover("DELIVERY", "return_delivery");
    assert.equal(await count("RETURNED_GOODS_DISPOSITION_REQUIRED", { recipient_id: "member_OWNER" }), 1);
    assert.equal(await count("RETURNED_GOODS_DISPOSITION_REQUIRED", { recipient_id: "member_PICKER" }), 0);
    const creditOrder = await seedOrder("credit");
    await db("financial_adjustment").insert({ id: "adjustment", medusa_order_id: creditOrder.order, customer_id: creditOrder.customer, merchant_id: "merchant", merchant_store_id: "store", status: "APPROVED", default_method: "STORE_CREDIT", amount_minor: 6342 });
    await db("financial_settlement").insert({ id: "settlement", adjustment_id: "adjustment", method: "STORE_CREDIT", amount_minor: 6342, currency: "zar", state: "SETTLED" });
    await db("store_credit_operation").insert({ id: "credit", adjustment_id: "adjustment", settlement_id: "settlement", order_id: creditOrder.order, customer_id: creditOrder.customer, store_id: "store", amount_minor: 6342, currency: "zar", status: "SETTLED", revision: 3, settled_at: clock, account_id: "account", native_transaction_id: "native_credit_receipt" });
    await db("store_credit_operation_event").insert({ operation_id: "credit", revision: 3, status: "SETTLED", occurred_at: clock });
    await mappings.discover("CREDIT", "credit"); await mappings.discover("CREDIT", "credit");
    assert.equal(await count("STORE_CREDIT_ISSUED", { recipient_id: creditOrder.customer }), 2);
    assert.equal(await count("REFUND_CONFIRMED", { recipient_id: creditOrder.customer }), 0);
    await db("merchant_period_statement").insert({ id: "statement", merchant_id: "merchant", store_id: "store", status: "READY_FOR_APPROVAL" });
    await db("payable_settlement").insert({ id: "payable", statement_id: "statement", amount_minor: 8000, status: "READY_FOR_APPROVAL", revision: 2 });
    await db("settlement_transition_audit").insert({ id: "ready", statement_id: "statement", action: "READY", recorded_at: clock });
    await mappings.discover("SETTLEMENT", "statement"); assert.equal(await count("SETTLEMENT_READY_OR_ATTENTION", { recipient_id: "member_PICKER" }), 0);
    assert.equal(await count("MERCHANT_SETTLEMENT_ATTENTION", { recipient_id: "operator" }), 1);
    assert.equal(await count("MERCHANT_SETTLEMENT_ATTENTION", { recipient_id: "unrelated" }), 0);
    await db("driver_profile").where({ id: "driver" }).update({ status: "SUSPENDED" });
    await db("driver_payment").insert({ id: "driver_payment", driver_profile_id: "driver", payer: "GOSPAZA", currency: "zar", amount_minor: 5000, initial_outcome: "PAID" });
    await db("driver_payment_command").insert({ id: "record_payment", payment_id: "driver_payment", action: "RECORD", recorded_at: clock });
    await db("driver_payment_item").insert({ payment_id: "driver_payment", earning_id: "earning", amount_minor: 5000 });
    await db("driver_payment_allocation").insert({ payment_id: "driver_payment", earning_id: "earning", driver_profile_id: "driver", payer: "GOSPAZA", currency: "zar", amount_minor: 5000 });
    await mappings.discover("DRIVER_PAYMENT", "driver_payment"); assert.equal(await count("DRIVER_PAYMENT_RECORDED", { recipient_id: "driver" }), 1);
    assert.equal(await count("DRIVER_PAYMENT_RECORDED", { recipient_id: "foreign_driver" }), 0);
    const all = await db("notification_intent").select("body", "html", "recipient_type", "channel");
    assert.equal(all.some(row => row.recipient_type !== "customer" && row.channel === "EMAIL"), false);
    for (const row of all) for (const secret of ["school_uniform", "native_credit_receipt", "beneficiary", "fixture-key", "private_storage_key"])
      assert.equal(String(row.body).includes(secret) || String(row.html).includes(secret), false);
    assert.equal(Number((await db("notification_attempt").count("* as n").first())?.n), 0, "C creates EMAIL intents without transport execution");
    console.log("M22-C notification mappings passed (PostgreSQL source contracts; controlled native reads; no email).");
  } finally {
    await db.destroy(); if (created) await base.raw("drop schema ?? cascade", [schema]);
  }
}
