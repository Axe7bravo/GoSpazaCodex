import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, IAuthModuleService, IUserModuleService, ICustomerModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { DriverService } from "../modules/marketplace/driver-service";
import type MarketplaceService from "../modules/marketplace/service";
import { DriverPayments } from "../lib/driver-payment";
import { driverCompensationSql } from "../modules/marketplace/driver-compensation-schema";
import { driverPaymentSql } from "../modules/marketplace/driver-payment-schema";
import { driverFinanceFixtureSchema, driverFinanceManifestPath, driverFinancePassword, type DriverFinanceManifest, type DriverFinanceActorName } from "./fixtures/driver-finance-acceptance";

export default async function prepareDriverFinance({ container }: ExecArgs) {
  const output = driverFinanceManifestPath(), schema = driverFinanceFixtureSchema("m21_acceptance_" + randomUUID().replaceAll("-", ""));
  try { await access(output); throw new Error("Manifest exists. Choose a fresh M21_BROWSER_MANIFEST."); }
  catch (e) { if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT") throw e; }
  const base = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER), customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  assert.ok(await base.schema.hasTable("driver_payment"), "Apply M21-D migrations first.");
  const actors = {} as DriverFinanceManifest["actors"];
  const drivers = new DriverService(container);
  for (const name of ["operator", "viewer", "manager", "recorder", "reconciler", "driver", "apiDriver", "foreign", "revoked", "merchant", "customer"] as DriverFinanceActorName[]) {
    const email = "m21-" + name + "-" + randomUUID() + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password: driverFinancePassword(email) } });
    assert.ok(registered.authIdentity); const identity = registered.authIdentity.id;
    let id = identity;
    if (["operator", "viewer", "manager", "recorder", "reconciler"].includes(name)) {
      const user = await users.createUsers({ email }); id = user.id; await auth.updateAuthIdentities({ id: identity, app_metadata: { user_id: id } });
    } else if (name === "customer") {
      const customer = await customers.createCustomers({ email }); id = customer.id; await auth.updateAuthIdentities({ id: identity, app_metadata: { customer_id: id } });
    }
    actors[name] = { id, identity, email };
  }
  for (const name of ["driver", "apiDriver", "foreign", "revoked"] as const) {
    const actor = actors[name], principal = { type: "driver" as const, identity: actor.identity };
    let account = await drivers.bootstrap(actor.identity);
    const revision = () => account.profile.revision;
    await drivers.mutate(principal, "EDIT", { expected_revision: revision(), display_name: "Synthetic M21 driver", contact_phone: "+27821234567" });
    account = await drivers.own(actor.identity);
    await drivers.mutate(principal, "REQUEST", { expected_revision: revision(), kind: "PLATFORM" }); account = await drivers.own(actor.identity);
    await drivers.mutate(principal, "SUBMIT", { expected_revision: revision() }); account = await drivers.own(actor.identity);
    await drivers.mutate({ type: "user", id: actors.operator.id }, "APPROVE", { expected_revision: revision(), confirmed: true, reason: "Synthetic M21 acceptance" }, account.profile.id);
    account = await drivers.own(actor.identity); actor.profile = account.profile.id;
    if (name === "driver") await drivers.mutate({ type: "user", id: actors.operator.id }, "SUSPEND", { expected_revision: revision(), confirmed: true, reason: "M21 historical-read suspension fixture" }, account.profile.id);
  }
  const market = container.resolve<MarketplaceService>("marketplace"), merchantActor = actors.merchant;
  const application = await market.createDraft(merchantActor.identity); assert.ok(application);
  await market.edit(application.id, merchantActor.identity, { legal_name: "M21 synthetic merchant", trading_name: "M21 fixture store", contact_name: "Fixture",
    contact_email: merchantActor.email, contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Fixture", province: "Free State",
    postal_code: "9300", country_code: "ZA", intends_to_sell_alcohol: false, notes: "Synthetic M21 actor boundary" });
  await market.submit(application.id, merchantActor.identity); await market.review(application.id, actors.operator.id, "start-review");
  const tenant = await market.provision(application.id, actors.operator.id, "Isolated M21 merchant actor fixture"); merchantActor.id = tenant.merchant.id;
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 4 } });
  const grant = process.env.DRIVER_PAYMENT_RECORD_USER_IDS;
  try {
    await base.raw("create schema ??", [schema]);
    await db.raw("create table m21_acceptance_marker(version integer primary key check(version=1))"); await db("m21_acceptance_marker").insert({ version: 1 });
    // C input-contract fixtures; C provenance was already user-verified. No
    // public C row/guard is modified and no rate/completion is fabricated there.
    await db.raw(`create table driver_earning(id text primary key,driver_profile_id text not null references public.driver_profile(id),delivery_id text not null unique,
      order_id text not null unique,payer text not null default 'GOSPAZA',payer_classification text not null default 'PLATFORM',currency text not null default 'zar',earning_type text not null default 'SUCCESSFUL_DELIVERY',
      amount_minor bigint not null,snapshot_id text not null,terms_revision integer not null,economic_at timestamptz not null,recorded_at timestamptz not null)`);
    await db.raw("create table driver_earning_exception(id text primary key,delivery_id text not null,driver_profile_id text,reason text not null,recorded_at timestamptz default clock_timestamp())");
    for (const sql of [...driverCompensationSql, ...driverPaymentSql]) await db.raw(sql);
    await db.raw("create trigger m21_fixture_earning_immutable before update or delete on driver_earning for each row execute function gospaza_driver_payment_immutable()");
    const earnings = {} as DriverFinanceManifest["earnings"];
    for (const name of ["api", "apiBlocked", "browser", "readonly", "foreign", "revoked"] as const) {
      const owner = name === "api" || name === "apiBlocked" ? actors.apiDriver : name === "foreign" || name === "browser" ? actors.foreign : name === "revoked" ? actors.revoked : actors.driver;
      assert.ok(owner.profile); earnings[name] = ["m21_" + name + "_a", "m21_" + name + "_b"];
      if (name === "readonly") earnings[name].push("m21_readonly_c");
      await db("driver_earning").insert(earnings[name].map(id => ({ id, driver_profile_id: owner.profile, delivery_id: id + "_delivery", order_id: id + "_order", amount_minor: 5000,
        snapshot_id: "fixture_snapshot_" + id, terms_revision: 1, economic_at: "2026-01-01T00:00:00Z", recorded_at: "2026-01-02T00:00:00Z" })));
    }
    process.env.DRIVER_PAYMENT_RECORD_USER_IDS = actors.operator.id;
    const payments = new DriverPayments(container, db);
    const transfer = async (ids: string[]) => {
      const { rows: [clock] } = await db.raw("select clock_timestamp() as instant");
      return { request_id: randomUUID(), confirmed: true, reason: "Synthetic immutable driver history", earning_ids: ids, amount_minor: 5000,
        currency: "zar", beneficiary_reference: "m21_private_beneficiary", channel: "BANK_TRANSFER", origin_reference: "m21_private_origin", external_transfer_id: "m21_bank_" + randomUUID(),
        transferred_at: new Date(clock.instant).toISOString(), evidence_reference: "m21_private_evidence" };
    };
    const first = earnings.readonly[0], second = earnings.readonly[1]; assert.ok(first && second);
    await payments.record(actors.operator.id, "RECORD", await transfer([first]));
    await payments.record(actors.operator.id, "UNKNOWN", await transfer([second]));
    await db("driver_earning_exception").insert({ id: "m21_review", delivery_id: "m21_review_delivery", driver_profile_id: actors.driver.profile, reason: "SNAPSHOT_MISSING" });
    const manifest: DriverFinanceManifest = { version: 1, schema, actors, earnings };
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(manifest), { flag: "wx" });
    await writeFile(join(dirname(output), "m21-current-manifest.txt"), output);
    console.log("M21 fresh acceptance manifest:", output);
  } finally { if (grant === undefined) delete process.env.DRIVER_PAYMENT_RECORD_USER_IDS; else process.env.DRIVER_PAYMENT_RECORD_USER_IDS = grant; await db.destroy(); }
}
