import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, INotificationModuleService, NotificationDTO } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { NotificationFoundation } from "../lib/notification-foundation";
import { NotificationConflict, digest, REPLAY_MS, type CreateInput } from "../lib/notification-policy";
import { NativeNotificationTransport } from "../lib/notification-transport";
import { ResendNotificationProvider } from "../modules/resend";
import { notificationSql } from "../modules/marketplace/notification-schema";

const conflict = (error: unknown) => error instanceof NotificationConflict;
// Independent PostgreSQL connections/private schema, real constraints and the
// actual adapter through a controlled native-module substitute. Never live mail.
export default async function verifyNotificationFoundation({ container }: ExecArgs) {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test"
    || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || new URL(process.env.REDIS_URL ?? "").pathname !== "/1") throw Error("Use the isolated _test environment and Redis /1.");
  const base = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("notification_intent"), "Apply the M22-B migration first.");
  const schema = "m22b_verify_" + randomUUID().replaceAll("-", "");
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 8 } });
  let created = false;
  try {
    await base.raw("create schema ??", [schema]); created = true;
    for (const sql of notificationSql) await db.raw(sql);
    // Only this disposable schema replaces the clock. Public guards/clock remain intact.
    await db.raw("create table fixture_clock(instant timestamptz not null)");
    await db("fixture_clock").insert({ instant: "2030-01-01T00:00:00Z" });
    await db.raw(`create or replace function gospaza_notification_now() returns timestamptz as $fixture$
      begin return (select instant from fixture_clock); end; $fixture$ language plpgsql`);
    let clock = new Date("2030-01-01T00:00:00Z");
    const advance = async (ms: number) => { clock = new Date(clock.getTime() + ms); await db("fixture_clock").update({ instant: clock }); };
    const env = { APP_ENV: "test", NOTIFICATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "fixture-key",
      RESEND_FROM_EMAIL: "sender@example.test", RESEND_FROM_NAME: "GoSpaza" };
    const service = new NotificationFoundation(db, env, async actor => actor === "fixture_operator");
    const input = (name: string, channel: "IN_APP" | "EMAIL" = "IN_APP"): CreateInput => ({
      source: { type: "fixture", id: name, transition: "confirmed", committed_at: clock.toISOString(), evidence: name + "_proof" },
      kind: "FOUNDATION_TEST", recipient: { type: "customer", id: "customer_a" }, channel,
      destination: channel === "EMAIL" ? "recipient@example.test" : null,
      template: "test.notification", version: 1, input: { detail: "Synthetic bounded <notice>" },
      link: { route: "FOUNDATION_TEST", resource: "order_fixture" } });
    const create = async (value: CreateInput) => { const row = await service.create(value); assert.ok(row); return row; };
    assert.equal(await service.create(input("no_activation")), null);
    await assert.rejects(service.activate("foreign_operator", { request_id: "activation", reason: "Fixture activation" }), conflict);
    const decision = { request_id: "activation", reason: "Fixture activation" };
    const activation = await service.activate("fixture_operator", decision);
    assert.equal((await service.activate("fixture_operator", decision)).id, activation.id);
    await assert.rejects(service.activate("fixture_operator", { ...decision, reason: "changed" }), conflict);
    await advance(1000);
    assert.equal(await service.create({ ...input("before"), source: { ...input("before").source, committed_at: "2029-01-01T00:00:00Z" } }), null);
    const appInput = input("concurrent_app");
    const app = await Promise.all([service.create(appInput), service.create(appInput)]);
    assert.ok(app[0]); assert.equal(app[0].id, app[1]?.id);
    assert.equal(Number((await db("notification_notice").where({ intent_id: app[0].id }).count("* as n").first())?.n), 1);
    const mailInput = input("concurrent_mail", "EMAIL");
    const mail = await Promise.all([create(mailInput), create(mailInput)]);
    assert.equal(mail[0]?.id, mail[1]?.id);
    const original = await create(input("registry"));
    assert.equal((await create({ ...input("registry"), version: 2 })).id, original.id);
    assert.equal((await db("notification_intent").where({ id: original.id }).first()).template_version, 1);
    await assert.rejects(create({ ...input("registry"), input: { detail: "Changed payload" } }), conflict);
    const different = await create({ ...appInput, source: { ...appInput.source, transition: "delivered" } });
    assert.notEqual(different.id, app[0].id);
    const independent = await create({ ...appInput, channel: "EMAIL", destination: "recipient@example.test" });
    assert.notEqual(independent.id, app[0].id);
    const missing = await create({ ...input("missing", "EMAIL"), destination: "invalid-contact" });
    assert.equal((await service.inspect(missing.id))?.state, "SUPPRESSED");
    assert.equal((await service.inspect(missing.id))?.suppression_reason, "NO_RECIPIENT");
    assert.equal(await service.claim(missing.id), null);
    assert.equal(Number((await db("notification_attempt").where({ intent_id: missing.id }).count("* as n").first())?.n), 0);
    const noConfig = new NotificationFoundation(db, { APP_ENV: "test" });
    const unconfigured = await noConfig.create(input("unconfigured", "EMAIL")); assert.ok(unconfigured);
    assert.equal((await service.inspect(unconfigured.id))?.state, "ATTENTION_REQUIRED");
    assert.equal(await service.claim(unconfigured.id), null);
    await assert.rejects(service.readNotice({ type: "customer", id: "other" }, app[0].id, true), conflict);
    const beforeRead = await db("notification_intent").where({ id: app[0].id }).first();
    const notice = await service.readNotice({ type: "customer", id: "customer_a" }, app[0].id, true);
    assert.ok(notice.read_at);
    assert.deepEqual(await service.readNotice({ type: "customer", id: "customer_a" }, app[0].id, true), notice);
    assert.deepEqual(await db("notification_intent").where({ id: app[0].id }).first(), beforeRead);

    let calls = 0, mode = "accepted";
    const accepted = new Map<string, { hash: string; id: string }>();
    const envelopes: { key: string; body: string }[] = [];
    const request: typeof fetch = async (_url, options) => {
      calls++;
      const key = new Headers(options?.headers).get("Idempotency-Key"); assert.ok(key);
      const body = String(options?.body); envelopes.push({ key, body });
      if (mode === "retryable") return new Response('{"name":"rate_limit_exceeded"}', { status: 429 });
      if (mode === "terminal") return new Response('{"name":"validation_error"}', { status: 422 });
      if (mode === "ambiguous") throw Error("synthetic lost response");
      const prior = accepted.get(key);
      if (prior) { assert.equal(prior.hash, digest(body)); return new Response(JSON.stringify({ id: prior.id })); }
      const providerId = "email_" + randomUUID(); accepted.set(key, { hash: digest(body), id: providerId });
      return new Response(JSON.stringify({ id: providerId }));
    };
    const provider = new ResendNotificationProvider({}, { apiKey: "fixture-key" }, request);
    // Pick<> overload cast is confined to this controlled module substitute.
    const native = { createNotifications: async (data: { idempotency_key: string }[]) => {
      const record = data[0]; assert.ok(record);
      try {
        const result = await provider.send(record as unknown as Parameters<typeof provider.send>[0]);
        return [{ id: "noti_" + randomUUID(), external_id: result.id, status: "success" }] as NotificationDTO[];
      } catch (error) { throw new Error("Native provider wrapper: " + (error instanceof Error ? error.message : "failure")); }
    } } as unknown as Pick<INotificationModuleService, "createNotifications">;
    const transport = new NativeNotificationTransport(native);
    const parallel = await create(input("parallel_execute", "EMAIL"));
    const beforeParallel = calls;
    const executions = await Promise.all([service.execute(parallel.id, transport), service.execute(parallel.id, transport)]);
    assert.equal(executions.filter(Boolean).length, 1);
    assert.equal(calls, beforeParallel + 1);
    assert.equal((await service.inspect(parallel.id))?.state, "ACCEPTED");
    const racing = await create(input("claim_race", "EMAIL"));
    const claims = await Promise.all([service.claim(racing.id), service.claim(racing.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const owner = claims.find(value => value !== null); assert.ok(owner);
    await assert.rejects(service.begin({ ...owner, provider_key: owner.provider_key + "changed" }), conflict);
    assert.equal(await db("notification_attempt_started").where({ attempt_id: owner.id }).first(), undefined);
    // Claim persisted, crash before begin: no transport call, recover safely.
    const initialCalls = calls;
    await advance(90001); assert.equal(await service.recoverExpired(racing.id), true);
    assert.equal(calls, initialCalls);
    assert.equal((await db("notification_attempt_result").where({ attempt_id: owner.id }).first()).code, "CLAIM_NOT_DISPATCHED");
    await advance(60000);
    assert.equal(await service.execute(racing.id, transport), true);
    assert.equal((await service.inspect(racing.id))?.state, "ACCEPTED");
    assert.deepEqual((await db("notification_attempt").where({ intent_id: racing.id }).orderBy("attempt_number")).map(row => row.attempt_number), [1, 2]);
    assert.equal(await service.execute(racing.id, transport), false);
    const result = await db("notification_attempt_result as r").join("notification_attempt as a", "a.id", "r.attempt_id")
      .where({ "a.intent_id": racing.id, "r.classification": "ACCEPTED" }).select("r.*").first();
    assert.ok(result.provider_id); assert.ok(result.native_id);
    const evidence = { event_id: "event_accepted", provider_id: result.provider_id, attempt_id: result.attempt_id,
      event_type: "delivered", occurred_at: clock.toISOString() };
    await service.recordKnownEvidence(evidence); await service.recordKnownEvidence(evidence);
    await assert.rejects(service.recordKnownEvidence({ ...evidence, event_type: "bounced" }), conflict);
    await assert.rejects(service.recordKnownEvidence({ ...evidence, event_id: "unknown", provider_id: "unbound" }), conflict);

    mode = "retryable";
    const retry = await create(input("retry", "EMAIL"));
    await service.execute(retry.id, transport);
    assert.equal((await service.inspect(retry.id))?.state, "RETRYABLE_FAILURE");
    assert.equal(new Date((await service.inspect(retry.id))?.next_attempt_at ?? 0).getTime(), clock.getTime() + 60000);
    assert.equal(await service.claim(retry.id), null);
    await advance(60000); mode = "accepted"; await service.execute(retry.id, transport);
    const retryAttempts = await db("notification_attempt").where({ intent_id: retry.id }).orderBy("attempt_number");
    assert.equal(retryAttempts.length, 2); assert.equal(retryAttempts[0].provider_key, retryAttempts[1].provider_key);
    assert.equal(retryAttempts[0].envelope_hash, retryAttempts[1].envelope_hash);
    assert.deepEqual(envelopes.at(-1), envelopes.at(-2));
    mode = "terminal";
    const terminal = await create(input("terminal", "EMAIL")); await service.execute(terminal.id, transport);
    assert.equal((await service.inspect(terminal.id))?.state, "TERMINAL_FAILURE"); assert.equal(await service.claim(terminal.id), null);
    const suppressed = await create(input("stale", "EMAIL"));
    await service.suppress(suppressed.id, "STALE"); assert.equal(await service.claim(suppressed.id), null);
    await assert.rejects(service.suppress(suppressed.id, "STALE"), conflict);
    mode = "retryable";
    const exhausted = await create(input("exhausted", "EMAIL"));
    for (const delay of [0, 60000, 300000, 1800000]) { await advance(delay); await service.execute(exhausted.id, transport); }
    assert.equal((await service.inspect(exhausted.id))?.attempts, 4);
    assert.equal((await service.inspect(exhausted.id))?.state, "ATTENTION_REQUIRED");
    assert.equal(await service.claim(exhausted.id), null);
    mode = "ambiguous";
    const uncertain = await create(input("uncertain", "EMAIL")); await service.execute(uncertain.id, transport);
    assert.equal((await db("notification_attempt_result as r").join("notification_attempt as a", "a.id", "r.attempt_id")
      .where({ "a.intent_id": uncertain.id }).first()).classification, "AMBIGUOUS");
    await advance(60000); mode = "accepted"; await service.execute(uncertain.id, transport);
    assert.equal((await service.inspect(uncertain.id))?.state, "ACCEPTED");

    const fault = async (table: string, run: () => Promise<unknown>) => {
      await db.raw(`create function private_notification_fault() returns trigger as $fixture$
        begin raise exception 'M22 fixture rollback'; end; $fixture$ language plpgsql`);
      await db.raw("create trigger private_notification_fault before insert on ?? for each row execute function private_notification_fault()", [table]);
      try { await assert.rejects(run, (error: unknown) => error instanceof Error && error.message.includes("M22 fixture rollback")); }
      finally { await db.raw("drop trigger private_notification_fault on ??", [table]); await db.raw("drop function private_notification_fault()"); }
    };
    const appCount = Number((await db("notification_intent").count("* as n").first())?.n);
    await fault("notification_notice", () => create(input("atomic_app")));
    assert.equal(Number((await db("notification_intent").count("* as n").first())?.n), appCount);
    const atomicAttempt = await create(input("atomic_attempt", "EMAIL"));
    await fault("notification_attempt", () => service.claim(atomicAttempt.id));
    assert.equal((await service.inspect(atomicAttempt.id))?.attempts, 0);
    assert.equal((await service.inspect(atomicAttempt.id))?.state, "PENDING");
    // Provider accepted, local result transaction failed: replay must not send twice.
    mode = "accepted";
    const lost = await create(input("accepted_local_failure", "EMAIL"));
    const remoteBefore = accepted.size;
    await fault("notification_attempt_result", () => service.execute(lost.id, transport));
    assert.equal(accepted.size, remoteBefore + 1);
    assert.equal((await service.inspect(lost.id))?.state, "IN_PROGRESS");
    await advance(90001); await service.recoverExpired(lost.id); await advance(60000);
    await service.execute(lost.id, transport);
    assert.equal(accepted.size, remoteBefore + 1);
    assert.equal((await service.inspect(lost.id))?.state, "ACCEPTED");
    assert.deepEqual(envelopes.at(-1), envelopes.at(-2));
    const expired = await create(input("expired_ambiguity", "EMAIL"));
    const expiredClaim = await service.claim(expired.id); assert.ok(expiredClaim); await service.begin(expiredClaim);
    await advance(REPLAY_MS + 1); await service.recoverExpired(expired.id);
    assert.equal((await service.inspect(expired.id))?.state, "ATTENTION_REQUIRED"); assert.equal(await service.claim(expired.id), null);
    await assert.rejects(async () => { await db("notification_intent").where({ id: retry.id }).update({ destination: "changed@example.test" }); },
      (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    await assert.rejects(async () => { await db("notification_attempt").where({ intent_id: retry.id }).delete(); },
      (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    console.log("M22-B notification foundation passed (private PostgreSQL schema; controlled Medusa/Resend transport; no real email).");
  } finally {
    await db.destroy();
    // schema is a locally generated fixed-prefix identifier, never an input.
    if (created) await base.raw("drop schema ?? cascade", [schema]);
  }
}
