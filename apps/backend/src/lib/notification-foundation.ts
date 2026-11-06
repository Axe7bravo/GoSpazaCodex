import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { z } from "@medusajs/framework/zod";
import { resendConfiguration } from "./notification-config";
import { actor, canReplay, createInput, destination, digest, envelopeSchema, id, identity, LEASE_MS, MAX_ATTEMPTS,
  nextState, NotificationConflict, providerKey, render, requestFingerprint, retryAt, sourceEligible, suppression,
  type Actor, type Envelope, type State, type TransportResult } from "./notification-policy";
import type { CreateInput } from "./notification-policy";

interface Intent { id: string; logical_key: string; channel: "IN_APP" | "EMAIL"; recipient_type: string; recipient_id: string;
  request_fingerprint: string; envelope: Envelope | null; envelope_hash: string | null; provider_key: string | null;
  credential_fingerprint: string | null;
  template_key: string; template_version: number; title: string; body: string; deep_link: string | null }
interface Delivery { intent_id: string; revision: number; state: State; suppression_reason: string | null; attempts: number;
  claim_token: string | null; lease_until: Date | null; first_sent_at: Date | null; next_attempt_at: Date | null; accepted_at: Date | null }
export interface SendClaim { id: string; intent_id: string; attempt_number: number; claim_token: string;
  provider_key: string; envelope_hash: string; credential_fingerprint: string; lease_until: Date }
export interface NotificationTransport {
  send(claim: SendClaim, envelope: Envelope): Promise<TransportResult>;
}
const activationInput = z.object({ request_id: id, reason: z.string().trim().min(1).max(240),
  activated_at: z.string().datetime({ offset: true }).optional() }).strict();
const makeId = (prefix: string) => prefix + randomUUID();
async function now(db: Knex | Knex.Transaction): Promise<Date> {
  const result = await db.raw("select gospaza_notification_now() as instant");
  return new Date(result.rows[0].instant);
}
async function serialize(db: Knex.Transaction, key: string) {
  await db.raw("select pg_advisory_xact_lock(?::bigint)", [BigInt.asIntN(64, BigInt("0x" + digest(key).slice(0, 16))).toString()]);
}

// Internal primitives, not an HTTP/CRUD service. C must supply owner-verified
// source/recipient evidence; it must never forward untrusted request bodies here.
export class NotificationFoundation {
  constructor(private readonly db: Knex, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly activationAuthority: (actorId: string) => Promise<boolean> = async () => false) {}

  async activate(actorId: string, value: unknown) {
    id.parse(actorId);
    if (!await this.activationAuthority(actorId)) throw new NotificationConflict();
    const input = activationInput.parse(value), fingerprint = digest({ actorId, ...input });
    return this.db.transaction(async trx => {
      await serialize(trx, "M22_ACTIVATION");
      if (!await this.activationAuthority(actorId)) throw new NotificationConflict();
      const previous = await trx("notification_activation").where({ revision: 1 }).first();
      if (previous) {
        if (previous.request_id !== input.request_id || previous.fingerprint !== fingerprint) throw new NotificationConflict();
        return previous;
      }
      const recorded = await now(trx), activated = input.activated_at ? new Date(input.activated_at) : recorded;
      if (activated < recorded) throw new NotificationConflict();
      const [row] = await trx("notification_activation").insert({ id: makeId("nact_"), revision: 1, activated_at: activated,
        recorded_at: recorded, actor_id: actorId, reason: input.reason, request_id: input.request_id, fingerprint }).returning("*");
      return row;
    });
  }

  private async activationFor(db: Knex | Knex.Transaction, source: CreateInput["source"]) {
    const activation = await db("notification_activation").where({ revision: 1 }).first(), clock = await now(db);
    return sourceEligible(activation ? new Date(activation.activated_at) : null, new Date(source.committed_at), clock) ? activation : null;
  }
  async eligible(source: CreateInput["source"]) { return !!await this.activationFor(this.db, createInput.shape.source.parse(source)); }

