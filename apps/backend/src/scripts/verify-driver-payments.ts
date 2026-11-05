import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { DriverPayments } from "../lib/driver-payment";
import { driverPaymentSql } from "../modules/marketplace/driver-payment-schema";

const domain = (type: string) => (error: unknown) => !!error && typeof error === "object" && "type" in error && error.type === type;
const decision = () => ({ request_id: "d_request_" + randomUUID(), confirmed: true, reason: "Reviewed isolated driver transfer evidence" });
const contenders = (results: PromiseSettledResult<unknown>[], winners = 1) => {
  assert.equal(results.filter(r => r.status === "fulfilled").length, winners);
  for (const r of results) if (r.status === "rejected") assert.ok(domain("conflict")(r.reason), "Only an explicit driver payment conflict may lose admission.");
};

// Private C input-contract fixtures, not a second completion/recognition proof.
// C provenance remains user-verified. No public ledger guard is disabled or edited.
export default async function verifyDriverPayments({ container }: ExecArgs) {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test"))
    throw new Error("Use test:isolated with the explicitly selected existing _test database.");
  const base = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("driver_payment"), "Apply the M21-D forward migration first.");
  const schema = "m21d_verify_" + randomUUID().replaceAll("-", "");
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 8 } });
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const actor = await users.createUsers({ email: schema + "@example.test" });
  const grants = ["DRIVER_PAYMENT_RECORD_USER_IDS", "DRIVER_PAYMENT_RECONCILE_USER_IDS", "DRIVER_EARNINGS_VIEW_USER_IDS",
    "DRIVER_COMPENSATION_MANAGE_USER_IDS", "SETTLEMENT_PAYOUT_RECORD_USER_IDS", "FINANCIAL_VIEW_USER_IDS"];
  const previous = grants.map(key => process.env[key]);
  let created = false;
  try {
    await base.raw("create schema ??", [schema]); created = true;
    await db.raw("create table driver_profile(id text primary key)");
    await db.raw(`create table driver_earning(id text primary key,driver_profile_id text not null references driver_profile(id),
      delivery_id text not null unique,payer text not null,currency text not null,amount_minor bigint not null,
      economic_at timestamptz not null,recorded_at timestamptz not null)`);
    await db.raw("create table driver_earning_exception(id text primary key,delivery_id text not null,reason text not null)");
    for (const sql of driverPaymentSql) await db.raw(sql);
    await db.raw("create trigger private_earning_immutable before update or delete on driver_earning for each row execute function gospaza_driver_payment_immutable()");
    const service = new DriverPayments(container, db);
    const give = (...keys: string[]) => { for (const key of grants) { if (keys.includes(key)) process.env[key] = actor.id; else delete process.env[key]; } };
    const all = () => give("DRIVER_PAYMENT_RECORD_USER_IDS", "DRIVER_PAYMENT_RECONCILE_USER_IDS", "DRIVER_EARNINGS_VIEW_USER_IDS");
    const seed = async (name: string, driver = name + "_driver", amount = 5000) => {
      await db("driver_profile").insert({ id: driver }).onConflict("id").ignore();
      const ids = [name + "_a", name + "_b"];
      await db("driver_earning").insert(ids.map(id => ({ id, driver_profile_id: driver, delivery_id: id + "_delivery", payer: "GOSPAZA", currency: "zar",
        amount_minor: amount, economic_at: "2026-01-01T00:00:00Z", recorded_at: "2026-01-02T00:00:00Z" })));
      return ids;
    };
    const evidence = async (earning_ids: string[], amount_minor = 10000) => {
      const { rows: [clock] } = await db.raw("select clock_timestamp() as instant");
      return { ...decision(), earning_ids, amount_minor, currency: "zar", beneficiary_reference: "verified:private-driver",
        channel: "BANK_TRANSFER", origin_reference: "origin:private-channel", external_transfer_id: "transfer_" + randomUUID(),
        transferred_at: new Date(clock.instant).toISOString(), evidence_reference: "private:evidence" };
    };
    const resolution = () => ({ ...decision(), review_reference: "review:confirmed", evidence_reference: "evidence:confirmed" });
    const nonpayment = () => ({ ...resolution(), failure_category: "BANK_REJECTED", nonreceipt_confirmed: true });
    const review = (e: Awaited<ReturnType<typeof evidence>>, driver: string) => {
      const { evidence_reference: omittedEvidence, ...facts } = e;
      assert.ok(omittedEvidence);
      return { ...facts, ...decision(), driver_profile_id: driver, review_reference: "review:matched" };
    };
    const count = async (table: string, payment: string) => Number((await db(table).where({ payment_id: payment }).count("* as n").first())?.n ?? 0);
    const first = await seed("whole"), input = await evidence(first);
    for (const grant of ["DRIVER_EARNINGS_VIEW_USER_IDS", "DRIVER_COMPENSATION_MANAGE_USER_IDS", "SETTLEMENT_PAYOUT_RECORD_USER_IDS", "FINANCIAL_VIEW_USER_IDS"]) {
      give(grant);
      await assert.rejects(service.record(actor.id, "RECORD", input), domain("forbidden"));
    }
    give("DRIVER_PAYMENT_RECONCILE_USER_IDS");
    await assert.rejects(service.record(actor.id, "RECORD", input), domain("forbidden"));
    all();
    const unpaid = await service.selection(actor.id, "whole_driver");
    assert.ok(unpaid.items.every(r => r.state === "UNPAID"));
    assert.equal(unpaid.totals.find((r: { state: string }) => r.state === "UNPAID")?.amount_minor, "10000");
    for (const amount_minor of [7500, 12500]) await assert.rejects(service.record(actor.id, "RECORD", { ...input, ...decision(), amount_minor }), domain("conflict"));
    await assert.rejects(service.record(actor.id, "RECORD", { ...input, driver_profile_id: "forged" }), domain("invalid_data"));
    for (const transferred_at of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"])
      await assert.rejects(service.record(actor.id, "RECORD", { ...input, transferred_at }), domain("conflict"));
    const earningBefore = await db("driver_earning").orderBy("id");
    const paid = await Promise.all([service.record(actor.id, "RECORD", input), service.record(actor.id, "RECORD", input)]);
    assert.deepEqual(paid[0], paid[1]);
    const payment = paid[0]?.payment_id; assert.ok(payment);
    assert.equal(await count("driver_payment_allocation", payment), 2);
    assert.equal((await db("driver_payment_allocation").where({ payment_id: payment }).sum("amount_minor as n").first())?.n, "10000");
    for (const change of [{ amount_minor: 9999 }, { external_transfer_id: "different" }, { earning_ids: [first[0]] }])
      await assert.rejects(service.record(actor.id, "RECORD", { ...input, ...change }), domain("conflict"));
    await assert.rejects(service.record(actor.id, "RECORD", { ...await evidence(first) }), domain("conflict"));
    give("DRIVER_EARNINGS_VIEW_USER_IDS");
    const publicRead = JSON.stringify(await service.selection(actor.id, "whole_driver"));
    for (const secret of [input.beneficiary_reference, input.origin_reference, input.external_transfer_id, input.evidence_reference]) assert.ok(!publicRead.includes(secret));
    await assert.rejects(service.evidence(actor.id, payment), domain("forbidden"));
    give("DRIVER_PAYMENT_RECORD_USER_IDS");
    await assert.rejects(service.execute(actor.id, payment, "RECONCILE", review(input, "whole_driver")), domain("forbidden"));
    all();
    const checked = review(input, "whole_driver");
    for (const change of [{ driver_profile_id: "foreign" }, { beneficiary_reference: "wrong" }, { amount_minor: 1 }, { external_transfer_id: "wrong" }, { earning_ids: [first[0]] }])
      await assert.rejects(service.execute(actor.id, payment, "RECONCILE", { ...checked, ...change }), domain("conflict"));
    const reconciled = await Promise.all([service.execute(actor.id, payment, "RECONCILE", checked), service.execute(actor.id, payment, "RECONCILE", checked)]);
    assert.deepEqual(reconciled[0], reconciled[1]); assert.equal(await count("driver_payment_reconciliation", payment), 1);
    await assert.rejects(service.execute(actor.id, payment, "RECONCILE", { ...checked, reason: "Changed replay" }), domain("conflict"));
    const originalPayment = await db("driver_payment").where({ id: payment }).first();
    const allocations = await db("driver_payment_allocation").where({ payment_id: payment }).orderBy("earning_id");
    await service.execute(actor.id, payment, "DISCREPANCY", { ...decision(), category: "RETURNED_TRANSFER", evidence_reference: "return:evidence" });
    assert.deepEqual(await db("driver_payment").where({ id: payment }).first(), originalPayment);
    assert.deepEqual(await db("driver_payment_allocation").where({ payment_id: payment }).orderBy("earning_id"), allocations);
    assert.equal((await service.evidence(actor.id, payment)).attention_required, true);
    await assert.rejects(db("driver_payment").where({ id: payment }).update({ amount_minor: 1 }), /Immutable driver payment history/);
    await assert.rejects(db("driver_payment_allocation").where({ payment_id: payment }).delete(), /Immutable driver payment history/);
    await assert.rejects(db("driver_payment_hold").where({ payment_id: payment }).delete(), /Unproven driver nonpayment/);
    assert.deepEqual(await db("driver_earning").orderBy("id"), earningBefore);

    // Different requests, same earnings: one winner with one allocation set.
    const raceIds = await seed("record_race"), raceInputs = [await evidence(raceIds), await evidence(raceIds)];
    const race = await Promise.allSettled(raceInputs.map(e => service.record(actor.id, "RECORD", e)));
    contenders(race);
    assert.equal((await db("driver_payment_allocation").whereIn("earning_id", raceIds)).length, 2);
    // Same transfer races across distinct drivers; identity is permanently unique.
    const a = await seed("identity_a"), b = await seed("identity_b"), shared = await evidence(a);
    const identityRace = await Promise.allSettled([service.record(actor.id, "RECORD", shared), service.record(actor.id, "RECORD", { ...shared, ...decision(), earning_ids: b })]);
    contenders(identityRace);
    assert.equal(Number((await db("driver_payment").where({ external_transfer_id: shared.external_transfer_id }).count("* as n").first())?.n), 1);
    const identityPaid = identityRace.find(r => r.status === "fulfilled");
    assert.ok(identityPaid?.status === "fulfilled");
    const identityOwner = await db("driver_payment").where({ id: identityPaid.value.payment_id }).first("driver_profile_id");
    const sameDriverIds = await seed("same_driver_identity", String(identityOwner.driver_profile_id));
    await assert.rejects(service.record(actor.id, "RECORD", { ...shared, ...decision(), earning_ids: sameDriverIds }), domain("conflict"));

    const heldIds = await seed("uncertain"), heldInput = await evidence(heldIds);
    const held = await service.record(actor.id, "UNKNOWN", heldInput);
    assert.equal(await count("driver_payment_hold", held.payment_id), 2);
    assert.equal(await count("driver_payment_allocation", held.payment_id), 0);
    const heldForeign = await seed("uncertain_identity_foreign");
    await assert.rejects(service.record(actor.id, "RECORD", { ...heldInput, ...decision(), earning_ids: heldForeign }), domain("conflict"));
    const reserved = await service.selection(actor.id, "uncertain_driver");
    assert.ok(reserved.items.every(r => r.state === "RESERVED"));
    await assert.rejects(service.record(actor.id, "RECORD", await evidence(heldIds)), domain("conflict"));
    const notPaid = nonpayment();
    await service.execute(actor.id, held.payment_id, "CONFIRMED_NOT_PAID", notPaid);
    assert.equal(await count("driver_payment_hold", held.payment_id), 0);
    assert.deepEqual(await service.execute(actor.id, held.payment_id, "CONFIRMED_NOT_PAID", notPaid),
      await service.execute(actor.id, held.payment_id, "CONFIRMED_NOT_PAID", notPaid));
    await assert.rejects(service.record(actor.id, "RECORD", { ...heldInput, ...decision() }), domain("conflict"));
    await service.record(actor.id, "RECORD", await evidence(heldIds));
    assert.equal(await count("driver_payment_item", held.payment_id), 2, "Released attempt history remains immutable.");
    const paidIds = await seed("confirm"), unknown = await service.record(actor.id, "UNKNOWN", await evidence(paidIds));
    const confirmed = resolution();
    await service.execute(actor.id, unknown.payment_id, "CONFIRMED_PAID", confirmed);
    await service.execute(actor.id, unknown.payment_id, "CONFIRMED_PAID", confirmed);
    assert.equal(await count("driver_payment_allocation", unknown.payment_id), 2);
    assert.equal(await count("driver_payment_resolution", unknown.payment_id), 1);
    await assert.rejects(service.execute(actor.id, unknown.payment_id, "CONFIRMED_NOT_PAID", nonpayment()), domain("conflict"));
    const resolveIds = await seed("resolve_race"), resolving = await service.record(actor.id, "UNKNOWN", await evidence(resolveIds));
    const resolveRace = await Promise.allSettled([service.execute(actor.id, resolving.payment_id, "CONFIRMED_PAID", resolution()),
      service.execute(actor.id, resolving.payment_id, "CONFIRMED_NOT_PAID", nonpayment())]);
    contenders(resolveRace); assert.equal(await count("driver_payment_resolution", resolving.payment_id), 1);

    const blockIds = await seed("blocked"), blockInput = await evidence(blockIds), blocked = await service.record(actor.id, "RECORD", blockInput);
    await service.execute(actor.id, blocked.payment_id, "DISCREPANCY", { ...decision(), category: "AMOUNT_MISMATCH", evidence_reference: "review:mismatch" });
    await assert.rejects(service.execute(actor.id, blocked.payment_id, "RECONCILE", review(blockInput, "blocked_driver")), domain("conflict"));
    const attentionIds = await seed("source_attention");
    await db("driver_earning_exception").insert({ id: "attention", delivery_id: attentionIds[0] + "_delivery", reason: "SOURCE_CONFLICT" });
    await assert.rejects(service.record(actor.id, "RECORD", await evidence(attentionIds)), domain("conflict"));
    const laterAttentionIds = await seed("later_attention"), laterInput = await evidence(laterAttentionIds);
    const laterPayment = await service.record(actor.id, "RECORD", laterInput);
    await db("driver_earning_exception").insert({ id: "later_attention", delivery_id: laterAttentionIds[0] + "_delivery", reason: "SOURCE_CONFLICT" });
    await assert.rejects(service.execute(actor.id, laterPayment.payment_id, "RECONCILE", review(laterInput, "later_attention_driver")), domain("conflict"));
    assert.equal(await count("driver_payment_allocation", laterPayment.payment_id), 2);
    const mixedA = await seed("mixed_a"), mixedB = await seed("mixed_b");
    await assert.rejects(service.record(actor.id, "RECORD", await evidence([String(mixedA[0]), String(mixedB[0])])), domain("conflict"));

    // Faults are installed only on private fixture tables and removed immediately.
    const fault = async (table: string, condition: string, work: () => Promise<unknown>, suppress: false | "allocation-audit" | "commit-audit" = false) => {
      await db.raw(`create function injected_driver_payment_fault() returns trigger as $fault$
        begin if ${condition} then ${suppress ? "return null;" : "raise exception 'M21-D injected atomicity fault';"} end if; return NEW; end;
        $fault$ language plpgsql`);
      await db.raw(`create trigger injected_driver_payment_fault before insert on ?? for each row execute function injected_driver_payment_fault()`, [table]);
      try { await assert.rejects(work, error => {
        if (!suppress) return error instanceof Error && /M21-D injected atomicity fault/.test(error.message);
        const e = error as { code?: string; constraint?: string; message?: string };
        if (suppress === "allocation-audit") return e.code === "23503" && e.constraint === "driver_payment_allocation_command_id_fkey";
        return e.code === "23503" && e.constraint === "driver_payment_command_fk"
          || e.code === "23514" && !!e.message && /(?:^| - )Driver payment recording audit$/.test(e.message);
      }); }
      finally { await db.raw("drop trigger injected_driver_payment_fault on ??", [table]); await db.raw("drop function injected_driver_payment_fault()"); }
    };
    for (const table of ["driver_payment", "driver_payment_hold", "driver_payment_allocation"]) {
      const ids = await seed("rollback_" + table), e = await evidence(ids);
      const before = Number((await db("driver_payment").count("* as n").first())?.n);
      await fault(table, "true", () => service.record(actor.id, "RECORD", e));
      assert.equal(Number((await db("driver_payment").count("* as n").first())?.n), before);
      assert.equal((await db("driver_payment_hold").whereIn("earning_id", ids)).length, 0);
      assert.equal((await db("driver_payment_command").where({ request_id: e.request_id })).length, 0);
    }
    // PAID reaches the allocation's immediate audit FK first. UNKNOWN has no
    // allocation and therefore exercises missing audit rejection at COMMIT.
    for (const outcome of ["RECORD", "UNKNOWN"] as const) {
      const auditIds = await seed("missing_audit_" + outcome), auditInput = await evidence(auditIds);
      await fault("driver_payment_command", `NEW.action='${outcome}'`, () => service.record(actor.id, outcome, auditInput),
        outcome === "RECORD" ? "allocation-audit" : "commit-audit");
      assert.equal((await db("driver_payment").where({ external_transfer_id: auditInput.external_transfer_id })).length, 0);
      assert.equal((await db("driver_payment_command").where({ request_id: auditInput.request_id })).length, 0);
      for (const table of ["driver_payment_item", "driver_payment_hold", "driver_payment_allocation"])
        assert.equal((await db(table).whereIn("earning_id", auditIds)).length, 0);
    }
    const resolutionIds = await seed("resolution_rollback"), resolutionPayment = await service.record(actor.id, "UNKNOWN", await evidence(resolutionIds));
    await fault("driver_payment_resolution", "true", () => service.execute(actor.id, resolutionPayment.payment_id, "CONFIRMED_NOT_PAID", nonpayment()));
    assert.equal(await count("driver_payment_hold", resolutionPayment.payment_id), 2);
    assert.equal(await count("driver_payment_resolution", resolutionPayment.payment_id), 0);
    await fault("driver_payment_allocation", "true", () => service.execute(actor.id, resolutionPayment.payment_id, "CONFIRMED_PAID", resolution()));
    assert.equal(await count("driver_payment_resolution", resolutionPayment.payment_id), 0);
    assert.equal(await count("driver_payment_allocation", resolutionPayment.payment_id), 0);
    assert.equal(await count("driver_payment_hold", resolutionPayment.payment_id), 2);
    // Inject an actual allocation uniqueness collision, not an arbitrary throw.
    const uniqueIds = await seed("unique_rollback"), uniqueInput = await evidence(uniqueIds);
    await db.raw(`create function injected_driver_allocation_duplicate() returns trigger as $fault$
      begin if pg_trigger_depth()=1 then insert into driver_payment_allocation select NEW.*; end if; return NEW; end;
      $fault$ language plpgsql`);
    await db.raw("create trigger injected_driver_allocation_duplicate before insert on driver_payment_allocation for each row execute function injected_driver_allocation_duplicate()");
    try { await assert.rejects(service.record(actor.id, "RECORD", uniqueInput), domain("conflict")); }
    finally { await db.raw("drop trigger injected_driver_allocation_duplicate on driver_payment_allocation"); await db.raw("drop function injected_driver_allocation_duplicate()"); }
    assert.equal((await db("driver_payment_allocation").whereIn("earning_id", uniqueIds)).length, 0);
    assert.equal((await db("driver_payment_hold").whereIn("earning_id", uniqueIds)).length, 0);
    assert.equal((await db("driver_payment_command").where({ request_id: uniqueInput.request_id })).length, 0);
    const auditIds = await seed("reconcile_audit"), auditEvidence = await evidence(auditIds), auditPayment = await service.record(actor.id, "RECORD", auditEvidence);
    await fault("driver_payment_command", "NEW.action='RECONCILE'", () => service.execute(actor.id, auditPayment.payment_id, "RECONCILE", review(auditEvidence, "reconcile_audit_driver")));
    assert.equal(await count("driver_payment_reconciliation", auditPayment.payment_id), 0);
    const reconRaces = await Promise.allSettled([service.execute(actor.id, auditPayment.payment_id, "RECONCILE", review(auditEvidence, "reconcile_audit_driver")),
      service.execute(actor.id, auditPayment.payment_id, "RECONCILE", review(auditEvidence, "reconcile_audit_driver"))]);
    contenders(reconRaces); assert.equal(await count("driver_payment_reconciliation", auditPayment.payment_id), 1);
    const attentionBefore = Number((await db("driver_payment_command").count("* as n").first())?.n);
    const recovery = await service.attention(actor.id, { limit: 25 });
    assert.ok(recovery.items.length <= 25); assert.ok(recovery.items.every(r => r.integrity === "CONSISTENT"));
    assert.equal(Number((await db("driver_payment_command").count("* as n").first())?.n), attentionBefore);
    give(); // Same native actor, revoked current grants.
    await assert.rejects(service.record(actor.id, "RECORD", input), domain("forbidden"));
    await assert.rejects(service.execute(actor.id, payment, "RECONCILE", checked), domain("forbidden"));
    console.log("M21-D driver payments passed");
  } finally {
    for (const [index, key] of grants.entries()) { const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.destroy();
    if (created) await base.raw("drop schema ?? cascade", [schema]);
    await users.deleteUsers([actor.id]);
  }
}
