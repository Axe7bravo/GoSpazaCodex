import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, MedusaContainer, IProductModuleService, IFileModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { driverCompensationSql } from "../modules/marketplace/driver-compensation-schema";
import { driverEarningSql } from "../modules/marketplace/driver-earning-schema";
import { DriverCompensation } from "../lib/driver-compensation";
import { DriverEarnings } from "../lib/driver-earning";
import { DispatchService } from "../lib/dispatch-service";
import { PickupService } from "../lib/pickup-service";
import { HandoffService } from "../lib/handoff-service";
import { RecipientService } from "../lib/recipient-service";
import { RestrictedCommerce } from "../lib/restricted-commerce";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { handoffSecret } from "../modules/marketplace/handoff-policy";
import type { PurchaserEligibilityProvider, PurchaserEvidence } from "../modules/marketplace/restricted-policy";
import recognizeDriverDelivery from "../subscribers/recognize-driver-delivery";
import verifyPickup from "./verify-pickup";

const decision = (revision: number) => ({ request_id: randomUUID(), expected_revision: revision, confirmed: true, reason: "Synthetic M21-C terms" });
const denied = (e: unknown) => !!e && typeof e === "object" && "type" in e && e.type === "forbidden";

export default async function verifyDriverEarnings(args: ExecArgs) {
  if (process.env.APP_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")) throw new Error("Select the existing isolated _test database explicitly.");
  handoffSecret();
  const base = args.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("driver_earning"), "Apply the M21-C migration first.");
  assert.equal((await base("driver_compensation_activation")).length, 0, "Synthetic terms/activation must stay in the private verifier schema.");
  // Reuse the real native Order/dispatch/pickup fixture and its cleanup. No
  // production handoff/assignment code or existing verifier assertions change.
  await verifyPickup(args, async ({ f, assigned }) => {
    const schema = "m21c_verify_" + randomUUID().replaceAll("-", "");
    await base.raw("create schema ??", [schema]);
    const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
    const scope = args.container.createScope() as MedusaContainer; scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    const dispatch = new DispatchService(scope), pickup = new PickupService(scope), handoff = new HandoffService(scope), recipient = new RecipientService(scope);
    const terms = new DriverCompensation(scope), ledger = new DriverEarnings(scope), commerce = new RestrictedCommerce(scope);
    const keys = ["DRIVER_COMPENSATION_MANAGE_USER_IDS", "DRIVER_EARNINGS_VIEW_USER_IDS", "RESTRICTED_COMMERCE_REVIEWER_IDS", "DELIVERY_DOCUMENT_POLICY_APPROVED", "DELIVERY_DOCUMENT_POLICY_VERSION"];
    const prior = keys.map(k => process.env[k]);
    const ownOrders: string[] = [], purchaserIds: string[] = [];
    let product: string | undefined, fileKey: string | undefined;
    const store = f.orders.fixture.first.store.id;
    async function review(alcohol: boolean) {
      if (!product) throw new Error("Restricted fixture product unavailable.");
      const current = await commerce.classification(f.orders.ownerA.identity, product);
      await commerce.reviewClassification(f.user, store, product, { restriction: alcohol ? "ALCOHOL" : "NONE", alcohol_class: alcohol ? "WINE" : null,
        expected_identity: current.identity_fingerprint, confirmed: true, reason: "Synthetic M21-C classification" });
    }
    async function trip(label: string, merchantDriver = false, restricted = false, afterAssignment?: () => Promise<void>) {
      const config = await dispatch.configuration(f.user, store);
      await dispatch.configure(f.user, store, { expected_revision: config.revision, mode: merchantDriver ? "MERCHANT_ONLY" : "PLATFORM_ONLY", reason: "Focused M21-C native delivery" });
      try {
        const purchaser = restricted ? async (person: { id: string }): Promise<PurchaserEligibilityProvider> => {
          await review(true); const now = await db.transaction(databaseTime);
          const evidence: PurchaserEvidence = { id: "pelig_" + randomUUID(), customer_id: person.id, method: "isolated-m21c-fixture", method_version: "1", policy_version: "fixture-only",
            minimum_age: 18, provincial_requirements_satisfied: true, state: "VERIFIED", verified_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600000).toISOString() };
          purchaserIds.push(evidence.id); const provider: PurchaserEligibilityProvider = { async evaluate() { return { state: "VERIFIED", evidence }; } };
          await new RestrictedCommerce(scope, provider).refreshPurchaser(person.id); return provider;
        } : undefined;
        const a = await assigned("m21c-" + label, 1, 1, merchantDriver, purchaser, dispatch); ownOrders.push(a.order.orderId);
        await afterAssignment?.();
        await pickup.prepare(a.delivery.id);
        const ready = await pickup.read(a.who.identity); assert.ok(ready.pickup); assert.equal(ready.pickup.state, "PICKUP_READY");
        await pickup.pickup(a.who.identity, a.delivery.id, { expected_revision: ready.pickup.revision });
        const moving = await handoff.read(a.who.identity, a.delivery.id);
        await handoff.arrive(a.who.identity, a.delivery.id, { expected_revision: moving.revision });
        return a;
      } finally { if (restricted) await review(false); }
    }
    async function complete(a: Awaited<ReturnType<typeof trip>>, restricted = false) {
      if (restricted) {
        const state = await handoff.read(a.who.identity, a.delivery.id);
        await recipient.verify(a.who.identity, a.delivery.id, { expected_revision: state.revision, recipient_role: "ALTERNATE_ADULT", document_type: "PASSPORT", document_viewed: true,
          date_of_birth: "1990-01-01", school_uniform_observed: false, recipient_declares_school_going_learner: false, recipient_appears_intoxicated: false,
          recipient_refused_verification: false, invoice_address_matches: true });
      }
      const code = await handoff.customerCode(a.order.person.id, a.order.orderId); assert.ok(code.code);
      assert.equal((await handoff.verify(a.who.identity, a.delivery.id, { expected_revision: code.revision, code: code.code })).state, "DELIVERED");
    }
    try {
      for (const sql of [...driverCompensationSql, ...driverEarningSql]) await db.raw(sql);
      process.env.DRIVER_COMPENSATION_MANAGE_USER_IDS = f.user;
      delete process.env.DRIVER_EARNINGS_VIEW_USER_IDS;
      const historical = await trip("historical");
      await complete(historical); assert.equal((await ledger.recognize(historical.order.orderId)).state, "HISTORICAL_REVIEW");
      assert.equal((await db("driver_earning")).length, 0);
      await terms.activate(f.user, decision(0)); await terms.publish(f.user, { ...decision(0), amount_minor: 5000, currency: "zar" });
      assert.equal((await ledger.recognize(historical.order.orderId)).state, "HISTORICAL_REVIEW");
      const a = await trip("rate-a", false, false, async () => { await terms.publish(f.user, { ...decision(1), amount_minor: 6000, currency: "zar" }); });
      await complete(a);
      const earnedA = await ledger.recognize(a.order.orderId); assert.equal(earnedA.state, "EARNED");
      assert.ok(earnedA.id, "Successful recognition must return the persisted earning ID.");
      const rowA = await db("driver_earning").where({ id: earnedA.id }).first(); assert.ok(rowA); assert.equal(String(rowA.amount_minor), "5000");
      assert.equal(rowA.driver_profile_id, a.who.id);
      const { rows: [time] } = await db.raw("select e.economic_at=d.delivered_at as exact from driver_earning e join delivery_operation d on d.id=e.delivery_id where e.id=?", [earnedA.id]); assert.equal(time.exact, true);
      await assert.rejects(ledger.forOrder(f.user, a.order.orderId), denied); // Managing rates grants no earning read/write API.
      process.env.DRIVER_EARNINGS_VIEW_USER_IDS = f.user;
      const projection = await ledger.forOrder(f.user, a.order.orderId); assert.equal(projection.earning?.amount_minor, "5000");
      delete process.env.DRIVER_EARNINGS_VIEW_USER_IDS; await assert.rejects(ledger.forOrder(f.user, a.order.orderId), denied);
      process.env.DRIVER_EARNINGS_VIEW_USER_IDS = f.user;
      const b = await trip("rate-b"); await complete(b);
      const auditBefore = (await db("driver_earning_audit")).length;
      await db.raw(`create function m21c_test_fail_audit() returns trigger as $test$ begin
        if NEW.kind='EARNING' then raise exception 'Injected M21-C earning audit failure'; end if; return NEW; end; $test$ language plpgsql`);
      await db.raw("create trigger m21c_test_fail_audit before insert on driver_earning_audit for each row execute function m21c_test_fail_audit()");
      try { await assert.rejects(ledger.recognize(b.order.orderId), /Injected M21-C earning audit failure/); }
      finally { await db.raw("drop trigger m21c_test_fail_audit on driver_earning_audit"); await db.raw("drop function m21c_test_fail_audit()"); }
      assert.equal((await db("driver_earning").where({ delivery_id: b.delivery.id })).length, 0);
      assert.equal((await db("driver_earning_recognition").where({ delivery_id: b.delivery.id })).length, 0);
      assert.equal((await db("driver_earning_audit")).length, auditBefore);
      await db.raw(`create function m21c_test_skip_audit() returns trigger as $test$ begin
        if NEW.kind='EARNING' then return null; end if; return NEW; end; $test$ language plpgsql`);
      await db.raw("create trigger m21c_test_skip_audit before insert on driver_earning_audit for each row execute function m21c_test_skip_audit()");
      try { await assert.rejects(ledger.recognize(b.order.orderId), /Driver earning audit required/); }
      finally { await db.raw("drop trigger m21c_test_skip_audit on driver_earning_audit"); await db.raw("drop function m21c_test_skip_audit()"); }
      assert.equal((await db("driver_earning").where({ delivery_id: b.delivery.id })).length, 0);
      assert.equal((await db("driver_earning_recognition").where({ delivery_id: b.delivery.id })).length, 0);
      assert.equal((await db("driver_earning_audit")).length, auditBefore);
      const completed = await db("delivery_completion").where({ delivery_id: b.delivery.id }).first("id"); assert.ok(completed);
      const predecessor = await db("delivery_completion").where("id", "<", completed.id).orderBy("id", "desc").first("id");
      const page = { ...(predecessor ? { after: String(predecessor.id) } : {}), through: String(completed.id), limit: 1 };
      const event = () => recognizeDriverDelivery({ container: scope, event: { data: { order_id: b.order.orderId, driver_profile_id: a.who.id, amount_minor: 1, payer: "FORGED" } } } as unknown as Parameters<typeof recognizeDriverDelivery>[0]);
      const [one, two, , repairA, repairB] = await Promise.all([ledger.recognize(b.order.orderId), new DriverEarnings(scope).recognize(b.order.orderId), event(), ledger.repair(page), new DriverEarnings(scope).repair(page)]);
      assert.deepEqual(one, two); assert.equal(one.state, "EARNED");
      for (const repair of [repairA, repairB]) { assert.equal(repair.examined, 1); assert.deepEqual(repair.deferred, []); assert.equal(repair.items[0]?.result.id, one.id); }
      await event(); assert.deepEqual(await ledger.recognize(b.order.orderId), one);
      assert.equal((await db("driver_earning").where({ completion_id: completed.id })).length, 1);
      const rowB = await db("driver_earning").where({ id: one.id }).first();
      assert.equal(String(rowB.amount_minor), "6000"); assert.equal(rowB.driver_profile_id, b.who.id);
      const nonPayable = await trip("merchant", true); await complete(nonPayable);
      const merchantOutcome = await ledger.recognize(nonPayable.order.orderId); assert.equal(merchantOutcome.state, "NON_GOSPAZA_PAYABLE");
      assert.deepEqual(await ledger.recognize(nonPayable.order.orderId), merchantOutcome);
      assert.equal((await db("driver_earning").where({ delivery_id: nonPayable.delivery.id })).length, 0);
      const failed = await trip("failed-ordinary");
      const wrong = await handoff.customerCode(failed.order.person.id, failed.order.orderId); assert.ok(wrong.code);
      await assert.rejects(handoff.verify(failed.who.identity, failed.delivery.id, { expected_revision: wrong.revision, code: wrong.code === "000000" ? "000001" : "000000" }));
      assert.equal((await ledger.recognize(failed.order.orderId)).state, "PENDING");
      assert.equal((await db("driver_earning").where({ delivery_id: failed.delivery.id })).length, 0);
      // Same authoritative registration/document/purchaser fixture interfaces as
      // M17; synthetic eligibility is confined to checkout fixture injection.
      process.env.RESTRICTED_COMMERCE_REVIEWER_IDS = f.user;
      process.env.DELIVERY_DOCUMENT_POLICY_APPROVED = "true"; process.env.DELIVERY_DOCUMENT_POLICY_VERSION = "isolated-m21c-document";
      const variants = await scope.resolve<IProductModuleService>(Modules.PRODUCT).listProductVariants({ id: [f.orders.fixture.first.variantId] }, { take: null });
      product = variants[0]?.product_id ?? undefined; assert.ok(product);
      const file = await commerce.upload(f.orders.ownerA.identity, { document_type: "LIQUOR_DOCUMENT", display_name: "fixture.pdf", mime_type: "application/pdf", content: Buffer.from("%PDF-1.4\nM21-C fixture\n%%EOF").toString("base64") });
      const evidence = await db("restricted_evidence").where({ id: file.id, merchant_store_id: store }).first("storage_key"); assert.ok(evidence); fileKey = String(evidence.storage_key);
      const registration = await commerce.submit(f.orders.ownerA.identity, { registration_number: "M21-C-test", category: "GROCER_WINE", issuing_authority: "test-only", valid_from: null, valid_until: null, evidence_ids: [file.id] }); assert.ok(registration.registration);
      const windows = Array.from({ length: 7 }, (_, day) => ({ day, start_minute: 0, end_minute: 1440 }));
      await commerce.reviewRegistration(f.user, store, { action: "approve", confirmed: true, expected_revision: registration.registration.revision, reason: "Synthetic M21-C restriction policy", conditions_confirmed: true,
        trading_policy: { timezone: "Africa/Johannesburg", source: "isolated fixture only", version: "m21c-test", permitted_alcohol_classes: ["WINE"], effective_from: "2020-01-01T00:00:00Z", effective_until: null,
          regulatory_sale_windows: windows, licence_sale_windows: windows, store_sale_windows: windows, dispatch_windows: windows, handoff_windows: windows } });
      const restricted = await trip("restricted-success", false, true); await complete(restricted, true);
      assert.equal((await ledger.recognize(restricted.order.orderId)).state, "EARNED");
      const returned = await trip("restricted-return", false, true);
      const before = await handoff.read(returned.who.identity, returned.delivery.id);
      let state = await recipient.verify(returned.who.identity, returned.delivery.id, { expected_revision: before.revision, recipient_role: "ALTERNATE_ADULT", document_type: "PASSPORT", document_viewed: true,
        date_of_birth: "1990-01-01", school_uniform_observed: true, recipient_declares_school_going_learner: false, recipient_appears_intoxicated: false, recipient_refused_verification: false, invoice_address_matches: true });
      state = await recipient.returnAction(returned.who.identity, returned.delivery.id, "start", { expected_revision: state.revision });
      state = await recipient.returnAction(returned.who.identity, returned.delivery.id, "arrive", { expected_revision: state.revision });
      await recipient.merchant(f.orders.manager.identity, returned.delivery.id, { expected_revision: state.revision });
      assert.equal((await ledger.recognize(returned.order.orderId)).state, "NO_ORDINARY_EARNING");
      assert.equal((await db("driver_earning").where({ delivery_id: returned.delivery.id })).length, 0);
      // Corruption controls copy real terminal input contracts into a separate
      // private schema. No operational trigger is disabled or public row edited.
      async function corrupted(work: (bad: Knex, badLedger: DriverEarnings) => Promise<void>) {
        const badSchema = "m21c_source_" + randomUUID().replaceAll("-", ""); await base.raw("create schema ??", [badSchema]);
        const bad = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [badSchema, "public"], pool: { min: 0, max: 4 } });
        const badScope = args.container.createScope() as MedusaContainer; badScope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(bad) });
        try {
          for (const table of ["delivery_operation", "delivery_completion", "dispatch_commitment", "driver_compensation_terms", "driver_compensation_activation", "driver_compensation_snapshot"])
            await bad.raw("create table ?? (like ?? including defaults including constraints including indexes)", [badSchema + "." + table, (table.startsWith("driver_compensation") ? schema : "public") + "." + table]);
          for (const table of ["driver_compensation_terms", "driver_compensation_activation"]) await bad.raw("insert into ?? select * from ??", [badSchema + "." + table, schema + "." + table]);
          await bad.raw("insert into ?? select * from public.delivery_operation where id=?", [badSchema + ".delivery_operation", a.delivery.id]);
          await bad.raw("insert into ?? select * from public.delivery_completion where delivery_id=?", [badSchema + ".delivery_completion", a.delivery.id]);
          await bad.raw("insert into ?? select * from public.dispatch_commitment where id=?", [badSchema + ".dispatch_commitment", a.offer.id]);
          await bad.raw("insert into ?? select * from ?? where commitment_id=?", [badSchema + ".driver_compensation_snapshot", schema + ".driver_compensation_snapshot", a.offer.id]);
          for (const sql of driverEarningSql) await bad.raw(sql);
          await work(bad, new DriverEarnings(badScope));
        } finally { await bad.destroy(); await base.raw("drop schema ?? cascade", [badSchema]); }
      }
      await corrupted(async (bad, badLedger) => {
        await bad("driver_compensation_snapshot").delete();
        assert.deepEqual(await badLedger.recognize(a.order.orderId), { state: "UNRESOLVED", reason: "SNAPSHOT_MISSING" });
        const originalException = await bad("driver_earning_exception").first(); assert.ok(originalException);
        assert.deepEqual(await badLedger.recognize(a.order.orderId), { state: "UNRESOLVED", reason: "SNAPSHOT_MISSING" });
        assert.deepEqual(await bad("driver_earning_exception").first(), originalException);
        await assert.rejects(async () => { await bad("driver_earning_exception").where({ id: originalException.id }).update({ reason: "SOURCE_CONFLICT" }); }, /Immutable driver earning history/);
        assert.equal((await bad("driver_earning")).length, 0); assert.equal((await bad("driver_earning_exception")).length, 1);
      });
      await corrupted(async (bad, badLedger) => {
        await bad.raw("update delivery_completion set receipt=jsonb_set(receipt,'{fulfillment_id}',to_jsonb(?::text))", ["foreign_fulfillment"]);
        for (let n = 0; n < 2; n++) assert.equal((await badLedger.recognize(a.order.orderId)).reason, "COMPLETION_EVIDENCE_MISMATCH");
        assert.equal((await bad("driver_earning")).length, 0); assert.equal((await bad("driver_earning_exception")).length, 1);
      });
      await corrupted(async (bad, badLedger) => {
        await bad("driver_compensation_snapshot").update({ driver_profile_id: b.who.id });
        for (let n = 0; n < 2; n++) assert.equal((await badLedger.recognize(a.order.orderId)).reason, "SNAPSHOT_IDENTITY_MISMATCH");
        assert.equal((await bad("driver_earning")).length, 0);
        const rows = await bad("driver_earning_exception"); assert.equal(rows.length, 1); assert.equal(rows[0]?.driver_profile_id, a.who.id);
      });
      await corrupted(async (bad, badLedger) => {
        const original = await badLedger.recognize(a.order.orderId); assert.equal(original.state, "EARNED");
        const saved = await bad("driver_earning").where({ id: original.id }).first();
        await bad.raw("update delivery_completion set receipt=jsonb_set(receipt,'{delivered_at}',to_jsonb(?::text)) where delivery_id=?", ["2099-01-01T00:00:00Z", a.delivery.id]);
        assert.equal((await badLedger.recognize(a.order.orderId)).reason, "SOURCE_CONFLICT");
        assert.deepEqual(await bad("driver_earning").where({ id: original.id }).first(), saved);
        assert.equal((await badLedger.forOrder(f.user, a.order.orderId)).attention_required, true);
      });
      for (const table of ["driver_earning", "driver_earning_recognition", "driver_earning_audit"])
        await assert.rejects(async () => { await db(table).update({ id: "forged" }); }, /Immutable driver earning history/);
      await assert.rejects(async () => { await db("driver_earning").where({ id: rowA.id }).delete(); }, /Immutable driver earning history/);
      for (const value of await db("driver_earning")) for (const forbidden of ["1990-01-01", "date_of_birth", "document_number", "latitude", "longitude", "school_uniform", "nonce"])
        assert.equal(JSON.stringify(value).includes(forbidden), false);
    } finally {
      // All immutable finance fixtures disappear as a schema, never by editing
      // ledger history. The existing native fixture owner then performs teardown.
      try { if (product) await review(false); }
      finally {
        try {
          try { await db.destroy(); await base.raw("drop schema ?? cascade", [schema]); }
          finally {
            const deliveries = base("delivery_operation").select("id").whereIn("medusa_order_id", ownOrders);
            await base.transaction(async trx => {
              await trx("restricted_return").whereIn("delivery_id", deliveries).delete();
              await trx("recipient_compliance").whereIn("delivery_id", deliveries).delete();
              await trx("restricted_delivery_document").whereIn("medusa_order_id", ownOrders).delete();
            });
            if (purchaserIds.length) await base("purchaser_eligibility").whereIn("id", purchaserIds).delete();
            if (fileKey) await args.container.resolve<IFileModuleService>(Modules.FILE).deleteFiles(fileKey);
          }
        } finally { keys.forEach((key, index) => { const value = prior[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
      }
    }
  });
  console.log("M21-C passed: real terminal deliveries, frozen earnings, non-payable/return exclusions, event/repair races, corruption controls and atomic audit. No payments created.");
}