  async create(value: unknown, current?: (trx: Knex.Transaction) => Promise<boolean>): Promise<Intent | null> {
    const input = createInput.parse(value);
    if (input.channel === "IN_APP" && (input.recipient.type === "guest" || input.destination !== null)) throw new NotificationConflict();
    const logical = identity(input), fingerprint = requestFingerprint(input);
    return this.db.transaction(async trx => {
      await serialize(trx, logical);
      const existing = await trx<Intent>("notification_intent").where({ logical_key: logical }).first();
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new NotificationConflict();
        return existing; // no rendering or configuration resolution for replay
      }
      const activation = await this.activationFor(trx, input.source);
      if (!activation || current && !await current(trx)) return null;
      const clock = await now(trx);
      const output = render(input, this.env.APP_ENV), to = input.channel === "EMAIL" ? destination(input.destination) : null;
      const config = resendConfiguration(this.env);
      const envelope = input.channel === "EMAIL" && to && config ? envelopeSchema.parse({ from: config.from, to,
        subject: output.subject, text: output.text, html: output.html, reply_to: config.replyTo }) : null;
      const state: State = input.channel === "IN_APP" ? "ACCEPTED" : !to ? "SUPPRESSED" : !envelope ? "ATTENTION_REQUIRED" : "PENDING";
      const reason = state === "SUPPRESSED" ? "NO_RECIPIENT" : null;
      const [row] = await trx("notification_intent").insert({ id: makeId("nint_"), logical_key: logical, request_fingerprint: fingerprint,
        source_type: input.source.type, source_id: input.source.id, source_transition: input.source.transition,
        source_committed_at: input.source.committed_at, source_evidence: input.source.evidence, kind: input.kind,
        recipient_type: input.recipient.type, recipient_id: input.recipient.id, channel: input.channel, destination: to,
        template_key: input.template, template_version: input.version, title: output.title, subject: output.subject,
        body: output.text, html: output.html, deep_link: output.path, envelope: envelope ? JSON.stringify(envelope) : null,
        envelope_hash: envelope ? digest(envelope) : null, provider_key: input.channel === "EMAIL" ? providerKey(logical) : null,
        credential_fingerprint: envelope && config ? digest(config.apiKey) : null,
        activation_id: activation.id }).returning("*");
      if (!row) throw new NotificationConflict();
      await trx("notification_delivery_event").insert({ intent_id: row.id, revision: 1, from_state: null, to_state: state,
        code: reason ?? (state === "ATTENTION_REQUIRED" ? "CONFIGURATION" : "CREATED") });
      await trx("notification_delivery").insert({ intent_id: row.id, revision: 1, state, suppression_reason: reason,
        accepted_at: state === "ACCEPTED" ? clock : null });
      if (input.channel === "IN_APP") await trx("notification_notice").insert({ intent_id: row.id });
      return row;
    });
  }

  // Caller identity is supplied by the authenticated owning-domain adapter in D.
  // Public read projections will not expose Intent/internal transport fields.
  async readNotice(principal: Actor, intentId: string, markRead = false) {
    actor.parse(principal); id.parse(intentId);
    return this.db.transaction(async trx => {
      const notice = await trx("notification_notice as n").join("notification_intent as i", "i.id", "n.intent_id")
        .where({ "i.id": intentId, "i.recipient_type": principal.type, "i.recipient_id": principal.id })
        .select("i.title", "i.body", "i.deep_link", "n.created_at", "n.read_at").first();
      if (!notice) throw new NotificationConflict();
      if (markRead && !notice.read_at) {
        await trx("notification_notice").where({ intent_id: intentId }).whereNull("read_at").update({ read_at: await now(trx) });
        const current = await trx("notification_notice").where({ intent_id: intentId }).first();
        notice.read_at = current?.read_at;
      }
      return notice;
    });
  }
  async inspect(intentId: string) { return this.db<Delivery>("notification_delivery").where({ intent_id: id.parse(intentId) }).first(); }

  async configurationAttention(intentId: string, code: "CONFIGURATION" | "CONFIGURATION_CHANGED" | "ENVELOPE_INVALID" = "CONFIGURATION") {
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: id.parse(intentId) }).forUpdate().first();
      if (!row || !["PENDING", "RETRYABLE_FAILURE"].includes(row.state)) return false;
      await this.change(trx, row, { state: "ATTENTION_REQUIRED", next_attempt_at: null }, code);
      return true;
    });
  }

  private async change(trx: Knex.Transaction, row: Delivery, patch: Partial<Delivery>, code: string) {
    const next = { ...row, ...patch, revision: row.revision + 1 };
    await trx("notification_delivery_event").insert({ intent_id: row.intent_id, revision: next.revision,
      from_state: row.state, to_state: next.state, code });
    await trx<Delivery>("notification_delivery").where({ intent_id: row.intent_id, revision: row.revision }).update(next);
  }
  async suppress(intentId: string, reason: unknown, ifPending = false) {
    const code = suppression.parse(reason);
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: id.parse(intentId) }).forUpdate().first();
      if (!row || !["PENDING", "RETRYABLE_FAILURE"].includes(row.state)) {
        if (ifPending) return false;
        throw new NotificationConflict();
      }
      await this.change(trx, row, { state: "SUPPRESSED", suppression_reason: code, next_attempt_at: null }, code);
    });
  }

  async claim(intentId: string): Promise<SendClaim | null> {
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: id.parse(intentId) }).forUpdate().first();
      const intent = await trx<Intent>("notification_intent").where({ id: intentId }).first(), clock = await now(trx);
      if (!row || !intent || intent.channel !== "EMAIL" || !["PENDING", "RETRYABLE_FAILURE"].includes(row.state)
        || row.next_attempt_at && clock < new Date(row.next_attempt_at)) return null;
      if (row.attempts >= MAX_ATTEMPTS || row.first_sent_at && !canReplay(new Date(row.first_sent_at), clock)) {
        await this.change(trx, row, { state: "ATTENTION_REQUIRED", next_attempt_at: null }, "REPLAY_OR_ATTEMPT_LIMIT"); return null;
      }
      if (!intent.envelope || !intent.provider_key || !intent.envelope_hash || !intent.credential_fingerprint || digest(intent.envelope) !== intent.envelope_hash) throw new NotificationConflict();
      const claim: SendClaim = { id: makeId("natt_"), intent_id: intentId, attempt_number: row.attempts + 1,
        claim_token: randomUUID(), provider_key: intent.provider_key, envelope_hash: intent.envelope_hash,
        credential_fingerprint: intent.credential_fingerprint,
        lease_until: new Date(clock.getTime() + LEASE_MS) };
      await trx("notification_attempt").insert({ ...claim, provider: "RESEND", started_at: clock });
      await this.change(trx, row, { state: "IN_PROGRESS", attempts: claim.attempt_number, claim_token: claim.claim_token,
        lease_until: claim.lease_until, next_attempt_at: null }, "CLAIMED");
      return claim;
    });
  }

  async begin(claim: SendClaim): Promise<Envelope> {
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: claim.intent_id }).forUpdate().first();
      const attempt = await trx<SendClaim>("notification_attempt").where({ id: claim.id }).first();
      const intent = await trx<Intent>("notification_intent").where({ id: claim.intent_id }).first(), clock = await now(trx);
      if (!row || !attempt || !intent?.envelope || row.state !== "IN_PROGRESS" || row.claim_token !== claim.claim_token
        || attempt.claim_token !== claim.claim_token || attempt.intent_id !== claim.intent_id
        || clock >= new Date(attempt.lease_until) || digest(intent.envelope) !== claim.envelope_hash
        || intent.provider_key !== claim.provider_key || intent.credential_fingerprint !== claim.credential_fingerprint) throw new NotificationConflict();
      await trx("notification_attempt_started").insert({ attempt_id: claim.id, dispatched_at: clock });
      if (!row.first_sent_at) await this.change(trx, row, { first_sent_at: clock }, "DISPATCH_STARTED");
      return intent.envelope;
    });
  }

  private async finish(claim: SendClaim, result: TransportResult) {
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: claim.intent_id }).forUpdate().first();
      if (!row || row.state !== "IN_PROGRESS" || row.claim_token !== claim.claim_token) throw new NotificationConflict();
      const clock = await now(trx);
      const providerId = result.classification === "ACCEPTED" ? z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(result.providerId) : null;
      if (providerId) {
        await trx("notification_provider_message").insert({ provider_id: providerId, intent_id: claim.intent_id }).onConflict("provider_id").ignore();
        const binding = await trx("notification_provider_message").where({ provider_id: providerId }).first();
        if (binding?.intent_id !== claim.intent_id) throw new NotificationConflict();
      }
      const code = result.classification === "ACCEPTED" ? "PROVIDER_ACCEPTED" : /^[A-Z_]{1,60}$/.test(result.code) ? result.code : "TRANSPORT_FAILURE";
      await trx("notification_attempt_result").insert({ attempt_id: claim.id, classification: result.classification,
        code, summary: code, provider_id: providerId, native_id: result.classification === "ACCEPTED" ? result.nativeId ?? null : null, completed_at: clock });
      const retry = result.classification === "ACCEPTED" || result.classification === "TERMINAL" ? null
        : retryAt(claim.attempt_number, clock, row.first_sent_at ? new Date(row.first_sent_at) : null);
      await this.change(trx, row, { state: nextState(result, retry), claim_token: null, lease_until: null,
        next_attempt_at: retry, accepted_at: result.classification === "ACCEPTED" ? clock : null }, code);
    });
  }
  async execute(intentId: string, transport: NotificationTransport) {
    const claim = await this.claim(intentId);
    if (!claim) return false;
    const envelope = await this.begin(claim);
    let result: TransportResult;
    try { result = await transport.send(claim, envelope); }
    catch { result = { classification: "AMBIGUOUS", code: "TRANSPORT_UNCERTAIN" }; }
    await this.finish(claim, result);
    return true;
  }

  // Explicit D recovery primitive, not a worker or blind resend. The active
  // attempt is closed with append-only evidence before any new claim is allowed.
  async recoverExpired(intentId: string) {
    return this.db.transaction(async trx => {
      const row = await trx<Delivery>("notification_delivery").where({ intent_id: id.parse(intentId) }).forUpdate().first(), clock = await now(trx);
      if (!row || row.state !== "IN_PROGRESS" || !row.lease_until || clock < new Date(row.lease_until)) return false;
      const attempt = await trx<SendClaim>("notification_attempt").where({ intent_id: intentId, attempt_number: row.attempts }).first();
      if (!attempt) throw new NotificationConflict();
      const started = await trx("notification_attempt_started").where({ attempt_id: attempt.id }).first();
      const classification = started ? "AMBIGUOUS" : "RETRYABLE", code = started ? "LOST_SEND_RESULT" : "CLAIM_NOT_DISPATCHED";
      await trx("notification_attempt_result").insert({ attempt_id: attempt.id, classification, code, summary: code, completed_at: clock });
      const retry = retryAt(row.attempts, clock, row.first_sent_at ? new Date(row.first_sent_at) : null);
      await this.change(trx, row, { state: retry ? "RETRYABLE_FAILURE" : "ATTENTION_REQUIRED", claim_token: null,
        lease_until: null, next_attempt_at: retry }, code);
      return true;
    });
  }

  // D must call only after authenticated webhook verification or known-ID
  // adapter retrieval. This is deliberately not an HTTP event ingress.
  async recordKnownEvidence(value: unknown, transaction?: Knex.Transaction) {
    const input = z.object({ event_id: id, provider_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), attempt_id: id,
      event_type: z.enum(["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed"]),
      occurred_at: z.string().datetime({ offset: true }) }).strict().parse(value);
    const write = async (trx: Knex.Transaction) => {
      const known = await trx("notification_attempt_result").where({ attempt_id: input.attempt_id, provider_id: input.provider_id, classification: "ACCEPTED" }).first();
      if (!known) throw new NotificationConflict();
      const fingerprint = digest(input);
      await trx("notification_provider_evidence").insert({ ...input, fingerprint }).onConflict("event_id").ignore();
      const prior = await trx("notification_provider_evidence").where({ event_id: input.event_id }).first();
      if (prior?.fingerprint !== fingerprint) throw new NotificationConflict();
    };
    return transaction ? write(transaction) : this.db.transaction(write);
  }
}
