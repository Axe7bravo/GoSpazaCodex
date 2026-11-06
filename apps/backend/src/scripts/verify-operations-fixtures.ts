import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, MedusaContainer, IAuthModuleService, IUserModuleService, ICustomerModuleService, IOrderModuleService, ICartModuleService, IProductModuleService, IFulfillmentModuleService, IFileModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type MarketplaceService from "../modules/marketplace/service";
import { validateDocument } from "../modules/marketplace/validation";
import { ensureCommerce } from "../lib/commerce";
import { DriverService } from "../modules/marketplace/driver-service";
import { DispatchService } from "../lib/dispatch-service";
import { pickingFingerprint } from "../modules/marketplace/picking-policy";
import { operationsActors, operationsCases, operationsOutput, operationsSchema, type OperationsActor, type OperationsManifest } from "./fixtures/operations-acceptance";
import { createOperationsSchema } from "./fixtures/operations-schema";

export default async function verifyOperationsFixtures({ container }: ExecArgs) {
  const run = randomUUID().replaceAll("-", ""), schema = operationsSchema("m23_acceptance_" + run);
  assert.equal(process.env.APPLICATION_FILES_PROVIDER, "local", "Use the M23-D environment launcher for local private fixture documents.");
  const root = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await root.schema.hasTable("delivery_rescue_command"), "Apply the user-verified M23-C migration first.");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH), users = container.resolve<IUserModuleService>(Modules.USER), customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const orders = container.resolve<IOrderModuleService>(Modules.ORDER), carts = container.resolve<ICartModuleService>(Modules.CART), products = container.resolve<IProductModuleService>(Modules.PRODUCT);
  const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT), market = container.resolve<MarketplaceService>("marketplace"), files = container.resolve<IFileModuleService>(Modules.FILE);
  const seed = randomBytes(32).toString("hex"), password = (email: string) => createHmac("sha256", seed).update(email).digest("hex");
  const actors = {} as OperationsManifest["actors"], cases = {} as OperationsManifest["cases"];
  const saved = new Map<string, string | undefined>(), grant = (name: string, id: string) => { const key = name + "_USER_IDS"; saved.set(key, process.env[key]); process.env[key] = id; };
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
  async function actor(name: string, type: OperationsActor["type"]): Promise<OperationsActor> {
    const email = "m23-" + name.toLowerCase() + "-" + run + "@example.test", registered = await auth.register("emailpass", { body: { email, password: password(email) } }); assert.ok(registered.authIdentity);
    const identity = registered.authIdentity.id;
    const id = type === "user" ? (await users.createUsers({ email })).id : type === "customer" ? (await customers.createCustomers({ email, has_account: true })).id : identity;
    if (type === "user" || type === "customer") await auth.updateAuthIdentities({ id: identity, app_metadata: { [type + "_id"]: id } });
    return { id, identity, email, type };
  }
  try {
    for (const name of operationsActors) actors[name] = await actor(name, name === "customer" ? "customer" : name === "merchant" ? "merchant" : "user");
    for (const name of ["MERCHANT_REVIEW_VIEW", "MERCHANT_REVIEW_MANAGE", "DRIVER_REVIEW_VIEW", "DRIVER_REVIEW_MANAGE"]) grant(name, actors.legacy.id);
    // Real owner and private native File operations for representative legacy
    // acceptance. No simulated document stream or forged platform principal.
    const draft = await market.createDraft(actors.merchant.identity); assert.ok(draft);
    await market.edit(draft.id, actors.merchant.identity, { legal_name: "M23 fixture " + run, trading_name: "M23 operational store", contact_name: "Fixture",
      contact_email: actors.merchant.email, contact_phone: "0123456789", address_line_1: "1 Fixture Street", address_line_2: "", city: "Fixture", province: "Free State",
      postal_code: "9300", country_code: "ZA", intends_to_sell_alcohol: false, notes: "private_sentinel" });
    const pdf = Buffer.from("%PDF-1.4\nM23 private_sentinel fixture\n%%EOF");
    const uploaded = await market.upload(draft.id, actors.merchant.identity, validateDocument({ document_type: "BUSINESS_REGISTRATION", display_name: "Synthetic private document", mime_type: "application/pdf", content: pdf.toString("base64") }), files);
    const document = uploaded.documents[0]; assert.ok(document);
    await market.submit(draft.id, actors.merchant.identity); await market.review(draft.id, actors.legacy.id, "start-review");
    const tenant = await market.provision(draft.id, actors.legacy.id, "M23 isolated native actor fixture");
    const commerce = await ensureCommerce(container, tenant.merchant.id);
    const set = await fulfillment.createFulfillmentSets({ name: "m23-" + run, type: "shipping" });
    const nativeZone = await fulfillment.createServiceZones({ name: "m23-" + run, fulfillment_set_id: set.id, geo_zones: [{ type: "country", country_code: "za" }] });
    const profile = await fulfillment.createShippingProfiles({ name: "m23-" + run, type: "default" });
    const [shipping] = await fulfillment.createShippingOptions([{ name: "M23 delivery", price_type: "flat", service_zone_id: nativeZone.id, shipping_profile_id: profile.id, provider_id: "manual_manual", type: { label: "M23 delivery", code: "m23_fixture" } }]); assert.ok(shipping);
    const product = await products.createProducts({ title: "M23 fixture groceries", status: "published", options: [{ title: "Size", values: ["Standard"] }], variants: [{ title: "Standard", options: { Size: "Standard" } }] });
    const fullProduct = await products.retrieveProduct(product.id, { relations: ["variants"] }), variant = fullProduct.variants?.[0]; assert.ok(variant);
    await createOperationsSchema(root, db, schema); await db("m23_acceptance_marker").insert({ run, version: 1 });
    for (const [table, id] of [["merchant_application", draft.id], ["merchant", tenant.merchant.id], ["merchant_store", tenant.store.id]] as const) {
      const row = await root(table).where({ id }).first(); assert.ok(row); await db(table).insert(row);
    }
    const zone = "zone_" + run, mapping = "mapping_" + run, option = "option_" + run, slot = "slot_" + run, now = new Date();
    await db("marketplace_service_zone").insert({ id: zone, name: "M23 operational area", active: true, delivery_fee_minor: 0, currency_code: "zar", geometry: JSON.stringify({ type: "Polygon", coordinates: [[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]] }) });
    await db("merchant_store_service_zone").insert({ id: mapping, merchant_store_id: tenant.store.id, service_zone_id: zone, active: true, medusa_service_zone_id: nativeZone.id });
    await db("delivery_option_configuration").insert({ id: option, merchant_store_id: tenant.store.id, store_service_zone_id: mapping, mode: "ASAP", medusa_shipping_option_id: shipping.id });
    await db("delivery_slot").insert({ id: slot, merchant_store_id: tenant.store.id, start_at: now, end_at: new Date(now.getTime() + 86400000) });
    await db.transaction(async trx => {
      await trx("store_dispatch_configuration").insert({ id: "config_" + run, merchant_store_id: tenant.store.id, mode: "PLATFORM_ONLY", revision: 1 });
      await trx("dispatch_event").insert({ id: "config_event_" + run, target_type: "CONFIGURATION", target_id: "config_" + run, revision: 1, action: "CONFIGURED", actor_type: "system", occurred_at: now, evidence: {} });
    });
    const scoped = container.createScope() as MedusaContainer; scoped.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    const dispatch = new DispatchService(scoped), drivers = new DriverService(container);
    const address = { first_name: "Fixture", last_name: "Customer", address_1: "1 Fixture Street", address_2: "", city: "Fixture", province: "Free State", postal_code: "9300", country_code: "za", phone: "+27820000000" };
    for (const name of operationsCases) {
      const driver = await actor("driver-" + name, "driver"), principal = { type: "driver" as const, identity: driver.identity };
      let account = await drivers.bootstrap(driver.identity);
      account = await drivers.mutate(principal, "EDIT", { expected_revision: account.profile.revision, display_name: "M23 fixture driver", contact_phone: "+27820000000" });
      account = await drivers.mutate(principal, "REQUEST", { expected_revision: account.profile.revision, kind: "PLATFORM" });
      account = await drivers.mutate(principal, "SUBMIT", { expected_revision: account.profile.revision });
      account = await drivers.mutate({ type: "user", id: actors.legacy.id }, "APPROVE", { expected_revision: account.profile.revision, confirmed: true, reason: "M23 native actor fixture" }, account.profile.id);
      const profileId = account.profile.id; driver.profile = profileId;
      const publicProfile = await root("driver_profile").where({ id: profileId }).first(), affiliation = await root("driver_affiliation").where({ driver_profile_id: profileId, status: "ACTIVE" }).first(); assert.ok(publicProfile && affiliation);
      await db("driver_profile").insert(publicProfile); await db("driver_affiliation").insert(affiliation);
      const createdCart = await carts.createCarts({ currency_code: "zar", customer_id: actors.customer.id, sales_channel_id: commerce.channelId, items: [{ title: "M23 fixture groceries", variant_id: variant.id, quantity: 1, unit_price: 1 }] });
      const cart = await carts.retrieveCart(createdCart.id, { relations: ["items"] });
      await carts.updateCarts(cart.id, { completed_at: now });
      const createdOrder = await orders.createOrders({ currency_code: "zar", customer_id: actors.customer.id, sales_channel_id: commerce.channelId, email: actors.customer.email, shipping_address: address,
        no_notification: true, items: [{ title: "M23 fixture groceries", variant_id: variant.id, product_id: product.id, quantity: 1, unit_price: 1 }], shipping_methods: [{ name: "M23 delivery", amount: 0, shipping_option_id: shipping.id }] });
      const order = await orders.retrieveOrder(createdOrder.id, { relations: ["items"] }), item = order.items?.[0], cartItem = cart.items?.[0]; assert.ok(item && cartItem);
      await container.resolve<{ create(input: Record<string, Record<string, string>>): Promise<unknown> }>(ContainerRegistrationKeys.LINK).create({ [Modules.ORDER]: { order_id: order.id }, [Modules.CART]: { cart_id: cart.id } });
      const context = "context_" + name + "_" + run, hold = "hold_" + name + "_" + run, operation = "operation_" + name + "_" + run, session = "pick_" + name + "_" + run, completion = "completion_" + name + "_" + run;
      const snapshot = { customer_id: actors.customer.id, cart_id: cart.id, cart_context_id: context, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id, address_id: "address_" + run, address,
        reservation_id: hold, reservation_revision: 1, configuration_revision: 1, delivery_option_id: option, shipping_option_id: shipping.id, shipping_method_id: "method_" + run, currency_code: "zar",
        totals: { total_minor: 100, subtotal_minor: 100, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 0 }, items: [{ id: cartItem.id, variant_id: variant.id, quantity: 1, unit_price_minor: 100, total_minor: 100 }],
        restricted_commerce: { version: 1, restricted_content_present: false, classifications: [{ product_id: product.id, variant_id: variant.id, revision_id: "classification_" + run, restriction: "NONE", alcohol_class: null }], registration_id: null, registration_revision: null, trading_policy_version: null, purchaser_evidence_id: null } };
      // M10 source-contract fixture only. Native Order/Cart/links are real;
      // no Yoco operation, public paid receipt or financial settlement is created.
      const receipt = { order_id: order.id, cart_id: cart.id, payment_id: "fixture_payment_" + name, capture_id: "fixture_capture_" + name, payment_collection_id: "fixture_collection_" + name,
        amount_minor: 100, currency: "zar", workflow_id: "m23_source_contract", transaction_id: name, execution_id: "fixture_execution", run_id: run, verified_at: now.toISOString() };
      await db("cart_marketplace_context").insert({ id: context, medusa_cart_id: cart.id, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id });
      await db("delivery_reservation").insert({ id: hold, cart_context_id: context, medusa_order_id: order.id, merchant_store_id: tenant.store.id, status: "COMMITTED", payment_accepted_at: now, store_service_zone_id: mapping, delivery_option_id: option, delivery_slot_id: slot, latitude: 0, longitude: 0 });
      await db("checkout_attempt").insert({ id: "attempt_" + name + "_" + run, cart_context_id: context, medusa_cart_id: cart.id, reservation_id: hold, state: "COMPLETED", closed_at: now, payment_accepted_at: now, snapshot: JSON.stringify(snapshot) });
      await db("checkout_completion").insert({ id: completion, checkout_attempt_id: "attempt_" + name + "_" + run, order_id: order.id, state: "SUCCEEDED", native_state: "done", terminal_receipt: JSON.stringify(receipt), workflow_id: receipt.workflow_id, transaction_id: name, execution_id: receipt.execution_id, run_id: run });
      await db("order_operation").insert({ id: operation, medusa_order_id: order.id, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id, checkout_completion_id: completion, status: "ACCEPTED", revision: 1 });
      await db("order_decision_event").insert({ id: "decision_" + name + "_" + run, order_operation_id: operation, decided_at: now, to_status: "ACCEPTED" });
      await db("pick_session").insert({ id: session, order_operation_id: operation, status: "COMPLETED", completed_at: now, revision: 1, source_lines_fingerprint: pickingFingerprint([{ id: item.id, variant_id: variant.id, quantity: 1 }]) });
      await db("pick_line").insert({ id: "line_" + name + "_" + run, pick_session_id: session, medusa_order_line_id: item.id, ordered_quantity_at_start: 1, picked_quantity: 1, shortage_recorded: false });
      await db("pick_event").insert({ id: "pick_event_" + name + "_" + run, pick_session_id: session, revision: 1, action: "COMPLETE", occurred_at: now });
      const delivery = await dispatch.ensure(order.id); await db("dispatch_work").insert({ delivery_id: delivery.id }); await dispatch.start(delivery.id);
      let availability = await dispatch.intent(driver.identity, true, { expected_revision: 0 }); assert.ok(availability.generation);
      availability = await dispatch.location(driver.identity, { generation: availability.generation, sequence: 1, latitude: 0, longitude: 0 });
      const offer = await dispatch.offer(delivery.id, profileId);
      await dispatch.decide(driver.identity, offer.id, "DECLINE", { expected_revision: 1 });
      availability = await dispatch.readAvailability(driver.identity); await dispatch.intent(driver.identity, false, { expected_revision: availability.revision });
      await dispatch.advance(delivery.id, true);
      const stranded = await db("delivery_operation").where({ id: delivery.id }).first(); assert.equal(stranded.status, "ATTENTION_REQUIRED"); assert.equal(stranded.reason, "POOL_EXHAUSTED");
      cases[name] = { order: order.id, cart: cart.id, delivery: delivery.id, driver, old_offer: offer.id, request_id: randomUUID(), revision: stranded.revision, generation: stranded.generation, reason: stranded.reason };
    }
    // Private source sentinels for exclusion/allowlist proofs, not economic mutations.
    await db("financial_adjustment").insert({ id: "adjustment_" + run, medusa_order_id: cases.read.order, status: "REVIEW_REQUIRED", amount_minor: 6342, currency: "zar", reason: "GOODWILL", default_method: "STORE_CREDIT" });
    await db("financial_adjustment_event").insert({ id: "finance_event_" + run, adjustment_id: "adjustment_" + run, occurred_at: now, evidence: { private_sentinel: true, bank: "private_sentinel" } });
    await db("driver_payment").insert({ id: "payment_" + run, initial_outcome: "UNKNOWN", amount_minor: 100, currency: "zar", recorded_at: now });
    await db("notification_intent").insert({ id: "notice_" + run, kind: "ORDER_CONFIRMED", channel: "EMAIL", created_at: now });
    await db("notification_delivery").insert({ intent_id: "notice_" + run, state: "ATTENTION_REQUIRED" });
    await db("notification_worker_health").insert({ name: "delivery", last_success_at: now, last_error: null });
    const directory = resolve(operationsOutput, run); await mkdir(directory, { recursive: true });
    const manifest: OperationsManifest = { version: 1, run, schema, database: "gospaza_m18_c2b_test", api_state: "READY", actors, cases, merchant: tenant.merchant.id, store: tenant.store.id,
      application: draft.id, document: document.id, zone, restricted_payment: "payment_" + run, restricted_notification: "notice_" + run, health_at: now.toISOString() };
    await writeFile(resolve(directory, "credentials.json"), JSON.stringify({ run, seed }), { flag: "wx", mode: 0o600 });
    await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await mkdir(operationsOutput, { recursive: true }); await writeFile(resolve(operationsOutput, "current.json"), JSON.stringify({ run }), { mode: 0o600 });
    console.log("M23 fixture selection ready:", JSON.stringify({ run, database: manifest.database, schema, groups: operationsCases, native_readbacks: "real", workers: "disabled" }));
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.destroy();
  }
}
