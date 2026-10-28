import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IAuthModuleService, IFileModuleService, IProductModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { RestrictedCommerce } from "../lib/restricted-commerce";
import { CheckoutService } from "../lib/checkout-service";
import { PaymentInitiationService } from "../lib/payment-initiation-service";
import { checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import type { PurchaserEligibilityProvider, PurchaserEvidence } from "../modules/marketplace/restricted-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import verifyOrderOperations from "./verify-order-operations";

export default async function verifyRestrictedCommerce(args: ExecArgs) {
  if (!["development","test"].includes(process.env.APP_ENV ?? "")) throw new Error("M17 fixtures are local-only.");
  await verifyOrderOperations(args, async f => {
    const { container,first,second } = f.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
    const user = (await auth.retrieveAuthIdentity(f.platform.identity)).app_metadata?.user_id;
    assert.equal(typeof user,"string"); if (typeof user !== "string") throw new Error("Fixture user required.");
    const previous = process.env.RESTRICTED_COMMERCE_REVIEWER_IDS;
    const service = new RestrictedCommerce(container), evidenceIds: string[] = [];
    const people = [await f.customer("m17-one"),await f.customer("m17-two"),await f.customer("m17-three")];
    const person = people[0]!;
    const profile = await db<{ id: string; medusa_product_id: string }>("product_marketplace_profile").where({ merchant_id: first.merchantId }).first();
    assert.ok(profile);
    const productId = profile.medusa_product_id;
    const path = "/merchant/restricted-commerce";
    try {
      process.env.RESTRICTED_COMMERCE_REVIEWER_IDS = user;
      f.expect(await f.http(f.picker.cookie,"GET",path),403);
      f.expect(await f.http(person.cookie,"GET",path),401);
      f.expect(await f.http(f.ownerB.cookie,"GET",path+"/products/"+productId),404);
      f.expect(await f.http(f.ownerA.cookie,"POST",path,{ status: "ACTIVE",merchant_id: second.merchantId }),400);
      await assert.rejects(service.submit(f.picker.identity,{}));
      const doc = await service.upload(f.ownerA.identity,{ document_type: "LIQUOR_DOCUMENT",display_name: "fixture.pdf",
        mime_type: "application/pdf",content: Buffer.from("%PDF-1.4\nfixture registration\n%%EOF").toString("base64") });
      await assert.rejects(service.evidence(f.ownerB.identity,doc.id));
      assert.ok((await service.evidence(f.ownerA.identity,doc.id)).bytes.length);
      const submission = { registration_number: "isolated-fixture",category: "GROCER_WINE",issuing_authority: "test only",
        valid_from: null,valid_until: null,evidence_ids: [doc.id] };
      f.expect(await f.http(f.picker.cookie,"POST",path,submission),403);
      f.expect(await f.http(f.ownerA.cookie,"POST","/admin/gospaza/restricted-commerce/stores/"+first.store.id,
        { action: "approve",confirmed: true }),401);
      f.expect(await f.http(f.ownerA.cookie,"POST",path+"/products/"+productId,
        { restriction: "NONE",alcohol_class: null,reviewer_id: user }),400);
      await assert.rejects(service.submit(f.ownerB.identity,submission));
      let reg = (await service.submit(f.manager.identity,submission)).registration; assert.ok(reg);
      await assert.rejects(service.reviewRegistration("foreign-user",first.store.id,{ action: "approve",confirmed: true }));
      const windows = Array.from({ length: 7 },(_,day) => ({ day,start_minute: 0,end_minute: 1440 }));
      const policy = { timezone: "Africa/Johannesburg",source: "isolated test policy, not production legal approval",version: "fixture-1",
        permitted_alcohol_classes: ["WINE"],
        effective_from: "2020-01-01T00:00:00Z",effective_until: null,regulatory_sale_windows: windows,
        licence_sale_windows: windows,store_sale_windows: windows,dispatch_windows: null,handoff_windows: null };
      const approval = { action: "approve",confirmed: true,expected_revision: reg.revision,reason: "fixture review",conditions_confirmed: true,trading_policy: policy };
      const approvals = await Promise.allSettled([service.reviewRegistration(user,first.store.id,approval),service.reviewRegistration(user,first.store.id,approval)]);
      assert.equal(approvals.filter(r => r.status === "fulfilled").length,1,"one revision wins concurrent platform review");
      reg = (await service.registration(f.ownerA.identity)).registration; assert.ok(reg); assert.equal(reg.status,"ACTIVE");
      await assert.rejects(db("restricted_registration").where({ id: reg.id }).update({ merchant_store_id: second.store.id,revision: reg.revision+1 }), { code: "23514" });
      let classification = await service.classification(f.ownerA.identity,productId);
      await service.reviewClassification(user,first.store.id,productId,{ restriction: "ALCOHOL",alcohol_class: "WINE",confirmed: true,
        reason: "explicit test wine",expected_identity: classification.identity_fingerprint });
      const nativeProducts = container.resolve<IProductModuleService>(Modules.PRODUCT);
      const originalProduct = await nativeProducts.retrieveProduct(productId);
      await nativeProducts.updateProducts(productId,{ description: "materially changed fixture identity" });
      await assert.rejects(new CheckoutService(container,person.id).prepare(person.input),/CLASSIFICATION_REVIEW_REQUIRED/);
      await nativeProducts.updateProducts(productId,{ description: originalProduct.description });
      const wineIdentity = (await service.classification(f.ownerA.identity,productId)).identity_fingerprint;
      await service.reviewClassification(user,first.store.id,productId,{ restriction: "ALCOHOL",alcohol_class: "SPIRITS",confirmed: true,
        reason: "category rejection fixture",expected_identity: wineIdentity });
      await assert.rejects(new CheckoutService(container,person.id).prepare(person.input),/RESTRICTED_CATEGORY_UNAVAILABLE/);
      await service.reviewClassification(user,first.store.id,productId,{ restriction: "ALCOHOL",alcohol_class: "WINE",confirmed: true,
        reason: "restore fixture wine",expected_identity: wineIdentity });
      await service.propose(f.ownerA.identity,productId,{ restriction: "NONE",alcohol_class: null });
      classification = await service.classification(f.ownerA.identity,productId);
      assert.equal(classification.proposed,"NONE","latest merchant proposal is visible without changing platform authority");
      assert.equal(classification.review?.restriction,"ALCOHOL","merchant proposal never downgrades authoritative review");
      await assert.rejects(new CheckoutService(container,person.id).prepare(person.input),/PURCHASER_VERIFICATION_UNAVAILABLE/);
      const now = await db.transaction(databaseTime);
      const evidence: PurchaserEvidence = { id: "pelig_"+randomUUID(),customer_id: person.id,method: "isolated-fixture",
        method_version: "1",policy_version: "age-and-provincial-fixture",minimum_age: 18,provincial_requirements_satisfied: true,
        state: "VERIFIED",verified_at: now.toISOString(),expires_at: new Date(now.getTime()+3600000).toISOString() };
      evidenceIds.push(evidence.id); await db("purchaser_eligibility").insert(evidence);
      const adapter: PurchaserEligibilityProvider = { async evaluate() { return { state: "VERIFIED",evidence }; } };
      const appEnv = process.env.APP_ENV;
      try {
        process.env.APP_ENV = "production";
        assert.throws(() => new RestrictedCommerce(container,adapter),/No approved production/);
      } finally { process.env.APP_ENV = appEnv; }
      assert.deepEqual(f.expect(await f.http(person.cookie,"GET","/store/gospaza/purchaser-eligibility")),{ state: "UNAVAILABLE" },
        "a persisted test VERIFIED record never enables production HTTP purchaser verification");
      f.expect(await f.http(person.cookie,"GET","/store/gospaza/purchaser-eligibility?verification_id="+evidence.id),400);
      const checkout = new CheckoutService(container,person.id,adapter);
      await assert.rejects(new CheckoutService(container,people[1]!.id,adapter).prepare(people[1]!.input),/NOT_VERIFIED/);
      const prepared = await checkout.prepare(person.input);
      // Two independent transactions contend for the same merchant commerce
      // boundary. A classification revision either precedes confirmation (new
      // quote required) or follows a frozen snapshot; it cannot alter that row.
      const decision = { restriction: "ALCOHOL",alcohol_class: "WINE",confirmed: true,reason: "concurrent review",
        expected_identity: wineIdentity };
      const race = await Promise.all([
        checkout.prepare({ ...person.input,confirmed: true,checkout_revision: prepared.quote.checkout_revision },true),
        service.reviewClassification(user,first.store.id,productId,decision),
      ]);
      if (race[0].attempt) {
        await checkout.abandon({ cart_id: person.cartId,attempt_id: race[0].attempt.id,checkout_revision: race[0].quote.checkout_revision,confirmed: true });
      } else assert.equal(race[0].reconfirmation_required,true);
      const currentQuote = await checkout.prepare(person.input);
      const confirmed = await checkout.prepare({ ...person.input,confirmed: true,checkout_revision: currentQuote.quote.checkout_revision },true);
      assert.ok(confirmed.attempt);
      const attemptId = confirmed.attempt.id;
      const attempt = await db("checkout_attempt").where({ id: attemptId }).first(); assert.ok(attempt);
      const snapshot = checkoutSnapshot.parse(attempt.snapshot);
      assert.equal(snapshot.restricted_commerce?.restricted_content_present,true);
      assert.equal(snapshot.restricted_commerce?.purchaser_evidence_id,evidence.id);
      assert.equal(snapshot.restricted_commerce?.classifications[0]?.restriction,"ALCOHOL");
      await assert.rejects(db("checkout_attempt").where({ id: attemptId }).update({ snapshot: { ...snapshot,restricted_commerce: undefined } }),/immutable/);
      const revision = (await service.registration(f.ownerA.identity)).registration!.revision;
      const auditCount = await db("restricted_event").where({ merchant_store_id: first.store.id }).count<{ count: string }>("id as count").first();
      await assert.rejects(service.reviewRegistration(user,first.store.id,{ action: "suspend",confirmed: true,expected_revision: revision+10,reason: "stale review" }));
      assert.deepEqual(await db("restricted_event").where({ merchant_store_id: first.store.id }).count<{ count: string }>("id as count").first(),auditCount,
        "rejected state transition cannot append a successful audit event");
      class AuditFailure extends RestrictedCommerce {
        override async event(...parameters: Parameters<RestrictedCommerce["event"]>): Promise<void> {
          if (parameters[4] === "REGISTRATION_SUSPEND") throw new Error("Injected compliance audit failure");
          return super.event(...parameters);
        }
      }
      const suspension = { action: "suspend",confirmed: true,expected_revision: revision,reason: "fixture suspension" };
      await assert.rejects(new AuditFailure(container).reviewRegistration(user,first.store.id,suspension),/Injected compliance audit failure/);
      assert.equal((await service.registration(f.ownerA.identity)).registration?.status,"ACTIVE","audit failure rolls back the state transition");
      const suspensionRace = await Promise.allSettled([
        checkout.prepare({ ...person.input,confirmed: true,checkout_revision: confirmed.quote.checkout_revision },true),
        service.reviewRegistration(user,first.store.id,suspension),
      ]);
      assert.equal(suspensionRace[1]?.status,"fulfilled");
      const confirmationRace = suspensionRace[0]; assert.ok(confirmationRace);
      if (confirmationRace.status === "rejected") assert.match(String(confirmationRace.reason),/RESTRICTED_STORE_UNAVAILABLE/);
      else assert.equal(confirmationRace.value.attempt?.id,attemptId);
      await assert.rejects(new PaymentInitiationService(container,person.id,adapter).initiate({ cart_id: person.cartId,attempt_id: attemptId,
        checkout_revision: confirmed.quote.checkout_revision,confirmed: true }),/RESTRICTED_STORE_UNAVAILABLE/);
      assert.equal((await db("provider_operation").where({ checkout_attempt_id: attemptId })).length,0,"suspension blocks before external operation establishment");
      const suspended = (await service.registration(f.ownerA.identity)).registration!;
      await service.reviewRegistration(user,first.store.id,{ action: "reactivate",confirmed: true,expected_revision: suspended.revision,reason: "fixture reactivation" });
      await db("purchaser_eligibility").where({ id: evidence.id }).update({ state: "REVOKED" });
      await assert.rejects(new RestrictedCommerce(container,adapter).db.transaction(trx => new RestrictedCommerce(container,adapter)
        .evaluate(trx,person.id,first.store.id,[first.variantId])),/NOT_VERIFIED/);
      await assert.rejects(db("purchaser_eligibility").where({ id: evidence.id }).update({ customer_id: people[1]!.id }),{ code: "23514" });
      const events = await db("restricted_event").where({ merchant_store_id: first.store.id });
      assert.ok(events.some(e => e.action === "REGISTRATION_SUSPEND"));
      assert.equal(JSON.stringify(events).includes("fixture registration"),false,"no private bytes in audit");
      await assert.rejects(db("restricted_event").where({ id: events[0].id }).update({ actor_id: "forged" }),{ code: "23514" });
      const active = (await service.registration(f.ownerA.identity)).registration!;
      await service.reviewRegistration(user,first.store.id,{ action: "revoke",confirmed: true,expected_revision: active.revision,reason: "fixture final revocation" });
      // Review back to NONE through platform authority, never merchant downgrade.
      const current = await service.classification(f.ownerA.identity,productId);
      await service.reviewClassification(user,first.store.id,productId,{ restriction: "NONE",alcohol_class: null,confirmed: true,
        reason: "restore isolated grocery",expected_identity: current.identity_fingerprint });
      assert.equal((await db.transaction(trx => service.evaluate(trx,people[2]!.id,first.store.id,[first.variantId]))).restricted_content_present,false,
        "reviewed groceries remain available even with revoked liquor authority and no purchaser provider");
      assert.equal(checkoutSnapshot.parse((await db("checkout_attempt").where({ id: attemptId }).first()).snapshot)
        .restricted_commerce?.restricted_content_present,true,"later platform reclassification never changes the confirmed restricted snapshot");
      await checkout.abandon({ cart_id: person.cartId,attempt_id: attemptId,checkout_revision: confirmed.quote.checkout_revision,confirmed: true });
    } finally {
      if (previous === undefined) delete process.env.RESTRICTED_COMMERCE_REVIEWER_IDS;
      else process.env.RESTRICTED_COMMERCE_REVIEWER_IDS = previous;
      if (evidenceIds.length) await db("purchaser_eligibility").whereIn("id",evidenceIds).delete();
      // Native private objects belong only to these fixture stores. Immutable
      // metadata/audit is removed by existing owner-aggregate fixture cleanup.
      for (const doc of await db<{ storage_key: string }>("restricted_evidence").where({ merchant_store_id: first.store.id }))
        await container.resolve<IFileModuleService>(Modules.FILE).deleteFiles(doc.storage_key);
    }
  });
  console.log("M17-B passed: reviewed store/classification, tenant isolation, immutable checkout, fail-closed purchaser and suspension before payment.");
}
