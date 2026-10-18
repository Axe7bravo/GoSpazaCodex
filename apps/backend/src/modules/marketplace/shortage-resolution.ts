import type { ShortagePreference, ShortageResolution } from "@gospaza/contracts";
import { randomUUID } from "node:crypto";
import type { InferTypeOf } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type Preference from "./models/order-shortage-preference";
import type Resolution from "./models/shortage-resolution";
import { databaseTime } from "./delivery-reservation-repository";
import { orderParse } from "./order-operation-policy";
import { shortageConflict, shortageEvidence, preferenceInput, omissionInput } from "./shortage-policy";

export type PreferenceRow = InferTypeOf<typeof Preference>;
export type ResolutionRow = InferTypeOf<typeof Resolution>;
export interface ShortageLine {
  id: string; medusa_order_line_id: string; ordered_quantity_at_start: number;
  picked_quantity: number; shortage_recorded: boolean;
}
export interface ShortageScope {
  operationId: string; orderId: string; completionId: string;
  sessionId: string; fingerprint: string;
}
export interface ShortageActor { type: "merchant" | "customer" | "system"; id: string | null }

async function event(trx: Knex.Transaction, operationId: string, action: string,
  actor: ShortageActor, evidence: Record<string, unknown>, caseId: string | null = null) {
  const now = await databaseTime(trx);
  await trx("shortage_event").insert({ id: "shevt_" + randomUUID(), order_operation_id: operationId,
    shortage_resolution_id: caseId, action, actor_type: actor.type, actor_id: actor.id,
    evidence: JSON.stringify(evidence), occurred_at: now, created_at: now, updated_at: now });
}
export async function preferenceRow(trx: Knex.Transaction, operationId: string) {
  return trx<PreferenceRow>("order_shortage_preference").where({ order_operation_id: operationId }).forUpdate().first();
}
export function preferenceDTO(row?: PreferenceRow): ShortagePreference {
  return { preference: row?.preference ?? "CONTACT_ME", revision: row?.revision ?? 0,
    chosen_at: row?.chosen_at ? new Date(row.chosen_at).toISOString() : null,
    frozen_at: row?.frozen_at ? new Date(row.frozen_at).toISOString() : null };
}
export async function choosePreference(trx: Knex.Transaction, operationId: string, customerId: string, value: unknown, canChange = true) {
  const input = orderParse(preferenceInput, value);
  const row = await preferenceRow(trx, operationId);
  // Same-value replay never rewrites provenance, including a frozen default.
  if (row && row.preference === input.preference) return preferenceDTO(row);
  if (!canChange || row?.frozen_at || input.expected_revision !== (row?.revision ?? 0)) throw shortageConflict();
  const now = await databaseTime(trx);
  const data = { preference: input.preference, customer_id: customerId, chosen_at: now, updated_at: now };
  const [saved] = row
    ? await trx<PreferenceRow>("order_shortage_preference").where({ id: row.id }).update({ ...data, revision: row.revision + 1 }).returning("*")
    : await trx<PreferenceRow>("order_shortage_preference").insert({ ...data, id: "osp_" + randomUUID(),
      order_operation_id: operationId, revision: 1, created_at: now }).returning("*");
  if (!saved) throw shortageConflict();
  await event(trx, operationId, row ? "PREFERENCE_CHANGED" : "PREFERENCE_CHOSEN",
    { type: "customer", id: customerId }, { preference: saved.preference, revision: saved.revision });
  return preferenceDTO(saved);
}
async function freezePreference(trx: Knex.Transaction, operationId: string) {
  let row = await preferenceRow(trx, operationId);
  if (row?.frozen_at) return row;
  const now = await databaseTime(trx);
  if (row) {
    [row] = await trx<PreferenceRow>("order_shortage_preference").where({ id: row.id })
      .update({ frozen_at: now, revision: row.revision + 1, updated_at: now }).returning("*");
  } else {
    [row] = await trx<PreferenceRow>("order_shortage_preference").insert({ id: "osp_" + randomUUID(),
      order_operation_id: operationId, preference: "CONTACT_ME", revision: 1, frozen_at: now,
      created_at: now, updated_at: now }).returning("*");
  }
  if (!row) throw shortageConflict();
  await event(trx, operationId, "PREFERENCE_FROZEN", { type: "system", id: null },
    { preference: row.preference, revision: row.revision, preference_id: row.id });
  return row;
}
export async function resolutionRows(trx: Knex.Transaction, sessionId: string) {
  return trx<ResolutionRow>("shortage_resolution").where({ pick_session_id: sessionId })
    .whereNull("invalidated_at").orderBy("pick_line_id").forUpdate();
}
export function omittedFor(line: ShortageLine, rows: ResolutionRow[]): number {
  const row = rows.find((r) => r.pick_line_id === line.id);
  if (!row) return 0;
  const e = shortageEvidence.parse(row.evidence);
  if (e.ordered !== line.ordered_quantity_at_start || e.picked !== line.picked_quantity
    || e.native_line_id !== line.medusa_order_line_id || !line.shortage_recorded) throw shortageConflict();
  return row.status === "RESOLVED_OMITTED" ? e.missing : 0;
}
export function resolutionDTO(row: ResolutionRow): ShortageResolution {
  const e = shortageEvidence.parse(row.evidence);
  return { id: row.id, line_id: e.native_line_id, status: row.status, revision: row.revision,
    ordered_quantity: e.ordered, picked_quantity: e.picked,
    omitted_quantity: row.status === "RESOLVED_OMITTED" ? e.missing : 0,
    unresolved_quantity: row.status === "RESOLVED_OMITTED" ? 0 : e.missing,
    preference: e.preference, financial_review_required: row.financial_review_required,
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null };
}
// Caller holds merchant -> operation -> session -> all original lines.
export async function synchronizeShortage(trx: Knex.Transaction, scope: ShortageScope,
  line: ShortageLine, actor: ShortageActor) {
  const current = await trx<ResolutionRow>("shortage_resolution").where({ pick_line_id: line.id })
    .whereNull("invalidated_at").forUpdate().first();
  if (current) {
    const e = shortageEvidence.parse(current.evidence);
    const same = line.shortage_recorded && e.picked === line.picked_quantity && e.ordered === line.ordered_quantity_at_start;
    if (same) return current;
    if (current.status === "RESOLVED_OMITTED") throw shortageConflict();
    const now = await databaseTime(trx);
    await trx("shortage_resolution").where({ id: current.id }).update({ invalidated_at: now, revision: current.revision + 1, updated_at: now });
    await event(trx, scope.operationId, "SHORTAGE_INVALIDATED", actor,
      { revision: current.revision + 1, original_picked: line.picked_quantity, shortage_recorded: line.shortage_recorded }, current.id);
  }
  if (!line.shortage_recorded || line.picked_quantity >= line.ordered_quantity_at_start) return null;
  const preference = await freezePreference(trx, scope.operationId);
  const now = await databaseTime(trx);
  const automatic = preference.preference === "NO_SUBSTITUTION";
  if (automatic && !preference.customer_id) throw shortageConflict();
  const evidence = shortageEvidence.parse({ ordered: line.ordered_quantity_at_start, picked: line.picked_quantity,
    missing: line.ordered_quantity_at_start - line.picked_quantity, native_order_id: scope.orderId,
    native_line_id: line.medusa_order_line_id, checkout_completion_id: scope.completionId,
    source_lines_fingerprint: scope.fingerprint, preference: preference.preference, preference_revision: preference.revision });
  const [row] = await trx<ResolutionRow>("shortage_resolution").insert({ id: "shr_" + randomUUID(),
    order_operation_id: scope.operationId, pick_session_id: scope.sessionId, pick_line_id: line.id,
    preference_id: preference.id, status: automatic ? "RESOLVED_OMITTED" : "CUSTOMER_DECISION_REQUIRED",
    revision: 1, evidence, financial_review_required: automatic,
    resolved_at: automatic ? now : null, created_at: now, updated_at: now }).returning("*");
  if (!row) throw shortageConflict();
  await event(trx, scope.operationId, "SHORTAGE_CREATED", actor, { generation: row.id, revision: row.revision, ...evidence }, row.id);
  if (automatic) await event(trx, scope.operationId, "OMITTED_BY_PREFERENCE", { type: "system", id: null },
    { revision: row.revision, preference_id: preference.id, customer_id: preference.customer_id, omitted_quantity: evidence.missing }, row.id);
  return row;
}
export async function decideOmission(trx: Knex.Transaction, scope: ShortageScope, line: ShortageLine,
  customerId: string, caseId: string, value: unknown, sessionStatus: string) {
  const input = orderParse(omissionInput, value);
  const row = await trx<ResolutionRow>("shortage_resolution").where({ id: caseId,
    order_operation_id: scope.operationId, pick_session_id: scope.sessionId, pick_line_id: line.id }).forUpdate().first();
  if (!row || row.invalidated_at) throw shortageConflict();
  const e = shortageEvidence.parse(row.evidence);
  if (e.picked !== line.picked_quantity || e.ordered !== line.ordered_quantity_at_start || !line.shortage_recorded) throw shortageConflict();
  if (row.status === "RESOLVED_OMITTED" && row.decision_customer_id === customerId && input.expected_revision === row.revision - 1) return resolutionDTO(row);
  if (sessionStatus !== "IN_PROGRESS" || row.status !== "CUSTOMER_DECISION_REQUIRED" || row.revision !== input.expected_revision) throw shortageConflict();
  const preference = await preferenceRow(trx, scope.operationId);
  if (!preference?.frozen_at || preference.id !== row.preference_id || preference.preference !== "CONTACT_ME") throw shortageConflict();
  const now = await databaseTime(trx);
  const [resolved] = await trx<ResolutionRow>("shortage_resolution").where({ id: row.id }).update({
    status: "RESOLVED_OMITTED", revision: row.revision + 1, decision_customer_id: customerId,
    resolved_at: now, financial_review_required: true, updated_at: now }).returning("*");
  if (!resolved) throw shortageConflict();
  await event(trx, scope.operationId, "CUSTOMER_OMITTED", { type: "customer", id: customerId },
    { revision: resolved.revision, expected_revision: input.expected_revision, omitted_quantity: e.missing }, row.id);
  return resolutionDTO(resolved);
}
