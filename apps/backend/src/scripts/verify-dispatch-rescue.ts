import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, IAuthModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { DispatchService } from "../lib/dispatch-service";
import { DispatchOrchestrator } from "../lib/dispatch-orchestrator";
import { dispatchPolicy, locationFresh, pathAllowed, dispatchTimeReady, offerExpiry } from "../modules/marketplace/dispatch-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { DriverService } from "../modules/marketplace/driver-service";
import { dispatchReadiness } from "../lib/dispatch-readiness";
import { geometryService } from "../modules/marketplace/location-policy";
import type { DeliveryRow } from "../modules/marketplace/dispatch-rows";
import { pickingFingerprint } from "../modules/marketplace/picking-policy";
import type { DeliveryRescueCommand } from "@gospaza/contracts";
import type { DispatchLocations, DispatchSample } from "../lib/dispatch-location";

// Real PostgreSQL transactions/constraints/owner code, independent scopes and
// connections. Native Order/Cart/graph read ports use controlled fixture readbacks;
// this does NOT manufacture paid commercial history in public or claim a live
// checkout/native integration proof. Native User/Auth identity checks remain real.
const core = ["delivery_operation", "dispatch_commitment", "dispatch_event", "driver_availability", "store_dispatch_configuration", "dispatch_work", "delivery_rescue_command"];
const inputs = ["merchant", "merchant_store", "merchant_application", "order_operation", "pick_session", "pick_line", "pick_event", "shortage_resolution",
  "delivery_reservation", "cart_marketplace_context", "checkout_attempt", "checkout_completion", "order_decision_event", "marketplace_service_zone", "merchant_store_service_zone",
  "delivery_option_configuration", "delivery_slot", "pickup_operation", "delivery_completion", "restricted_return", "handoff_generation", "recipient_compliance",
  "driver_compensation_snapshot", "driver_compensation_activation", "driver_compensation_terms", "driver_profile", "driver_affiliation"];
