import assert from "node:assert/strict";
import type { ExecArgs, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { createHmac } from "node:crypto";
import verifyNotificationMappings from "./verify-notification-mappings";
import { notificationRuntimeSql } from "../modules/marketplace/notification-runtime-schema";
import { repairFamilies } from "../modules/marketplace/notification-repair-sources";
import { NotificationRuntime } from "../lib/notification-runtime";
import { NotificationRepair } from "../lib/notification-repair";
import { NotificationCurrentness } from "../lib/notification-currentness";
import { NotificationInbox } from "../lib/notification-inbox";
import { notificationHandler } from "../lib/notification-http";
import { digest, NotificationConflict, REPLAY_MS, type Actor } from "../lib/notification-policy";
import { transportDisposition } from "../lib/notification-runtime-policy";
import { receiveResendWebhook, verifyResendWebhook } from "../lib/notification-webhook";

export default async function verifyNotificationRuntime(args: ExecArgs) {
  const base = args.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("notification_worker_health"), "Apply M22-D migration first.");
  await verifyNotificationMappings(args, async fixture => {
    const { db, mappings, foundation, env, actors, seedOrder } = fixture;
    for (const sql of notificationRuntimeSql) await db.raw(sql);
    const clock = async () => new Date((await db("fixture_clock").first()).instant);
    const advance = async (ms: number) => { const next = new Date((await clock()).getTime() + ms); await db("fixture_clock").update({ instant: next }); return next; };
    const count = async (table: string, where: Record<string, unknown> = {}) => Number((await db(table).where(where).count("* as n").first())?.n);
    const create = async (name: string, recipient: Actor = { type: "customer", id: "customer_a" }, channel: "EMAIL" | "IN_APP" = "EMAIL") => {
      const result = await foundation.create({ source: { type: "fixture", id: name, transition: "CONFIRMED", committed_at: (await clock()).toISOString(), evidence: digest(name) },
        kind: "FOUNDATION_TEST", template: "test.notification", version: 1, recipient, channel,
        destination: channel === "EMAIL" ? "recipient@example.test" : null, input: { detail: "Bounded fixture notice" }, link: null });
      assert.ok(result); return result;
    };
    // Real repair -> same C source primitive. Private native Order/identity
    // boundary is controlled, exactly as C; no old domain mutations are rerun.
    const missingOrder = await seedOrder("runtime_missing");
    await seedOrder("runtime_old", new Date(fixture.clock.getTime() - 1000));
    await advance(1000);
    const repair = new NotificationRepair(args.container, { db, mappings, env });
    await db("notification_repair_checkpoint").insert(repairFamilies.filter(family => family !== "ORDER").map(family => ({ family,
      window_start: fixture.clock, window_end: fixture.clock, next_cycle_at: new Date(fixture.clock.getTime() + 86400000) })));
    await Promise.all([repair.discoverPage(), new NotificationRepair(args.container, { db, mappings, env }).discoverPage(), mappings.discover("ORDER", missingOrder.order)]);
    assert.equal(await count("notification_intent", { kind: "ORDER_CONFIRMED", recipient_id: missingOrder.customer }), 2);
    assert.equal(await count("notification_intent", { kind: "ORDER_CONFIRMED", recipient_id: "customer_runtime_old" }), 0);
    // A newly visible source timestamp behind the completed page is found on
    // the next postactivation sweep, including after a new repair instance.
    const lateOrder = await seedOrder("runtime_late_visibility", fixture.clock);
    await advance(3600001);
    await new NotificationRepair(args.container, { db, mappings, env }).discoverPage();
    assert.equal(await count("notification_intent", { kind: "ORDER_CONFIRMED", recipient_id: lateOrder.customer }), 2);
    const retrospective = await db("notification_intent").where({ kind: "ORDER_CONFIRMED", channel: "EMAIL", recipient_id: missingOrder.customer }).first();
    const currentness = new NotificationCurrentness(args.container, db, actors);
    assert.equal(await currentness.send(retrospective), null);
    await db("fixture_order").where({ id: missingOrder.order }).update({ contact: "changed@example.test" });
    assert.equal(await currentness.send(retrospective), "AUTHORIZATION_CHANGED");

    let sends = 0; const keys: string[] = [];
    const transport = { send: async (claim: { provider_key: string }) => {
      sends++; keys.push(claim.provider_key); return { classification: "ACCEPTED" as const, providerId: "provider_" + digest(claim.provider_key).slice(0, 32) };
    } };
    const runtime = new NotificationRuntime(args.container, { db, env, transport, eligibility: async () => null });
    const winner = await create("concurrent");
    const settled = await Promise.all([runtime.send(winner.id), new NotificationRuntime(args.container, { db, env, transport, eligibility: async () => null }).send(winner.id)]);
    assert.equal(settled.filter(Boolean).length, 1); assert.equal(sends, 1);
    assert.equal((await foundation.inspect(winner.id))?.state, "ACCEPTED");
    assert.equal(await count("notification_attempt", { intent_id: winner.id }), 1);
    const stale = await create("stale");
    await new NotificationRuntime(args.container, { db, env, transport, eligibility: async () => "STALE" }).send(stale.id);
    assert.equal((await foundation.inspect(stale.id))?.suppression_reason, "STALE"); assert.equal(sends, 1);
    const absent = await create("configuration");
    await new NotificationRuntime(args.container, { db, env: { ...env, RESEND_API_KEY: "" }, transport, eligibility: async () => null }).send(absent.id);
    assert.equal((await foundation.inspect(absent.id))?.state, "ATTENTION_REQUIRED"); assert.equal(await count("notification_attempt", { intent_id: absent.id }), 0);
    const retry = await create("retry");
    const retryRuntime = new NotificationRuntime(args.container, { db, env, eligibility: async () => null,
      transport: { send: async () => ({ classification: "RETRYABLE", code: "PROVIDER_BUSY" }) } });
    for (const [index, delay] of [[1, 60000], [2, 300000], [3, 1800000], [4, null]] as const) {
      const before = await clock(); await retryRuntime.send(retry.id); const state = await foundation.inspect(retry.id); assert.equal(state?.attempts, index);
      if (delay !== null) { assert.ok(state?.next_attempt_at); assert.equal(new Date(state.next_attempt_at).getTime(), before.getTime() + delay); await advance(delay); }
      else assert.equal(state?.state, "ATTENTION_REQUIRED");
    }
    await retryRuntime.send(retry.id); assert.equal(await count("notification_attempt", { intent_id: retry.id }), 4);
    const terminal = await create("terminal");
    await new NotificationRuntime(args.container, { db, env, eligibility: async () => null,
      transport: { send: async () => ({ classification: "TERMINAL", code: "PROVIDER_REJECTED" }) } }).send(terminal.id);
    assert.equal((await foundation.inspect(terminal.id))?.state, "TERMINAL_FAILURE"); assert.equal(await runtime.send(terminal.id), false);
    const unsent = await create("unsent"), claim = await foundation.claim(unsent.id); assert.ok(claim);
    await advance(90001); await runtime.recoverStuck();
    const unsentAttempt = await db("notification_attempt_result").where({ attempt_id: claim.id }).first();
    assert.equal(unsentAttempt.classification, "RETRYABLE"); assert.equal(unsentAttempt.code, "CLAIM_NOT_DISPATCHED");
    assert.equal(await count("notification_attempt_started", { attempt_id: claim.id }), 0);
    const crash = await create("accepted_local_crash"), beforeSends = sends;
    await db.raw(`create function fixture_fail_result() returns trigger as $fixture$ begin
      if NEW.code='PROVIDER_ACCEPTED' then raise exception 'fixture persistence failure' using errcode='23514'; end if;
      return NEW; end; $fixture$ language plpgsql`);
    await db.raw("create trigger fixture_fail_result before insert on notification_attempt_result for each row execute function fixture_fail_result()");
    await assert.rejects(runtime.send(crash.id), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
    await db.raw("drop trigger fixture_fail_result on notification_attempt_result");
    assert.equal(sends, beforeSends + 1); assert.equal((await foundation.inspect(crash.id))?.state, "IN_PROGRESS");
    await advance(90001); await runtime.recoverStuck();
    const lost = await db("notification_attempt as a").join("notification_attempt_result as r", "r.attempt_id", "a.id").where("a.intent_id", crash.id).first();
    assert.equal(lost.classification, "AMBIGUOUS"); assert.equal(lost.code, "LOST_SEND_RESULT");
    await advance(60000); await runtime.send(crash.id);
    assert.equal((await foundation.inspect(crash.id))?.state, "ACCEPTED");
    assert.equal(await count("notification_provider_message", { intent_id: crash.id }), 1);
    assert.equal(keys[keys.length - 1], keys[keys.length - 2]);
    const outside = await create("outside_horizon"), abandoned = await foundation.claim(outside.id); assert.ok(abandoned); await foundation.begin(abandoned);
    await advance(REPLAY_MS + 1); await runtime.recoverStuck();
    assert.equal((await foundation.inspect(outside.id))?.state, "ATTENTION_REQUIRED"); assert.equal(await runtime.send(outside.id), false);

    const known = await db("notification_attempt_result as r").join("notification_attempt as a", "a.id", "r.attempt_id").where({ "a.intent_id": winner.id, "r.classification": "ACCEPTED" }).first();
    const secret = "whsec_" + Buffer.from("controlled-runtime-webhook-key").toString("base64"), timestamp = Math.floor((await clock()).getTime() / 1000).toString();
    const raw = JSON.stringify({ type: "email.delivered", created_at: (await clock()).toISOString(), data: { email_id: known.provider_id, to: ["private@example.test"] } });
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update("webhook_a." + timestamp + "." + raw).digest("base64");
    const verified = verifyResendWebhook(raw, { "svix-id": "webhook_a", "svix-timestamp": timestamp, "svix-signature": "v1," + signature }, secret, (await clock()).getTime()); assert.ok(verified);
    await Promise.all([receiveResendWebhook(db, verified), receiveResendWebhook(db, verified)]);
    assert.equal(await count("notification_webhook_receipt", { event_id: "webhook_a" }), 1);
    await assert.rejects(receiveResendWebhook(db, { ...verified, fingerprint: digest("changed") }), error => error instanceof NotificationConflict);
    await assert.rejects(receiveResendWebhook(db, { ...verified, event_id: "unknown_event", provider_id: "unknown_provider" }), error => error instanceof NotificationConflict);
    await foundation.recordKnownEvidence({ event_id: "late_delayed", provider_id: known.provider_id, attempt_id: known.attempt_id, event_type: "delivery_delayed", occurred_at: (await clock()).toISOString() });
    const evidence = await db("notification_provider_evidence").where({ provider_id: known.provider_id });
    assert.equal(transportDisposition(evidence.map(row => row.event_type), true), "delivered");
    await foundation.recordKnownEvidence({ event_id: "permanent_bounce", provider_id: known.provider_id, attempt_id: known.attempt_id,
      event_type: "bounced", occurred_at: (await clock()).toISOString() });
    const sendsBeforeBounceReplay = sends;
    assert.equal(await runtime.send(winner.id), false); assert.equal(sends, sendsBeforeBounceReplay);
    await runtime.retrieveKnown(async providerId => ({ providerId, event: "sent" }));
    assert.ok(await count("notification_provider_evidence") >= 3);
    await runtime.retrieveKnown(async () => ({ providerId: "mismatched", event: "sent" }));
    assert.ok(await count("notification_runtime_observation", { category: "RETRIEVAL_MISMATCH" }) > 0);

    // API-level route handlers + real PostgreSQL ownership/read state. Native
    // session identity readback is controlled; no claim of live-cookie/browser
    // acceptance or live Resend verification is made by this isolated proof.
    await db.raw("create table fixture_session(id text primary key,actor text,actor_id text,active boolean not null default true)");
    const sessions = [{ id: "customer_session", actor: "customer", actor_id: "customer_a" }, { id: "foreign_customer_session", actor: "customer", actor_id: "customer_b" },
      { id: "identity_OWNER", actor: "merchant", actor_id: "member_OWNER" }, { id: "identity_FOREIGN", actor: "merchant", actor_id: "member_FOREIGN" },
      { id: "driver_identity", actor: "driver", actor_id: "driver" }, { id: "foreign_driver_identity", actor: "driver", actor_id: "foreign_driver" },
      { id: "operator_session", actor: "user", actor_id: "operator" }, { id: "viewer_session", actor: "user", actor_id: "unrelated" }];
    await db("fixture_session").insert(sessions);
    const native = new Map<string, unknown>([[ContainerRegistrationKeys.PG_CONNECTION, db], [Modules.AUTH, {
      retrieveAuthIdentity: async (identity: string) => { const row = await db("fixture_session").where({ id: identity, active: true }).first();
        if (!row) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Session revoked.");
        return { id: row.id, app_metadata: { [row.actor + "_id"]: row.actor_id }, provider_identities: [{ provider: "emailpass" }] }; } }],
      [Modules.CUSTOMER, { retrieveCustomer: async (customer: string) => ({ id: customer, has_account: true }) }],
      [Modules.USER, { retrieveUser: async (user: string) => ({ id: user }) }], ["marketplace", { resolveTenant: async (identity: string) => {
        const row = await db("merchant_member").where({ auth_identity_id: identity }).first(), member = row && await actors.merchant(row.id);
        if (!member) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Membership revoked.");
        return { membership: { id: member.memberId, member_type: member.role }, merchant: { id: member.merchantId }, store: { id: member.storeId } }; } }]]);
    const scope = new Proxy(args.container, { get: (target, key) => key === "resolve" ? (name: string) => native.has(name) ? native.get(name) : target.resolve(name) : Reflect.get(target, key) }) as MedusaContainer;
    const request = async (session: typeof sessions[number], action: "list" | "detail" | "read" | "operations" | "health", notice = "", query: Record<string, unknown> = {}) => {
      let status = 200, body: unknown;
      const response = { setHeader: () => undefined, status: (code: number) => { status = code; return response; }, json: (value: unknown) => { body = value; return response; } };
      const req = { scope, auth_context: { actor_type: session.actor, actor_id: session.actor_id, auth_identity_id: session.id }, params: { id: notice }, query, body: {} };
      await notificationHandler(session.actor as "customer" | "merchant" | "driver" | "user", action)(req as unknown as MedusaRequest, response as unknown as MedusaResponse);
      return { status, body };
    };
    const customerNotice = await create("customer_notice", { type: "customer", id: "customer_a" }, "IN_APP");
    const merchantNotice = await create("merchant_notice", { type: "merchant", id: "member_OWNER" }, "IN_APP");
    const driverNotice = await create("driver_notice", { type: "driver", id: "driver" }, "IN_APP");
    const customerSession = sessions[0], foreignCustomer = sessions[1], merchantSession = sessions[2], foreignMerchant = sessions[3], driverSession = sessions[4], foreignDriver = sessions[5], operatorSession = sessions[6], viewerSession = sessions[7];
    assert.ok(customerSession && foreignCustomer && merchantSession && foreignMerchant && driverSession && foreignDriver && operatorSession && viewerSession);
    for (const [own, foreign, notice] of [[customerSession, foreignCustomer, customerNotice], [merchantSession, foreignMerchant, merchantNotice], [driverSession, foreignDriver, driverNotice]] as const) {
      const ownList = await request(own, "list"), foreignList = await request(foreign, "list");
      assert.equal(ownList.status, 200); assert.equal(foreignList.status, 200);
      assert.ok((ownList.body as { notifications: { id: string }[] }).notifications.some(row => row.id === notice.id));
      assert.equal((foreignList.body as { notifications: { id: string }[] }).notifications.some(row => row.id === notice.id), false);
      assert.equal((await request(own, "detail", notice.id)).status, 200);
      assert.equal((await request(foreign, "detail", notice.id)).status, 404);
      assert.equal((await request(foreign, "read", notice.id)).status, 404);
      const [first, second] = await Promise.all([request(own, "read", notice.id), request(own, "read", notice.id)]);
      assert.equal(first.status, 200); assert.deepEqual(first.body, second.body);
      assert.deepEqual((await request(own, "read", notice.id)).body, first.body);
    }
    await db("driver_profile").where({ id: "driver" }).update({ status: "SUSPENDED" });
    assert.equal((await request(driverSession, "detail", driverNotice.id)).status, 200);
    await db("fixture_session").where({ id: driverSession.id }).update({ active: false });
    assert.equal((await request(driverSession, "detail", driverNotice.id)).status, 401);
    await db("merchant_member").where({ id: "member_OWNER" }).update({ status: "INACTIVE" });
    assert.equal((await request(merchantSession, "detail", merchantNotice.id)).status, 401);
    await db("fixture_session").where({ id: customerSession.id }).update({ active: false });
    assert.equal((await request(customerSession, "list")).status, 401);
    const inbox = new NotificationInbox(args.container, db, { ...env, NOTIFICATION_OPERATIONS_VIEW_USER_IDS: "operator" });
    for (let index = 0; index < 3; index++) await create("page_" + index, { type: "customer", id: "page_customer" }, "IN_APP");
    const principal = { actor: { type: "customer" as const, id: "page_customer" } }, page = await inbox.list(principal, { limit: 2 }); assert.equal(page.notifications.length, 2); assert.ok(page.next_cursor);
    const next = await inbox.list(principal, { limit: 2, cursor: page.next_cursor }); assert.equal(next.notifications.length, 1);
    assert.equal(next.notifications.some(row => page.notifications.some(old => old.id === row.id)), false);
    assert.deepEqual(Object.keys(page.notifications[0] ?? {}).sort(), ["id", "kind", "title", "body", "deep_link", "created_at", "read_at"].sort());
    const previousGrant = process.env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS;
    const previousAudience = process.env.NOTIFICATION_AUDIENCE_DELIVERY_OPERATIONS_USER_IDS;
    try {
      process.env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS = "operator";
      process.env.NOTIFICATION_AUDIENCE_DELIVERY_OPERATIONS_USER_IDS = "operator";
      const platformNotice = await foundation.create({ source: { type: "dispatch_event", id: "platform_attention", transition: "ATTENTION",
        committed_at: (await clock()).toISOString(), evidence: digest("attention") }, kind: "DELIVERY_OPERATION_ATTENTION",
        template: "platform.delivery_attention", version: 1, recipient: { type: "user", id: "operator" }, channel: "IN_APP", destination: null,
        input: { reference: "review" }, link: null }); assert.ok(platformNotice);
      assert.equal((await request(operatorSession, "detail", platformNotice.id)).status, 200);
      assert.equal((await request(viewerSession, "detail", platformNotice.id)).status, 404);
      process.env.NOTIFICATION_AUDIENCE_DELIVERY_OPERATIONS_USER_IDS = "";
      assert.equal((await request(operatorSession, "detail", platformNotice.id)).status, 404);
      assert.equal((await request(operatorSession, "operations")).status, 200);
      assert.equal((await request(viewerSession, "operations")).status, 403);
      process.env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS = "";
      assert.equal((await request(operatorSession, "operations")).status, 403);
    } finally {
      if (previousGrant === undefined) delete process.env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS; else process.env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS = previousGrant;
      if (previousAudience === undefined) delete process.env.NOTIFICATION_AUDIENCE_DELIVERY_OPERATIONS_USER_IDS; else process.env.NOTIFICATION_AUDIENCE_DELIVERY_OPERATIONS_USER_IDS = previousAudience;
    }
    const ops = await inbox.operations({ actor: { type: "user", id: "operator" } }, {});
    for (const forbidden of ["recipient@example.test", "provider_key", "envelope", "source_evidence", "Bounded fixture notice"])
      assert.equal(JSON.stringify(ops).includes(forbidden), false);
    await runtime.health("delivery", null); const health = await inbox.health({ actor: { type: "user", id: "operator" } });
    assert.ok(health.workers.some(worker => worker.name === "delivery" && worker.last_success_at));
    console.log("M22-D notification runtime passed (private PostgreSQL; controlled native identity/transport; no email).");
  });
}
