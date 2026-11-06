import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, IAuthModuleService, ICustomerModuleService, IUserModuleService, IApiKeyModuleService, IOrderModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type MarketplaceService from "../modules/marketplace/service";
import { DriverService } from "../modules/marketplace/driver-service";
import { emailPassEmail } from "../lib/team-http";
import { NotificationFoundation } from "../lib/notification-foundation";
import { notificationSql } from "../modules/marketplace/notification-schema";
import { notificationMappingSql } from "../modules/marketplace/notification-mapping-schema";
import { notificationRuntimeSql } from "../modules/marketplace/notification-runtime-schema";
import { digest, REPLAY_MS, type Actor } from "../lib/notification-policy";
import { m22Root, notificationAcceptanceSchema, notificationActorNames, notificationSelectionPath, type NotificationManifest } from "./fixtures/notification-acceptance";

export default async function prepareNotificationFixtures({ container }: ExecArgs) {
  const run = randomUUID().replaceAll("-", ""), schema = notificationAcceptanceSchema("m22_acceptance_" + run);
  const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  assert.equal(database, "gospaza_m18_c2b_test", "Select the established M22 isolated database explicitly.");
  const base = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("notification_worker_health"), "Apply the verified M22-D schema first.");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH), users = container.resolve<IUserModuleService>(Modules.USER);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER), market = container.resolve<MarketplaceService>("marketplace");
  const seed = randomBytes(32).toString("hex"), password = (email: string) => createHmac("sha256", seed).update(email).digest("hex");
  const actors = {} as NotificationManifest["actors"];
  for (const name of notificationActorNames) {
    const type = /customer/i.test(name) ? "customer" : /merchant|picker/i.test(name) ? "merchant" : /driver/i.test(name) ? "driver" : "user";
    const email = "m22-" + name.toLowerCase() + "-" + run + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password: password(email) } }); assert.ok(registered.authIdentity);
    const identity = registered.authIdentity.id; let id = identity;
    if (type === "user") { id = (await users.createUsers({ email })).id; await auth.updateAuthIdentities({ id: identity, app_metadata: { user_id: id } }); }
    else if (type === "customer") { id = (await customers.createCustomers({ email, has_account: true })).id; await auth.updateAuthIdentities({ id: identity, app_metadata: { customer_id: id } }); }
    actors[name] = { id, identity, email, type };
  }
  for (const name of ["merchant", "foreignMerchant"] as const) {
    const owner = actors[name], draft = await market.createDraft(owner.identity); assert.ok(draft);
    await market.edit(draft.id, owner.identity, { legal_name: "M22 notification acceptance " + name, trading_name: "Notification fixture store", contact_name: "Fixture",
      contact_email: owner.email, contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Fixture", province: "Free State",
      postal_code: "9300", country_code: "ZA", intends_to_sell_alcohol: false, notes: "Synthetic notification acceptance" });
    await market.submit(draft.id, owner.identity); await market.review(draft.id, actors.operator.id, "start-review");
    const tenant = await market.provision(draft.id, actors.operator.id, "M22 isolated actor fixture"); owner.member = tenant.membership.id;
  }
  for (const name of ["picker", "revokedMerchant"] as const) {
    const actor = actors[name];
    const invitation = await market.teamService.invite(actors.merchant.identity, { email: actor.email, role: name === "picker" ? "PICKER" : "MANAGER" }, identity => emailPassEmail(auth, identity));
    actor.member = (await market.teamService.accept(actor.identity, actor.email, { token: invitation.token })).member_id;
  }
  const drivers = new DriverService(container);
  for (const name of ["driver", "browserDriver", "foreignDriver", "revokedDriver"] as const) {
    const actor = actors[name], principal = { type: "driver" as const, identity: actor.identity };
    let account = await drivers.bootstrap(actor.identity);
    await drivers.mutate(principal, "EDIT", { expected_revision: account.profile.revision, display_name: "Notification fixture driver", contact_phone: "+27821234567" });
    account = await drivers.own(actor.identity);
    await drivers.mutate(principal, "REQUEST", { expected_revision: account.profile.revision, kind: "PLATFORM" }); account = await drivers.own(actor.identity);
    await drivers.mutate(principal, "SUBMIT", { expected_revision: account.profile.revision }); account = await drivers.own(actor.identity);
    await drivers.mutate({ type: "user", id: actors.operator.id }, "APPROVE", { expected_revision: account.profile.revision, confirmed: true, reason: "M22 native identity fixture" }, account.profile.id);
    actor.profile = account.profile.id;
  }
  const nativeOrder = await container.resolve<IOrderModuleService>(Modules.ORDER).createOrders({ currency_code: "zar", customer_id: actors.foreignCustomer.id, email: actors.foreignCustomer.email });
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY), key = await keys.createApiKeys({ title: "M22 acceptance " + run, type: "publishable", created_by: "" });
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 4 } });
  try {
    await base.raw("create schema ??", [schema]);
    await db.raw("create table m22_acceptance_marker(version integer primary key,run text not null)"); await db("m22_acceptance_marker").insert({ version: 1, run });
    for (const sql of [...notificationSql, ...notificationMappingSql, ...notificationRuntimeSql.filter(sql => !sql.startsWith("create index notification_discovery_"))]) await db.raw(sql);
    await db.raw("create table fixture_clock(instant timestamptz not null)");
    await db("fixture_clock").insert({ instant: new Date(Date.now() - REPLAY_MS - 120000) });
    await db.raw("create or replace function gospaza_notification_now() returns timestamptz as $fixture$ begin return (select instant from fixture_clock); end; $fixture$ language plpgsql");
    // Terminal M15 read-contract fixtures only, deliberately incapable of being
    // assigned. The real HTTP workflow must reject their stale revision/state.
    // C/D provenance is already verified; E does not fabricate public dispatch,
    // financial or fulfillment records to retest those milestones.
    await db.raw("create table order_operation(id text primary key)"); await db.raw("create table pick_session(id text primary key)");
    await db.raw(`create table delivery_operation(id text primary key,order_operation_id text,pick_session_id text,merchant_id text,merchant_store_id text,
      status text not null check(status='ATTENTION_REQUIRED'),generation integer not null,revision integer not null,pickup_managed boolean default false)`);
    await db.raw(`create table dispatch_commitment(id text primary key,delivery_id text not null references delivery_operation(id),driver_profile_id text not null references public.driver_profile(id),
      status text not null check(status='EXPIRED'),generation integer not null,revision integer not null,expires_at timestamptz not null,
      assigned_at timestamptz,updated_at timestamptz not null default clock_timestamp())`);
    const tenant = await market.resolveTenant(actors.merchant.identity), offers = { api: "offer_api_" + run, browser: "offer_browser_" + run };
    for (const [which, name] of [["api", "driver"], ["browser", "browserDriver"]] as const) {
      const delivery = "delivery_" + which + "_" + run, operation = "operation_" + which, session = "picking_" + which;
      await db("order_operation").insert({ id: operation }); await db("pick_session").insert({ id: session });
      await db("delivery_operation").insert({ id: delivery, order_operation_id: operation, pick_session_id: session, merchant_id: tenant.merchant.id,
        merchant_store_id: tenant.store.id, status: "ATTENTION_REQUIRED", generation: 1, revision: 3 });
      await db("dispatch_commitment").insert({ id: offers[which], delivery_id: delivery, driver_profile_id: actors[name].profile,
        status: "EXPIRED", generation: 1, revision: 2, expires_at: new Date(Date.now() - 60000) });
    }
    const foundation = new NotificationFoundation(db, { APP_ENV: "test", NOTIFICATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "m22-controlled-provider", RESEND_FROM_EMAIL: "sender@example.test" }, async actor => actor === actors.operator.id);
    await foundation.activate(actors.operator.id, { request_id: "activate", reason: "M22 isolated presentation input-contract fixtures" });
    const notices: Record<string, string> = {};
    const create = async (name: string, recipient: Actor, template: string, kind: string, channel: "IN_APP" | "EMAIL" = "IN_APP", link: { route: "CUSTOMER_ORDER" | "MERCHANT_ORDER" | "MERCHANT_PICKING" | "DRIVER_CURRENT"; resource: string } | null = null, destination: string | null = "private-recipient@example.test") => {
      const { rows: [clock] } = await db.raw("select gospaza_notification_now() as instant");
      const row = await foundation.create({ source: { type: "m22_acceptance", id: name, transition: "FROZEN", committed_at: new Date(clock.instant).toISOString(), evidence: digest({ run, name }) },
        recipient, template, kind, version: 1, channel, destination: channel === "EMAIL" ? destination : null,
        input: { reference: name === "customer" ? '<img src=x onerror="alert(1)">' : "notification acceptance" }, link });
      assert.ok(row); notices[name] = row.id; return row.id;
    };
    for (const name of ["customer", "apiCustomer", "foreignCustomer", "revokedCustomer"] as const) await create(name, { type: "customer", id: actors[name].id }, "customer.order_confirmed", "ORDER_CONFIRMED", "IN_APP", { route: "CUSTOMER_ORDER", resource: nativeOrder.id });
    for (const name of ["merchant", "foreignMerchant", "revokedMerchant"] as const) {
      const member = actors[name].member; assert.ok(member); await create(name, { type: "merchant", id: member }, "merchant.new_order", "NEW_ORDER_REQUIRING_ACTION", "IN_APP", { route: "MERCHANT_ORDER", resource: nativeOrder.id });
    }
    const picker = actors.picker.member; assert.ok(picker);
    await create("picker", { type: "merchant", id: picker }, "merchant.fulfilment_attention", "PICKING_OR_FULFILMENT_ATTENTION", "IN_APP", { route: "MERCHANT_PICKING", resource: nativeOrder.id });
    await create("merchant_finance", { type: "merchant", id: tenant.membership.id }, "merchant.settlement_ready", "SETTLEMENT_READY_OR_ATTENTION");
    for (const name of ["driver", "browserDriver", "foreignDriver", "revokedDriver"] as const) {
      const profile = actors[name].profile; assert.ok(profile);
      await create(name, { type: "driver", id: profile }, "driver.dispatch_offer", "DISPATCH_OFFER_CREATED", "IN_APP", { route: "DRIVER_CURRENT", resource: offers[name === "browserDriver" ? "browser" : "api"] });
    }
    const customer = { type: "customer" as const, id: actors.apiCustomer.id };
    const accepted = await create("ops_accepted", customer, "customer.order_confirmed", "ORDER_CONFIRMED", "EMAIL");
    await foundation.execute(accepted, { send: async () => ({ classification: "ACCEPTED", providerId: "m22_provider_" + run }) });
    await create("ops_suppressed", customer, "customer.order_confirmed", "ORDER_CONFIRMED", "EMAIL", null, null);
    const unknown = await create("ops_attention", customer, "customer.order_confirmed", "ORDER_CONFIRMED", "EMAIL");
    // A private clock proves outside-window ambiguity without sleeping or
    // changing any public domain/provider clock or retry policy.
    const claim = await foundation.claim(unknown); assert.ok(claim); await foundation.begin(claim);
    await db("fixture_clock").update({ instant: new Date() }); await foundation.recoverExpired(unknown);
    // Use real current time for subsequent inbox reads; uncertainty state is
    // persisted and immutable attempt evidence remains historical.
    await db.raw("create or replace function gospaza_notification_now() returns timestamptz as $fixture$ begin return pg_catalog.clock_timestamp(); end; $fixture$ language plpgsql");
    const output = resolve(m22Root, "test-results/m22", run), credentialsFile = resolve(output, "credentials.json"), file = resolve(output, "manifest.json");
    await mkdir(output, { recursive: true });
    await writeFile(credentialsFile, JSON.stringify({ run, seed }), { flag: "wx", mode: 0o600 });
    const manifest: NotificationManifest = { version: 1, run, schema, database, credentials_file: credentialsFile, publishable_key: key.token,
      api_state: "READY", actors, notices, offers, target_order: nativeOrder.id,
      browser_customer_title: "Order confirmed", browser_driver_title: "Delivery offer available" };
    await writeFile(file, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    const selection = notificationSelectionPath(); await mkdir(dirname(selection), { recursive: true }); await writeFile(selection, JSON.stringify({ manifest: file }), { mode: 0o600 });
    console.log("M22 fresh fixture selected:", JSON.stringify({ selection, run, database, redis_database: 1, workers: "disabled", email: "controlled only" }));
  } finally { await db.destroy(); }
}
