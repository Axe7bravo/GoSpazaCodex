import { OrderOperationsService } from "./order-operations-service";
import { choosePreference, preferenceDTO, preferenceRow, resolutionRows, resolutionDTO, omittedFor, synchronizeShortage, decideOmission } from "../modules/marketplace/shortage-resolution";
import { accounted, shortageConflict, shortageAdmissionInput } from "../modules/marketplace/shortage-policy";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { InferTypeOf, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { BigNumber, ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { PickingList, PickingOrder, PickingResult } from "@gospaza/contracts";
import type MarketplaceService from "../modules/marketplace/service";
import type PickSession from "../modules/marketplace/models/pick-session";
import type PickLine from "../modules/marketplace/models/pick-line";
import type PickEvent from "../modules/marketplace/models/pick-event";
import type MerchantMember from "../modules/marketplace/models/merchant-member";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import { completedOrderCandidates, readOrderHandoff, insertOrderOperation } from "../modules/marketplace/order-operation-repository";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { orderParse } from "../modules/marketplace/order-operation-policy";
import { requireCapability, resourceId } from "../modules/marketplace/team-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { pickingCommand, pickingConflict, pickingFingerprint, pickingListInput, pickingMissing, validatePicked } from "../modules/marketplace/picking-policy";
import type { PickingAction } from "../modules/marketplace/picking-policy";
import { nativeOrderQuantity, readOperationalOrder } from "./order-operation-native";

type Session = InferTypeOf<typeof PickSession>;
type Line = Omit<InferTypeOf<typeof PickLine>, "ordered_quantity_at_start" | "picked_quantity"> & { ordered_quantity_at_start: number; picked_quantity: number };
type StoredLine = Omit<Line, "ordered_quantity_at_start" | "picked_quantity"> & { ordered_quantity_at_start: string | number; picked_quantity: string | number };
type Event = InferTypeOf<typeof PickEvent>;
type Member = InferTypeOf<typeof MerchantMember>;
const forbidden = () => new MedusaError(MedusaError.Types.FORBIDDEN, "Only the active assignee may pick this order.");

export class PickingService {
  private readonly db: Knex;
  private readonly marketplace: MarketplaceService;
  constructor(private readonly container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.marketplace = container.resolve<MarketplaceService>("marketplace");
  }
  private async lines(trx: Knex.Transaction, sessionId: string): Promise<Line[]> {
    const rows = await trx<StoredLine>("pick_line").where({ pick_session_id: sessionId }).orderBy("medusa_order_line_id").forUpdate();
    return rows.map((row) => {
      const ordered = nativeOrderQuantity(row.ordered_quantity_at_start), picked = Number(row.picked_quantity);
      validatePicked(ordered, picked, row.shortage_recorded);
      return { ...row, ordered_quantity_at_start: ordered, picked_quantity: picked };
    });
  }
  private async load(trx: Knex.Transaction, tenant: { merchant: { id: string }; store: { id: string } }, orderId: string) {
    const operation = await trx<OrderOperationRow>("order_operation").where({
      medusa_order_id: orderId, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id,
    }).whereNull("deleted_at").forUpdate().first();
    if (!operation) throw pickingMissing();
    if (operation.status !== "ACCEPTED") throw pickingConflict();
    const handoff = await readOrderHandoff(trx, orderId, tenant);
    if (!handoff || handoff.completion_id !== operation.checkout_completion_id
      || !await trx("delivery_reservation").where({ id: handoff.reservation_id, status: "COMMITTED" }).first()) throw pickingMissing();
    const order = await readOperationalOrder(this.container, handoff);
    const nativeLines = (order.items ?? []).map((item) => ({
      id: item.id, variant_id: item.variant_id ?? null, quantity: nativeOrderQuantity(item.quantity),
      title: item.title, variant_title: item.variant_title ?? null, sku: item.variant_sku ?? null,
    }));
    const fingerprint = pickingFingerprint(nativeLines);
    const session = await trx<Session>("pick_session").where({ order_operation_id: operation.id }).forUpdate().first();
    const lines = session ? await this.lines(trx, session.id) : [];
    if (session) {
      if (session.deleted_at || session.source_lines_fingerprint !== fingerprint || lines.length !== nativeLines.length) throw pickingConflict();
      for (const native of nativeLines) {
        const line = lines.find((row) => row.medusa_order_line_id === native.id);
        if (!line || line.deleted_at || line.ordered_quantity_at_start !== native.quantity) throw pickingConflict();
        validatePicked(native.quantity, line.picked_quantity, line.shortage_recorded);
      }
    }
    const resolutions = session ? await resolutionRows(trx, session.id) : [];
    for (const line of lines) omittedFor(line, resolutions);
    return { operation, order, nativeLines, fingerprint, session, lines, resolutions, handoff };
  }
  // Internal M15 handoff. Caller holds the merchant lock in the supplied transaction.
  // Keep M12/M13 accounting and native evidence in their existing owner.
  async completedForDispatch(trx: Knex.Transaction, merchantId: string, storeId: string, orderId: string) {
    const state = await this.load(trx, { merchant: { id: merchantId }, store: { id: storeId } }, orderId);
    if (!state.session || state.session.status !== "COMPLETED" || !state.session.completed_at || !state.lines.length
      || state.lines.some(line => !accounted(line.ordered_quantity_at_start, line.picked_quantity, omittedFor(line, state.resolutions)))
      || !await trx("pick_event").where({ pick_session_id: state.session.id, revision: state.session.revision, action: "COMPLETE" }).first()) throw pickingConflict();
    return { order: state.order, operation: state.operation, handoff: state.handoff, session: state.session };
  }
  private project(state: Awaited<ReturnType<PickingService["load"]>>): PickingOrder {
    return {
      id: state.order.id, display_id: state.order.display_id, created_at: new Date(state.order.created_at).toISOString(),
      status: state.session?.status ?? "NOT_STARTED", revision: state.session?.revision ?? 0,
      assigned_member_id: state.session?.assigned_member_id ?? null,
      started_at: state.session ? new Date(state.session.started_at).toISOString() : null,
      completed_at: state.session?.completed_at ? new Date(state.session.completed_at).toISOString() : null,
      lines: state.nativeLines.map((native) => {
        const line = state.lines.find((row) => row.medusa_order_line_id === native.id);
        const picked = line?.picked_quantity ?? 0;
        return { id: native.id, title: native.title, variant_title: native.variant_title, sku: native.sku,
          ordered_quantity: native.quantity, picked_quantity: picked,
          omitted_quantity: line ? omittedFor(line, state.resolutions) : 0,
          shortage_recorded: line?.shortage_recorded ?? false, unresolved_quantity: native.quantity - picked - (line ? omittedFor(line, state.resolutions) : 0) };
      }),
    };
  }
  async detail(identity: string, orderId: string): Promise<PickingOrder> {
    orderParse(resourceId, orderId);
    return withMerchantAuthorization(this.db, this.marketplace, identity, "MERCHANT_PICKING_VIEW",
      async (trx, tenant) => this.project(await this.load(trx, tenant, orderId)));
  }
  async list(identity: string, value: unknown): Promise<PickingList> {
    const input = orderParse(pickingListInput, value);
    return withMerchantAuthorization(this.db, this.marketplace, identity, "MERCHANT_PICKING_VIEW", async (trx, tenant) => {
      const query = completedOrderCandidates(trx, tenant)
        .join("order_operation as op", "op.checkout_completion_id", "c.id")
        .leftJoin("pick_session as ps", "ps.order_operation_id", "op.id")
        .where({ "op.status": "ACCEPTED", "r.status": "COMMITTED" }).whereNull("op.deleted_at");
      if (input.status) query.whereRaw("coalesce(ps.status, 'NOT_STARTED') = ?", [input.status]);
      const count = await query.clone().count<{ count: string }>("op.id as count").first();
      const rows: { order_id: string }[] = await query.select("op.medusa_order_id as order_id")
        .orderBy("op.accepted_at").orderBy("op.id").limit(input.limit).offset(input.offset);
      const orders: PickingOrder[] = [];
      for (const row of rows) orders.push(this.project(await this.load(trx, tenant, row.order_id)));
      return { orders, count: Number(count?.count ?? 0), limit: input.limit, offset: input.offset };
    });
  }
  async shortageDetail(identity: string, orderId: string) {
    orderParse(resourceId, orderId);
    return withMerchantAuthorization(this.db, this.marketplace, identity, "MERCHANT_PICKING_VIEW", async (trx, tenant) => {
      const state = await this.load(trx, tenant, orderId);
      return { preference: preferenceDTO(await preferenceRow(trx, state.operation.id)),
        shortages: state.resolutions.map(resolutionDTO) };
    });
  }
  async admitShortage(identity: string, orderId: string, lineId: string, value: unknown) {
    orderParse(resourceId, orderId); orderParse(resourceId, lineId);
    const input = orderParse(shortageAdmissionInput, value);
    return withMerchantAuthorization(this.db, this.marketplace, identity, "MERCHANT_PICKING_PERFORM", async (trx, tenant) => {
      const state = await this.load(trx, tenant, orderId);
      const session = state.session;
      if (!session || session.status !== "IN_PROGRESS" || session.revision !== input.expected_revision) throw shortageConflict();
      if (session.assigned_member_id !== tenant.membership.id) throw forbidden();
      const line = state.lines.find((row) => row.medusa_order_line_id === lineId);
      if (!line) throw pickingMissing();
      if (!line.shortage_recorded || line.picked_quantity >= line.ordered_quantity_at_start) throw shortageConflict();
      const row = await synchronizeShortage(trx, { operationId: state.operation.id, orderId,
        completionId: state.operation.checkout_completion_id, sessionId: session.id, fingerprint: state.fingerprint },
        line, { type: "merchant", id: tenant.membership.id });
      if (!row) throw shortageConflict();
      return resolutionDTO(row);
    });
  }
  async customerShortages(customerId: string, orderId: string, action: "READ" | "PREFERENCE" | "OMIT", value?: unknown, caseId?: string) {
    return new OrderOperationsService(this.container).withCustomerOrder(customerId, orderId, async (trx, handoff) => {
      await insertOrderOperation(trx, handoff);
      const operation = await trx<OrderOperationRow>("order_operation").where({ medusa_order_id: orderId,
        merchant_id: handoff.merchant_id, merchant_store_id: handoff.merchant_store_id }).whereNull("deleted_at").forUpdate().first();
      if (!operation) throw pickingMissing();
      // Preferences are useful before merchant acceptance; shortages still require ACCEPTED.
      if (operation.status === "PENDING_ACCEPTANCE" && action !== "OMIT") {
        return action === "PREFERENCE"
          ? { preference: await choosePreference(trx, operation.id, customerId, value) }
          : { preference: preferenceDTO(await preferenceRow(trx, operation.id)), shortages: [] };
      }
      const state = await this.load(trx, { merchant: { id: handoff.merchant_id }, store: { id: handoff.merchant_store_id } }, orderId);
      if (action === "PREFERENCE") {
        if (state.session?.status === "COMPLETED") {
          return { preference: await choosePreference(trx, state.operation.id, customerId, value, false) };
        }
        // An existing M12 shortage from before migration also freezes the default.
        if (state.session) for (const line of state.lines) {
          if (line.shortage_recorded) await synchronizeShortage(trx, { operationId: state.operation.id, orderId,
            completionId: state.operation.checkout_completion_id, sessionId: state.session.id, fingerprint: state.fingerprint },
            line, { type: "system", id: null });
        }
        return { preference: await choosePreference(trx, state.operation.id, customerId, value) };
      }
      if (action === "OMIT") {
        const id = orderParse(resourceId, caseId);
        const row = await trx<{ pick_line_id: string }>("shortage_resolution")
          .where({ id, order_operation_id: state.operation.id }).first();
        if (!row || !state.session) throw pickingMissing();
        const line = state.lines.find((item) => item.id === row.pick_line_id);
        if (!line) throw pickingMissing();
        return { shortage: await decideOmission(trx, { operationId: state.operation.id, orderId,
          completionId: state.operation.checkout_completion_id, sessionId: state.session.id, fingerprint: state.fingerprint },
          line, customerId, id, value, state.session.status) };
      }
      return { preference: preferenceDTO(await preferenceRow(trx, state.operation.id)), shortages: state.resolutions.map(resolutionDTO) };
    });
  }
  async mutate(identity: string, orderId: string, action: PickingAction, value: unknown, lineId?: string): Promise<PickingResult> {
    orderParse(resourceId, orderId);
    const command = pickingCommand(action, value, lineId);
    const capability = action === "REASSIGN" ? "MERCHANT_PICKING_REASSIGN" : "MERCHANT_PICKING_PERFORM";
    return withMerchantAuthorization(this.db, this.marketplace, identity, capability, async (trx, tenant) => {
      const state = await this.load(trx, tenant, orderId);
      let session = state.session;
      const actor = tenant.membership.id;
      const result = (revision: number): PickingResult => ({ picking: this.project(state), applied_revision: revision });
      const audit = async (row: Session, previous: number, before: Record<string, unknown>, after: Record<string, unknown>, now: Date) => {
        await trx("pick_event").insert({
          id: "pevt_" + randomUUID(), pick_session_id: row.id, revision: row.revision, previous_revision: previous,
          action, acting_member_id: actor, medusa_order_line_id: command.action === "LINE" ? command.line_id : null,
          request: JSON.stringify(command.input), before: JSON.stringify(before), after: JSON.stringify(after),
          occurred_at: now, created_at: now, updated_at: now,
        });
      };
      if (command.action === "CLAIM") {
        if (session) {
          if (session.assigned_member_id !== actor) throw pickingConflict();
          return result(session.revision);
        }
        const now = await databaseTime(trx);
        const [created] = await trx<Session>("pick_session").insert({
          id: "pick_" + randomUUID(), order_operation_id: state.operation.id, assigned_member_id: actor,
          status: "IN_PROGRESS", revision: 1, source_lines_fingerprint: state.fingerprint,
          started_at: now, completed_at: null, created_at: now, updated_at: now,
        }).returning("*");
        if (!created) throw pickingConflict();
        state.session = created;
        await trx("pick_line").insert(state.nativeLines.map((line) => ({
          id: "pline_" + randomUUID(), pick_session_id: created.id, medusa_order_line_id: line.id,
          ordered_quantity_at_start: line.quantity, raw_ordered_quantity_at_start: JSON.stringify(new BigNumber(line.quantity).raw),
          picked_quantity: 0, raw_picked_quantity: JSON.stringify(new BigNumber(0).raw), shortage_recorded: false,
          created_at: now, updated_at: now,
        })));
        state.lines = await this.lines(trx, created.id);
        await audit(created, 0, {}, { assigned_member_id: actor }, now);
        return result(1);
      }
      if (!session) throw pickingConflict();
      // Authorization precedes replay: an old assignee cannot reuse a receipt to regain access.
      if (command.action !== "REASSIGN" && session.assigned_member_id !== actor) throw forbidden();
      const line = command.action === "LINE" ? state.lines.find((row) => row.medusa_order_line_id === command.line_id) : undefined;
      if (command.action === "LINE" && !line) throw pickingMissing();
      const expected = command.input.expected_revision;
      if (expected !== session.revision) {
        const event = await trx<Event>("pick_event").where({ pick_session_id: session.id, previous_revision: expected }).first();
        if (event && event.acting_member_id === actor && event.action === command.action
          && event.medusa_order_line_id === (command.action === "LINE" ? command.line_id : null)
          && isDeepStrictEqual(event.request, command.input)) return result(event.revision);
        throw pickingConflict();
      }
      if (session.status !== "IN_PROGRESS") throw pickingConflict();
      const now = await databaseTime(trx);
      let before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
      let assigned = session.assigned_member_id;
      if (command.action === "LINE") {
        if (!line) throw pickingMissing();
        validatePicked(line.ordered_quantity_at_start, command.input.picked_quantity, command.input.shortage_recorded);
        if (omittedFor(line, state.resolutions) > 0 && (line.picked_quantity !== command.input.picked_quantity || line.shortage_recorded !== command.input.shortage_recorded)) throw pickingConflict();
        if (line.picked_quantity === command.input.picked_quantity && line.shortage_recorded === command.input.shortage_recorded) return result(session.revision);
        before = { picked_quantity: line.picked_quantity, shortage_recorded: line.shortage_recorded };
        after = { picked_quantity: command.input.picked_quantity, shortage_recorded: command.input.shortage_recorded };
        await trx("pick_line").where({ id: line.id }).update({
          picked_quantity: command.input.picked_quantity, raw_picked_quantity: JSON.stringify(new BigNumber(command.input.picked_quantity).raw),
          shortage_recorded: command.input.shortage_recorded, updated_at: now,
        });
        line.picked_quantity = command.input.picked_quantity;
        line.shortage_recorded = command.input.shortage_recorded;
        await synchronizeShortage(trx, { operationId: state.operation.id, orderId,
          completionId: state.operation.checkout_completion_id, sessionId: session.id, fingerprint: state.fingerprint },
          line, { type: "merchant", id: actor });
        state.resolutions = await resolutionRows(trx, session.id);
      } else if (command.action === "REASSIGN") {
        const target = await trx<Member>("merchant_member").where({
          id: command.input.target_member_id, merchant_id: tenant.merchant.id, status: "ACTIVE",
        }).whereNull("deleted_at").first();
        if (!target) throw pickingMissing();
        // Resolving the target also checks owner/application identity and active tenant state.
        const targetTenant = await this.marketplace.resolveTenant(target.auth_identity_id, trx);
        if (targetTenant.merchant.id !== tenant.merchant.id || targetTenant.store.id !== tenant.store.id) throw pickingMissing();
        requireCapability(targetTenant.membership.member_type, "MERCHANT_PICKING_PERFORM");
        if (assigned === target.id) return result(session.revision);
        before = { assigned_member_id: assigned }; assigned = target.id;
        after = { assigned_member_id: assigned };
      } else {
        if (!state.lines.length || state.lines.some((row) => !accounted(row.ordered_quantity_at_start, row.picked_quantity, omittedFor(row, state.resolutions)))) throw pickingConflict();
        before = { status: session.status }; after = { status: "COMPLETED" };
      }
      const [updated] = await trx<Session>("pick_session").where({ id: session.id }).update({
        revision: session.revision + 1, assigned_member_id: assigned,
        status: command.action === "COMPLETE" ? "COMPLETED" : "IN_PROGRESS",
        completed_at: command.action === "COMPLETE" ? now : null, updated_at: now,
      }).returning("*");
      if (!updated) throw pickingConflict();
      await audit(updated, session.revision, before, after, now);
      session = updated; state.session = updated;
      return result(session.revision);
    });
  }
}