const conflict = (error: unknown) => MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT;
function offerDiagnosticError(error: unknown, depth = 0): object {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const identifier = (field: unknown) => typeof field === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(field) ? field : null;
  const code = identifier(value.code), message = error instanceof Error ? error.message : "";
  const category = code === "55P03" ? "LOCK_TIMEOUT" : code === "23505" ? "UNIQUE_CONSTRAINT"
    : code === "40001" ? "SERIALIZATION_FAILURE" : code === "40P01" ? "DEADLOCK"
    : code === "57014" ? "QUERY_CANCELLED" : /Timeout acquiring a connection/i.test(message) ? "CONNECTION_POOL_TIMEOUT"
    : MedusaError.isMedusaError(error) ? "DOMAIN_ERROR" : "UNCLASSIFIED";
  // Never emit a raw Knex message: it can contain SQL, bindings or private data.
  const safeMessages: Record<string, string> = { LOCK_TIMEOUT: "PostgreSQL lock acquisition timed out.", UNIQUE_CONSTRAINT: "PostgreSQL uniqueness conflict.",
    SERIALIZATION_FAILURE: "PostgreSQL serialization failure.", DEADLOCK: "PostgreSQL deadlock detected.", QUERY_CANCELLED: "PostgreSQL query cancelled.",
    CONNECTION_POOL_TIMEOUT: "Database connection acquisition timed out.", DOMAIN_ERROR: "Domain rejected the operation; inspect its type and code.",
    UNCLASSIFIED: "Message omitted: outside the diagnostic allowlist." };
  return { error_class: identifier(value.name), code, type: identifier(value.type), category, message: safeMessages[category],
    constraint: identifier(value.constraint), table: identifier(value.table),
    ...(depth < 2 && value.cause !== undefined ? { cause: offerDiagnosticError(value.cause, depth + 1) } : {}),
    ...(depth < 2 && error instanceof AggregateError ? { errors: error.errors.slice(0, 2).map(cause => offerDiagnosticError(cause, depth + 1)), errors_truncated: error.errors.length > 2 } : {}) };
}
export default async function verifyDispatchRescue({ container }: ExecArgs, regressionOnly = false) {
  assert.equal(process.env.APP_ENV, "test"); assert.equal(process.env.NODE_ENV, "test");
  assert.equal(new URL(process.env.DATABASE_URL ?? "").pathname, "/gospaza_m18_c2b_test"); assert.equal(new URL(process.env.REDIS_URL ?? "").pathname, "/1");
  const root = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), schema = "m23c_" + randomUUID().replaceAll("-", "");
  assert.ok(await root.schema.hasTable("delivery_rescue_command"), "Apply the M23-C migration first.");
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 12 } });
  const users = container.resolve<IUserModuleService>(Modules.USER), auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const saved = new Map<string, string | undefined>(), set = (key: string, value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };
  const actor = await users.createUsers({ email: schema + "@example.test" });
  const registered = await auth.register("emailpass", { body: { email: schema + "-driver@example.test", password: randomBytes(24).toString("hex") } }); assert.ok(registered.authIdentity);
  const identity = registered.authIdentity.id;
  let nativeUnavailable = false;
  const orders = new Map<string, { cart: string; item: string; variant: string; shipping: string }>();
  const policy = dispatchPolicy(), samples = new Map<string, DispatchSample>(), fences = new Map<string, { generation: string; sequence: number }>();
  // Controlled location port, not Redis: retain what location() actually
  // publishes with database time. Reads must never manufacture host-clock GPS.
  const locations: DispatchLocations = {
    begin: async (profile, generation) => { fences.set(profile, { generation, sequence: 0 }); samples.delete(profile); },
    put: async (profile, input, now) => {
      const fence = fences.get(profile); assert.ok(fence && fence.generation === input.generation && input.sequence > fence.sequence, "Invalid fixture location publication.");
      fence.sequence = input.sequence; samples.set(profile, { ...input, received_at: now.getTime() });
    },
    get: async profile => samples.get(profile) ?? null,
    sequence: async (profile, generation) => { const fence = fences.get(profile); return fence?.generation === generation ? fence.sequence : null; },
  };
  const scope = () => {
    const current = container.createScope() as MedusaContainer;
    current.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db),
      [ContainerRegistrationKeys.QUERY]: asValue({ graph: async (query: { entity: string; filters: Record<string, string> }) => {
        if (nativeUnavailable) throw Error("Controlled unavailable native readback");
        if (query.entity === "order_cart") {
          const orderId = query.filters.order_id;
          if (!orderId) throw Error("Fixture order_cart read requires an order_id filter");
          return { data: [{ order_id: orderId, cart_id: orders.get(orderId)?.cart }] };
        }
        if (query.entity === "order_fulfillment") return { data: [] };
        if (query.entity === "shipping_option") return { data: [{ id: query.filters.id, service_zone_id: "native_zone", service_zone: { fulfillment_set: { type: "shipping" } } }] };
        throw Error("Unexpected native graph read");
      } }),
      [Modules.CART]: asValue({ retrieveCart: async () => ({ completed_at: new Date(), customer_id: "customer_fixture", sales_channel_id: "channel_fixture" }) }),
      [Modules.ORDER]: asValue({ retrieveOrder: async (id: string) => {
        const order = orders.get(id); assert.ok(order);
        return { id, status: "pending", currency_code: "zar", customer_id: "customer_fixture", sales_channel_id: "channel_fixture",
          items: [{ id: order.item, variant_id: order.variant, quantity: 1, title: "Fixture groceries" }], shipping_address: {}, shipping_methods: [{ shipping_option_id: order.shipping }] };
      } }),
    });
    return current;
  };
  const service = () => new DispatchService(scope(), policy, locations);
  async function refreshLocation() {
    const availability = await service().readAvailability(identity);
    assert.equal(availability.intent, "ONLINE"); assert.equal(availability.generation, "driver_generation");
    const sequence = availability.location_sequence; assert.ok(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0, "Fixture location sequence is unavailable.");
    await service().location(identity, { generation: "driver_generation", sequence: sequence + 1, latitude: 0, longitude: 0 });
  }
  async function offerAdmissionEvidence(deliveryId: string) {
    const d = await db<DeliveryRow>("delivery_operation").where({ id: deliveryId }).first(); assert.ok(d);
    const eligibility = await new DriverService(scope()).eligibility("driver_fixture", d.merchant_store_id);
    return db.transaction(async trx => {
      const ready = await dispatchReadiness(scope(), trx, d, policy, undefined, true);
      const a = await trx("driver_availability").where({ driver_profile_id: "driver_fixture" }).first();
      const sample = await locations.get("driver_fixture"), now = await databaseTime(trx);
      return { observation: "POST_FAILURE_READBACK", database_now: now.toISOString(), host_minus_database_ms: Date.now() - now.getTime(),
        eligibility: { eligible: eligibility.eligible, reason: eligibility.reason, kind: eligibility.kind, path: d.path },
        predicates: { searching: d.status === "SEARCHING", path_allowed: !!d.path && pathAllowed(d.mode, d.path), affiliation_matches_path: eligibility.kind === d.path,
          online: a?.intent === "ONLINE", profile_revision_matches: a?.profile_revision === eligibility.profile_revision,
          availability_generation_present: !!a?.generation, deadline_present: !!d.deadline, offer_duration_present: !!d.offer_ms,
          affiliation_matches: a?.affiliation_id === eligibility.affiliation_id && a?.affiliation_revision === eligibility.affiliation_revision,
          sample_present: !!sample, sample_generation_matches: !!sample && sample.generation === a?.generation,
          location_not_future: !!sample && sample.received_at <= now.getTime(), location_fresh: !!sample && locationFresh(sample.received_at, now, policy),
          location_zone_allowed: d.path === "MERCHANT" || !!sample && geometryService.contains(ready.zone.geometry, sample.latitude, sample.longitude),
          readiness_valid: true, configuration_matches: ready.config?.revision === d.configuration_revision && ready.config?.mode === d.mode && ready.config?.mode !== "DISABLED",
          dispatch_time_ready: dispatchTimeReady(ready.notBefore, now), zone_matches: ready.zone.id === d.service_zone_id,
          offer_expiry_in_future: !!d.deadline && !!d.offer_ms && offerExpiry(now, new Date(d.deadline), d.path === "MERCHANT" && d.merchant_deadline ? new Date(d.merchant_deadline) : null, d.offer_ms) > now },
        sample_received_at: sample ? new Date(sample.received_at).toISOString() : null, sample_age_ms: sample ? now.getTime() - sample.received_at : null,
        freshness_ms: policy.freshnessMs, deadline: d.deadline, merchant_deadline: d.merchant_deadline };
    });
  }
  let currentScenario = "setup", concurrentOfferDiagnostic: object | undefined, diagnosticDelivery: string | undefined;
  const scenarioMarker = (label: string) => { currentScenario = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80); };
  async function directOffer(label: string, deliveryId: string, generation: number) {
    diagnosticDelivery = deliveryId;
    const context = { scenario: label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80), delivery_id: deliveryId, generation, driver_profile_id: "driver_fixture" };
    scenarioMarker(label);
    try { await refreshLocation(); return await service().offer(deliveryId, "driver_fixture"); }
    catch (original) {
      // Print the original failure before diagnostic reads, which must never
      // replace it or query outside this run's private schema.
      console.error("M23-C direct-offer diagnostic: " + JSON.stringify({ ...context, event: "error", rejection: offerDiagnosticError(original) }));
      const capacityReads = await Promise.allSettled([
        db("dispatch_commitment").where({ driver_profile_id: "driver_fixture" }).whereIn("status", ["OFFERED", "ASSIGNED"]).count("* as count").first(),
        db("dispatch_commitment").where({ driver_profile_id: "driver_fixture" }).whereIn("status", ["OFFERED", "ASSIGNED"]).orderBy("id").limit(6)
          .select("id", "delivery_id", "generation", "status"),
        db("dispatch_commitment").where({ delivery_id: deliveryId, generation }).count("* as count").first(),
        db("dispatch_event as e").where({ "e.target_type": "DELIVERY", "e.target_id": deliveryId, "e.action": "OFFER_CREATED" })
          .whereExists(db("dispatch_commitment as c").select("c.id").where({ "c.delivery_id": deliveryId, "c.generation": generation })
            .whereRaw("c.id = e.evidence->>'commitment_id'")).count("e.id as count").first(),
        offerAdmissionEvidence(deliveryId),
      ]);
      const labels = ["active_commitment_count", "active_commitments", "target_generation_commitment_count", "target_generation_offer_audit_count", "admission_predicates"];
      console.error("M23-C direct-offer diagnostic: " + JSON.stringify({ ...context, event: "capacity_after_error",
        capacity: capacityReads.map((outcome, index) => ({ source: labels[index] ?? "unexpected_read",
          ...(outcome.status === "rejected" ? { available: false, error: offerDiagnosticError(outcome.reason) }
            : { available: true, value: Array.isArray(outcome.value) ? outcome.value.slice(0, 5) : outcome.value ?? null,
              ...(Array.isArray(outcome.value) ? { truncated: outcome.value.length > 5 } : {}) }) })) }));
      throw original;
    }
  }
  try {
    set("DELIVERY_OPERATIONS_VIEW_USER_IDS", actor.id); set("DELIVERY_RESCUE_USER_IDS", actor.id);
    await root.raw("create schema ??", [schema]);
    for (const table of [...inputs, ...core]) {
      await db.raw(`create table ??.?? (like public.?? ${core.includes(table) ? "including all" : "including defaults"})`, [schema, table, table]);
      if (!core.includes(table)) {
        const columns = await root("information_schema.columns").where({ table_schema: "public", table_name: table, is_nullable: "NO" }).select("column_name");
        for (const column of columns) await db.raw("alter table ??.?? alter column ?? drop not null", [schema, table, column.column_name]);
        await db.raw("alter table ??.?? add unique(id)", [schema, table]);
      }
    }
    await db.raw("alter table merchant_store add unique(id,merchant_id)");
    for (const table of core) {
      const constraints = await root.raw("select conname,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid=?::regclass and contype='f'", ["public." + table]);
      for (const constraint of constraints.rows) await db.raw(`alter table ??.?? add constraint ?? ${String(constraint.definition).replaceAll("public.", schema + ".")}`, [schema, table, constraint.conname]);
    }
    for (const fn of ["gospaza_delivery_rescue_transition(delivery_operation,delivery_operation)", "gospaza_dispatch_guard()", "gospaza_dispatch_consistency()", "gospaza_rescue_guard()", "gospaza_rescue_consistency()", "gospaza_driver_comp_selection(timestamp with time zone)"]) {
      const { rows: [definition] } = await root.raw("select pg_get_functiondef(?::regprocedure) as definition", ["public." + fn]);
      await db.raw(String(definition.definition).replaceAll("public.", schema + "."));
    }
    for (const table of ["delivery_operation", "dispatch_commitment", "driver_availability", "store_dispatch_configuration", "dispatch_event"]) {
      const events = table === "dispatch_event" ? "update" : "insert or update";
      await db.raw(`create trigger fixture_guard before ${events} on ?? for each row execute function gospaza_dispatch_guard()`, [table]);
      if (table !== "dispatch_event") await db.raw("create constraint trigger fixture_consistency after insert or update on ?? deferrable initially deferred for each row execute function gospaza_dispatch_consistency()", [table]);
    }
    await db.raw("create trigger receipt_guard before insert or update or delete on delivery_rescue_command for each row execute function gospaza_rescue_guard()");
    await db.raw("create trigger generation_guard before insert or update on delivery_operation for each row execute function gospaza_rescue_guard()");
    await db.raw("create constraint trigger receipt_consistency after insert on delivery_rescue_command deferrable initially deferred for each row execute function gospaza_rescue_consistency()");
    await db.raw("create constraint trigger rescue_consistency after update on delivery_operation deferrable initially deferred for each row execute function gospaza_rescue_consistency()");
    const now = new Date(), address = { first_name: "Fixture", last_name: "Customer", address_1: "1 Test", address_2: "", city: "Test", province: "Test", postal_code: "0000", country_code: "za", phone: "" };
    await db("merchant_application").insert({ id: "application_fixture", status: "APPROVED" });
    await db("merchant").insert({ id: "merchant_fixture", status: "ACTIVE", source_application_id: "application_fixture" });
    await db("merchant_store").insert({ id: "store_fixture", merchant_id: "merchant_fixture", active: true, name: "Fixture store" });
    await db("marketplace_service_zone").insert({ id: "zone_fixture", active: true, geometry: JSON.stringify({ type: "Polygon", coordinates: [[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]] }) });
    await db("merchant_store_service_zone").insert({ id: "mapping_fixture", merchant_store_id: "store_fixture", service_zone_id: "zone_fixture", medusa_service_zone_id: "native_zone", active: true });
    await db("delivery_option_configuration").insert({ id: "option_fixture", merchant_store_id: "store_fixture", store_service_zone_id: "mapping_fixture", mode: "ASAP", medusa_shipping_option_id: "shipping_fixture" });
    await db("delivery_slot").insert({ id: "slot_fixture", merchant_store_id: "store_fixture", start_at: now });
    await db("driver_profile").insert({ id: "driver_fixture", auth_identity_id: identity, status: "ACTIVE", revision: 1 });
    await db("driver_affiliation").insert({ id: "affiliation_fixture", driver_profile_id: "driver_fixture", status: "ACTIVE", kind: "MERCHANT", merchant_id: "merchant_fixture", merchant_store_id: "store_fixture", revision: 1 });
    await db.transaction(async trx => {
      await trx("store_dispatch_configuration").insert({ id: "config_fixture", merchant_store_id: "store_fixture", mode: "HYBRID", revision: 1 });
      await trx("dispatch_event").insert({ id: "config_event", target_type: "CONFIGURATION", target_id: "config_fixture", revision: 1, action: "CONFIGURED", actor_type: "system", occurred_at: now, evidence: {} });
      await trx("driver_availability").insert({ id: "availability_fixture", driver_profile_id: "driver_fixture", intent: "ONLINE", revision: 1, generation: "driver_generation", available_since: now, affiliation_id: "affiliation_fixture", affiliation_revision: 1, profile_revision: 1 });
      await trx("dispatch_event").insert({ id: "availability_event", target_type: "AVAILABILITY", target_id: "availability_fixture", revision: 1, action: "ONLINE", actor_type: "system", occurred_at: now, evidence: {} });
    });
    await locations.begin("driver_fixture", "driver_generation");
    async function fixture(label: string, terminal?: "DELIVERED" | "RETURNED_TO_STORE") {
      scenarioMarker(label);
      diagnosticDelivery = undefined;
      const order = "order_" + label, cart = "cart_" + label, context = "context_" + label, hold = "hold_" + label, operation = "operation_" + label, session = "pick_" + label;
      orders.set(order, { cart, item: "item_" + label, variant: "variant_fixture", shipping: "shipping_fixture" });
      const snapshot = { customer_id: "customer_fixture", cart_id: cart, cart_context_id: context, merchant_id: "merchant_fixture", merchant_store_id: "store_fixture", address_id: "address_fixture", address,
        reservation_id: hold, reservation_revision: 1, configuration_revision: 1, delivery_option_id: "option_fixture", shipping_option_id: "shipping_fixture", shipping_method_id: "method_fixture", currency_code: "zar",
        totals: { total_minor: 100, subtotal_minor: 100, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 0 },
        items: [{ id: "cart_item_" + label, variant_id: "variant_fixture", quantity: 1, unit_price_minor: 100, total_minor: 100 }],
        restricted_commerce: { version: 1, restricted_content_present: false, classifications: [{ product_id: "product_fixture", variant_id: "variant_fixture", revision_id: "class_fixture", restriction: "NONE", alcohol_class: null }], registration_id: null, registration_revision: null, trading_policy_version: null, purchaser_evidence_id: null } };
      const receipt = { order_id: order, cart_id: cart, payment_id: "payment_" + label, capture_id: "capture_" + label, payment_collection_id: "collection_" + label,
        amount_minor: 100, currency: "zar", workflow_id: "workflow", transaction_id: label, execution_id: "execution", run_id: "run", verified_at: now.toISOString() };
      await db("cart_marketplace_context").insert({ id: context, medusa_cart_id: cart, merchant_id: "merchant_fixture", merchant_store_id: "store_fixture" });
      await db("delivery_reservation").insert({ id: hold, cart_context_id: context, medusa_order_id: order, merchant_store_id: "store_fixture", status: "COMMITTED", payment_accepted_at: now, store_service_zone_id: "mapping_fixture", delivery_option_id: "option_fixture", delivery_slot_id: "slot_fixture", latitude: 0, longitude: 0 });
      await db("checkout_attempt").insert({ id: "attempt_" + label, cart_context_id: context, medusa_cart_id: cart, reservation_id: hold, state: "COMPLETED", closed_at: now, payment_accepted_at: now, snapshot: JSON.stringify(snapshot) });
      await db("checkout_completion").insert({ id: "completion_" + label, checkout_attempt_id: "attempt_" + label, order_id: order, state: "SUCCEEDED", native_state: "done", terminal_receipt: JSON.stringify(receipt), workflow_id: "workflow", transaction_id: label, execution_id: "execution", run_id: "run" });
      await db("order_operation").insert({ id: operation, medusa_order_id: order, merchant_id: "merchant_fixture", merchant_store_id: "store_fixture", checkout_completion_id: "completion_" + label, status: "ACCEPTED", revision: 1 });
      await db("pick_session").insert({ id: session, order_operation_id: operation, status: "COMPLETED", completed_at: now, revision: 1, source_lines_fingerprint: pickingFingerprint([{ id: "item_" + label, variant_id: "variant_fixture", quantity: 1 }]) });
      await db("pick_line").insert({ id: "line_" + label, pick_session_id: session, medusa_order_line_id: "item_" + label, ordered_quantity_at_start: 1, picked_quantity: 1, shortage_recorded: false });
      await db("pick_event").insert({ id: "pick_event_" + label, pick_session_id: session, revision: 1, action: "COMPLETE" });
      if (terminal) {
        // Deliberately incomplete terminal read input: even without native
        // custody evidence this persisted terminal state must fail closed.
        const id = "delivery_" + label;
        diagnosticDelivery = id;
        await db.transaction(async trx => {
          await trx("delivery_operation").insert({ id, order_operation_id: operation, medusa_order_id: order, merchant_id: "merchant_fixture", merchant_store_id: "store_fixture",
            pick_session_id: session, reservation_id: hold, service_zone_id: "zone_fixture", status: terminal, generation: 1, mode: "HYBRID", path: "MERCHANT",
            started_at: now, deadline: new Date(now.getTime() + 300000), offer_ms: 30000, configuration_revision: 1,
            arrived_at: terminal === "DELIVERED" ? now : null, delivered_at: terminal === "DELIVERED" ? now : null });
          await trx("dispatch_event").insert({ id: "terminal_event_" + label, target_type: "DELIVERY", target_id: id, revision: 1, action: "CREATED", actor_type: "system", occurred_at: now, evidence: {} });
        });
        return id;
      }
      const delivery = await service().ensure(order); diagnosticDelivery = delivery.id;
      await db("dispatch_work").insert({ delivery_id: delivery.id }); await service().start(delivery.id);
      const started = await db("delivery_operation").where({ id: delivery.id }).first(), configuration = await db("store_dispatch_configuration").first();
      assert.equal(started.path, configuration.mode === "PLATFORM_ONLY" ? "PLATFORM" : "MERCHANT"); assert.equal(started.mode, configuration.mode);
      const offer = await directOffer(label + "_initial_generation_1_offer", delivery.id, started.generation);
      await service().decide(identity, offer.id, "DECLINE", { expected_revision: 1 });
      await service().advance(delivery.id, true, started.revision); await service().advance(delivery.id, true);
      await service().advance(delivery.id, true);
      scenarioMarker(label);
      return delivery.id;
    }
    async function input(id: string): Promise<DeliveryRescueCommand> {
      const row = await db("delivery_operation").where({ id }).first(); assert.equal(row.status, "ATTENTION_REQUIRED");
      return { request_id: randomUUID(), expected_revision: row.revision, expected_generation: row.generation, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true };
    }
    const capacity = () => db("driver_availability").select("*");
    if (regressionOnly) {
      const a = await fixture("generation_a"), b = await fixture("generation_b");
      await service().rescue(actor.id, a, await input(a)); await service().rescue(actor.id, b, await input(b));
      const previous = await db("dispatch_commitment").where({ delivery_id: a, generation: 1 }).first(); assert.ok(previous);
      await assert.rejects(service().decide(identity, previous.id, "ACCEPT", { expected_revision: 1 }), conflict);
      await refreshLocation();
      const race = await Promise.allSettled([service().offer(a, "driver_fixture"), service().offer(b, "driver_fixture")]);
      assert.equal(race.filter(outcome => outcome.status === "fulfilled").length, 1);
      for (const outcome of race) if (outcome.status === "rejected") assert.ok(conflict(outcome.reason));
      const winner = race.find(outcome => outcome.status === "fulfilled"); assert.ok(winner && winner.status === "fulfilled");
      assert.equal(winner.value.generation, 2);
      await refreshLocation();
      const accepted = await Promise.all([service().decide(identity, winner.value.id, "ACCEPT", { expected_revision: 1 }), service().decide(identity, winner.value.id, "ACCEPT", { expected_revision: 1 })]);
      assert.equal(accepted[0]?.id, accepted[1]?.id); assert.equal((await db("dispatch_commitment").where({ status: "ASSIGNED" })).length, 1);
      console.log("M15 targeted generation/old-offer/commitment/capacity regression passed through normal DispatchService primitives."); return;
    }
    const id = await fixture("basic"), command = await input(id), baseline = await capacity();
    const same = await Promise.all([service().rescue(actor.id, id, command), service().rescue(actor.id, id, command)]);
    assert.equal(same[0]?.rescue_id, same[1]?.rescue_id); assert.equal(same[0]?.generation, 2); assert.deepEqual(await capacity(), baseline);
    await assert.rejects(service().rescue(actor.id, id, { ...command, expected_revision: command.expected_revision + 1 }), conflict);
    await assert.rejects(service().rescue(actor.id, "delivery_other", command), conflict);
    // Normal M15 offer discovery and generation identity, not rescue-specific offers.
    const offered = await directOffer("basic_generation_2_offer", id, 2); assert.equal(offered.generation, 2);
    assert.deepEqual(await service().rescue(actor.id, id, command), same[0]);
    await service().decide(identity, offered.id, "DECLINE", { expected_revision: 1 });
    await service().advance(id, true); await service().advance(id, true);
    const third = await service().rescue(actor.id, id, await input(id)); assert.equal(third.generation, 3);
    assert.equal((await db("dispatch_commitment").where({ id: offered.id }).first()).status, "DECLINED");
    await assert.rejects(service().decide(identity, offered.id, "ACCEPT", { expected_revision: 1 }), conflict);
    const second = await fixture("different"), first = await input(second);
    const outcomes = await Promise.allSettled([service().rescue(actor.id, second, first), service().rescue(actor.id, second, { ...first, request_id: randomUUID() })]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    for (const outcome of outcomes) if (outcome.status === "rejected") assert.ok(conflict(outcome.reason));
    assert.equal((await db("delivery_rescue_command").where({ delivery_id: second })).length, 1);
    const blocked = await fixture("unavailable"), unavailableInput = await input(blocked);
    nativeUnavailable = true; await assert.rejects(service().rescue(actor.id, blocked, unavailableInput), /Controlled unavailable native readback/); nativeUnavailable = false;
    assert.equal((await db("delivery_rescue_command").where({ delivery_id: blocked })).length, 0);
    set("DELIVERY_RESCUE_USER_IDS", ""); await assert.rejects(service().rescue(actor.id, blocked, unavailableInput), e => MedusaError.isMedusaError(e) && e.type === MedusaError.Types.FORBIDDEN); set("DELIVERY_RESCUE_USER_IDS", actor.id);
    set("DELIVERY_OPERATIONS_VIEW_USER_IDS", ""); await assert.rejects(service().rescue(actor.id, blocked, unavailableInput), e => MedusaError.isMedusaError(e) && e.type === MedusaError.Types.FORBIDDEN); set("DELIVERY_OPERATIONS_VIEW_USER_IDS", actor.id);
    // Fail required audit at COMMIT, proving rollback of receipt/search/work.
    await db.raw("create function fixture_drop_audit() returns trigger as $fixture$ begin if NEW.action='SEARCH_REOPENED' then return null; end if; return NEW; end; $fixture$ language plpgsql");
    await db.raw("create trigger fixture_drop_audit before insert on dispatch_event for each row execute function fixture_drop_audit()");
    const before = await db("delivery_operation").where({ id: blocked }).first(), workBefore = await db("dispatch_work").where({ delivery_id: blocked }).first();
    await assert.rejects(service().rescue(actor.id, blocked, unavailableInput), error => error instanceof Error && (
      /Rescue transition\/audit mismatch|Dispatch audit required/.test(error.message)
      || "code" in error && error.code === "23503" && "constraint" in error && typeof error.constraint === "string" && error.constraint.includes("audit_type")));
    assert.deepEqual(await db("delivery_operation").where({ id: blocked }).first(), before); assert.deepEqual(await db("dispatch_work").where({ delivery_id: blocked }).first(), workBefore);
    assert.equal((await db("delivery_rescue_command").where({ delivery_id: blocked })).length, 0); await db.raw("drop trigger fixture_drop_audit on dispatch_event");
    await assert.rejects(db.transaction(trx => trx("delivery_operation").where({ id: blocked }).update({ status: "SEARCHING", generation: 2, revision: before.revision + 1 })), /Terminal delivery|Rescue generation evidence required/);
    // Even partial/uncertain custody evidence is a denial, never permission.
    for (const table of ["pickup_operation", "delivery_completion", "handoff_generation", "recipient_compliance", "restricted_return", "driver_compensation_snapshot"]) {
      const target = await fixture("deny_" + table), deniedInput = await input(target);
      await db(table).insert({ id: "evidence_" + table, delivery_id: target });
      const unchanged = await db("delivery_operation").where({ id: target }).first();
      await assert.rejects(service().rescue(actor.id, target, deniedInput), conflict);
      assert.deepEqual(await db("delivery_operation").where({ id: target }).first(), unchanged);
      assert.equal((await db("delivery_rescue_command").where({ delivery_id: target })).length, 0);
    }
    for (const terminal of ["DELIVERED", "RETURNED_TO_STORE"] as const) {
      const target = await fixture("deny_" + terminal, terminal);
      await assert.rejects(service().rescue(actor.id, target, { ...command, request_id: randomUUID(), expected_generation: 1, expected_revision: 1 }), conflict);
      assert.equal((await db("delivery_rescue_command").where({ delivery_id: target })).length, 0);
    }
    const workerId = await fixture("worker_race"), workerInput = await input(workerId);
    await Promise.all([service().rescue(actor.id, workerId, workerInput), new DispatchOrchestrator(scope()).runBatch([workerId])]);
    assert.equal((await db("delivery_operation").where({ id: workerId }).first()).generation, 2);
    assert.equal((await db("delivery_rescue_command").where({ delivery_id: workerId })).length, 1);
    assert.equal((await service().rescue(actor.id, workerId, workerInput)).generation, 2);
    // Configuration races share the merchant fence; rescue chooses the current
    // mode at its own admission, not an operator-supplied mode or stale preview.
    const configId = await fixture("configuration_race"), configInput = await input(configId);
    set("SERVICE_CONFIGURATION_VIEW_USER_IDS", actor.id); set("SERVICE_CONFIGURATION_MANAGE_USER_IDS", actor.id);
    await Promise.all([service().rescue(actor.id, configId, configInput), service().configure(actor.id, "store_fixture", { expected_revision: 1, mode: "MERCHANT_ONLY", reason: "Controlled fixture policy change" })]);
    const configReceipt = await db("delivery_rescue_command").where({ delivery_id: configId }).first();
    assert.ok(["HYBRID", "MERCHANT_ONLY"].includes(configReceipt.mode));
    // A later generation uses the now-current MERCHANT_ONLY policy.
    const configured = await fixture("current_mode"), configuredResult = await service().rescue(actor.id, configured, await input(configured));
    assert.equal((await db("delivery_operation").where({ id: configuredResult.delivery_id }).first()).mode, "MERCHANT_ONLY");
    // Active commitment denies; normal offer uniqueness still owns capacity.
    const capacityId = await fixture("capacity"), rescue = await service().rescue(actor.id, capacityId, await input(capacityId));
    await refreshLocation();
    const offers = await Promise.allSettled([service().offer(capacityId, "driver_fixture"), service().offer(capacityId, "driver_fixture")]);
    // Capture both outcomes and committed effects before any assertion can
    // discard the useful rejection/effect evidence. Reads never alter admission.
    const matching = () => db("dispatch_commitment").where({ delivery_id: capacityId, driver_profile_id: "driver_fixture", generation: rescue.generation });
    const generationAudits = () => db("dispatch_event as e").where({ "e.target_type": "DELIVERY", "e.target_id": capacityId, "e.action": "OFFER_CREATED" })
      .whereExists(db("dispatch_commitment as c").select("c.id").where({ "c.delivery_id": capacityId, "c.generation": rescue.generation })
        .whereRaw("c.id = e.evidence->>'commitment_id'"));
    const diagnosticReads = await Promise.allSettled([
      matching().count("* as count").first(),
      matching().orderBy("id").limit(6).select("id", "delivery_id", "driver_profile_id", "generation", "status", "revision"),
      generationAudits().count("e.id as count").first(),
      db("dispatch_commitment").where({ driver_profile_id: "driver_fixture" }).whereIn("status", ["OFFERED", "ASSIGNED"]).count("* as count").first(),
      db("dispatch_commitment").where({ driver_profile_id: "driver_fixture" }).whereIn("status", ["OFFERED", "ASSIGNED"]).orderBy("id").limit(6)
        .select("id", "delivery_id", "driver_profile_id", "generation", "status"),
      db("driver_availability").where({ driver_profile_id: "driver_fixture" }).first("id", "driver_profile_id", "intent", "revision"),
      db("delivery_operation").where({ id: capacityId }).first("id", "status", "generation", "revision"),
    ]);
    const readLabels = ["matching_commitment_count", "matching_commitments", "generation_2_offer_created_count", "driver_active_commitment_count", "driver_active_commitments", "driver_availability", "delivery_state"];
    concurrentOfferDiagnostic = { schema, delivery_id: capacityId, driver_profile_id: "driver_fixture",
      generation: rescue.generation, rescue_id: rescue.rescue_id,
      offers: offers.map((outcome, index) => ({ caller: index === 0 ? "A" : "B", status: outcome.status,
        ...(outcome.status === "rejected" ? { rejection: offerDiagnosticError(outcome.reason) }
          : { commitment_id: outcome.value?.id ?? null, delivery_id: outcome.value?.delivery_id ?? null,
            driver_profile_id: outcome.value?.driver_profile_id ?? null, generation: outcome.value?.generation ?? null, commitment_status: outcome.value?.status ?? null }) })),
      persistence: Object.fromEntries(diagnosticReads.map((outcome, index) => [readLabels[index] ?? "unexpected_read", outcome.status === "rejected"
        ? { available: false, error: offerDiagnosticError(outcome.reason) }
        : { available: true, value: Array.isArray(outcome.value) ? outcome.value.slice(0, 5) : outcome.value ?? null,
          ...(Array.isArray(outcome.value) ? { truncated: outcome.value.length > 5 } : {}) }])) };
    // Identical replay permits two successful callers, but only one effect.
    // The separate different-Delivery race still requires exactly one winner.
    const [offerA, offerB] = offers;
    assert.ok(offerA && offerA.status === "fulfilled", "Identical offer A must fulfill");
    assert.ok(offerB && offerB.status === "fulfilled", "Identical offer B must fulfill");
    const commitmentA = offerA.value, commitmentB = offerB.value;
    assert.equal(commitmentA.id, commitmentB.id); assert.equal(rescue.generation, 2);
    for (const commitment of [commitmentA, commitmentB]) {
      assert.equal(commitment.delivery_id, capacityId); assert.equal(commitment.driver_profile_id, "driver_fixture");
      assert.equal(commitment.generation, rescue.generation); assert.equal(commitment.status, "OFFERED");
    }
    const commitmentRows = await db("dispatch_commitment").where({ delivery_id: capacityId, driver_profile_id: "driver_fixture", generation: rescue.generation });
    assert.equal(commitmentRows.length, 1); assert.equal(commitmentRows[0]?.id, commitmentA.id); assert.equal(commitmentRows[0]?.status, "OFFERED");
    const offerAudits = await db("dispatch_event as e").where({ "e.target_type": "DELIVERY", "e.target_id": capacityId, "e.action": "OFFER_CREATED" })
      .whereExists(db("dispatch_commitment as c").select("c.id").where({ "c.delivery_id": capacityId, "c.generation": rescue.generation })
        .whereRaw("c.id = e.evidence->>'commitment_id'"))
      .select("e.id", "e.evidence");
    assert.equal(offerAudits.length, 1); assert.equal(offerAudits[0]?.evidence.commitment_id, commitmentA.id);
    assert.equal(offerAudits[0]?.evidence.driver_profile_id, "driver_fixture");
    assert.equal((await db("dispatch_commitment").whereIn("status", ["OFFERED", "ASSIGNED"])).length, 1);
    await assert.rejects(service().rescue(actor.id, capacityId, { ...await input(blocked), expected_revision: rescue.revision, expected_generation: 2 }), conflict);
    const current = await db("dispatch_commitment").where({ delivery_id: capacityId, status: "OFFERED" }).first(); assert.ok(current);
    await refreshLocation();
    const acceptRace = await Promise.allSettled([service().rescue(actor.id, capacityId, { ...command, request_id: randomUUID(), expected_revision: rescue.revision, expected_generation: 2 }),
      service().decide(identity, current.id, "ACCEPT", { expected_revision: 1 })]);
    assert.equal(acceptRace[0]?.status, "rejected"); assert.equal(acceptRace[1]?.status, "fulfilled");
    const rescueLoser = acceptRace[0]; assert.ok(rescueLoser && rescueLoser.status === "rejected" && conflict(rescueLoser.reason));
    const assigned = await db("delivery_operation").where({ id: capacityId }).first();
    await assert.rejects(service().rescue(actor.id, capacityId, { ...await input(blocked), expected_revision: assigned.revision, expected_generation: assigned.generation }), conflict);
    // An existing worker follows the reopened search, never an alternate engine.
    await new DispatchOrchestrator(scope()).runBatch([blocked]); // stranded rows remain stranded; no automatic rescue.
    assert.equal((await db("delivery_operation").where({ id: blocked }).first()).generation, 1);
    console.log("M23-C passed: PostgreSQL rescue replay/races/rollback, sequential generations, M15 offer identity and capacity fences. Native commerce read ports are controlled fixtures; no public financial history changed.");
  } catch (error) {
    const evidence = diagnosticDelivery ? await Promise.allSettled([
      db("delivery_operation").where({ id: diagnosticDelivery }).first("id", "generation", "revision", "status"),
      db("dispatch_commitment").where({ delivery_id: diagnosticDelivery }).count("* as count").first(),
      db("dispatch_event").where({ target_type: "DELIVERY", target_id: diagnosticDelivery }).count("* as count").first(),
      db("dispatch_commitment").where({ driver_profile_id: "driver_fixture" }).whereIn("status", ["OFFERED", "ASSIGNED"]).count("* as count").first(),
    ]) : [];
    console.error("M23-C failure: " + JSON.stringify({ scenario: currentScenario, delivery: diagnosticDelivery, rejection: offerDiagnosticError(error), concurrent_offer: concurrentOfferDiagnostic,
      evidence: evidence.map((outcome, index) => ({ source: ["delivery", "commitment_count", "audit_count", "active_capacity_count"][index],
        ...(outcome.status === "fulfilled" ? { value: outcome.value ?? null } : { available: false, error: offerDiagnosticError(outcome.reason) }) })) }));
    throw error;
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await root.raw("drop schema if exists ?? cascade", [schema]); await db.destroy();
    await auth.deleteAuthIdentities([identity]); await users.deleteUsers([actor.id]);
  }
}
