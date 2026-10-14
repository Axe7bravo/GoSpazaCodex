import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, InferTypeOf, IInventoryService, IOrderModuleService, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type PickSession from "../modules/marketplace/models/pick-session";
import type PickEvent from "../modules/marketplace/models/pick-event";
import verifyOrderOperations from "./verify-order-operations";
import { OrderOperationsService } from "../lib/order-operations-service";
import { PickingService } from "../lib/picking-service";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";

const picking = z.object({
  id: z.string(), status: z.enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED"]), revision: z.number(),
  assigned_member_id: z.string().nullable(), completed_at: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), ordered_quantity: z.number(), picked_quantity: z.number(),
    shortage_recorded: z.boolean(), unresolved_quantity: z.number() })),
});
const result = z.object({ picking, applied_revision: z.number() });
const acceptInput = { expected_revision: 0, confirmed: true };

export default async function verifyPicking(args: ExecArgs) {
  await verifyOrderOperations(args, async (f) => {
    const { fixture, ownerA, ownerB, manager, managerPeer, picker, applicant, platform, a, b, http, expect } = f;
    const { container, first, second } = fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const native = container.resolve<IOrderModuleService>(Modules.ORDER);
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
    const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const decisions = new OrderOperationsService(container), service = new PickingService(container);
    const ids = new Set<string>([a.orderId, b.orderId]);
    const path = (id: string) => "/merchant/picking/" + id;
    const claim = (cookie: string, id: string, body: unknown = {}) => http(cookie, "POST", path(id) + "/claim", body);
    const read = async (cookie: string, id: string) => z.object({ picking }).parse(expect(await http(cookie, "GET", path(id)))).picking;
    const update = (cookie: string, id: string, line: string, revision: number, quantity: unknown, shortage = false) =>
      http(cookie, "PUT", path(id) + "/lines/" + line, { expected_revision: revision, picked_quantity: quantity, shortage_recorded: shortage });
    const reassign = (cookie: string, id: string, revision: number, member: string) =>
      http(cookie, "POST", path(id) + "/reassign", { expected_revision: revision, target_member_id: member });
    const finish = (cookie: string, id: string, revision: number) =>
      http(cookie, "POST", path(id) + "/complete", { expected_revision: revision, confirmed: true });
    async function accepted(suffix: string) {
      const created = await f.complete("m12b-" + suffix); ids.add(created.orderId);
      await decisions.ensure(created.orderId);
      await decisions.decide(ownerA.identity, created.orderId, "accept", acceptInput);
      return created.orderId;
    }
    const sessionRows = () => db<InferTypeOf<typeof PickSession>>("pick_session").whereIn("order_operation_id",
      db("order_operation").select("id").whereIn("medusa_order_id", [...ids]));
    async function evidence(id: string) {
      const handoff = await readOrderHandoff(db, id); assert.ok(handoff);
      const receipt = z.object({ payment_id: z.string() }).parse(handoff.terminal_receipt);
      const order = await native.retrieveOrder(id, { relations: ["items", "shipping_methods"] });
      const reservations = await inventory.listReservationItems({ line_item_id: (order.items ?? []).map((line) => line.id) }, { take: null });
      const levels = reservations.length ? await inventory.listInventoryLevels({ inventory_item_id: reservations.map((row) => row.inventory_item_id) }, { take: null }) : [];
      const payment = await payments.retrievePayment(receipt.payment_id, { relations: ["captures", "refunds"] });
      const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
      const fulfillment = await query.graph({ entity: "order_fulfillment", fields: ["order_id", "fulfillment_id"], filters: { order_id: id } });
      return JSON.stringify({ order, payment, reservations: reservations.sort((x, y) => x.id.localeCompare(y.id)),
        levels: levels.sort((x, y) => x.id.localeCompare(y.id)), fulfillment: fulfillment.data });
    }
    const failures: unknown[] = [];
    try {
      // Admission uses M10 + ACCEPTED, never just a native Order or known ID.
      expect(await claim(picker.cookie, a.orderId), 409);
      await decisions.decide(ownerB.identity, b.orderId, "reject", acceptInput);
      expect(await claim(ownerB.cookie, b.orderId), 409);
      expect(await http(picker.cookie, "GET", "/merchant/orders/" + a.orderId), 403);
      expect(await http(picker.cookie, "POST", "/merchant/orders/" + a.orderId + "/accept", acceptInput), 403);
      expect(await http(picker.cookie, "POST", "/merchant/orders/" + a.orderId + "/reject", acceptInput), 403);
      await decisions.decide(ownerA.identity, a.orderId, "accept", acceptInput);
      const beforeNative = await evidence(a.orderId);
      const ready = await read(picker.cookie, a.orderId);
      assert.equal(ready.status, "NOT_STARTED");
      assert.equal((await sessionRows()).length, 0, "reads never create sessions");
      for (const cookie of [ownerA.cookie, manager.cookie, picker.cookie]) {
        const page = z.object({ orders: z.array(picking), count: z.number(), limit: z.number() })
          .parse(expect(await http(cookie, "GET", "/merchant/picking?limit=1&status=NOT_STARTED")));
        assert.equal(page.limit, 1); assert.ok(page.orders.every((row) => row.id !== b.orderId));
      }
      for (const cookie of ["", applicant.cookie, platform.cookie, a.person.cookie]) expect(await claim(cookie, a.orderId), 401);
      const foreign = await claim(ownerB.cookie, a.orderId), unknown = await claim(ownerB.cookie, "order_missing");
      expect(foreign, 404); expect(unknown, 404); assert.deepEqual(foreign.body, unknown.body);
      const foreignRead = await http(ownerB.cookie, "GET", path(a.orderId));
      expect(foreignRead, 404); expect(await http(ownerB.cookie, "GET", path("order_missing")), 404);
      const op = await decisions.ensure(a.orderId); assert.ok(op);
      expect(await claim(ownerA.cookie, op.id), 404);
      const recovery = await db<{ order_id: string | null }>("checkout_completion").where({ id: f.recovery.completionId }).first();
      assert.ok(recovery?.order_id, "prerequisite provides a real ambiguous native Order");
      expect(await claim(ownerA.cookie, recovery.order_id), 404);
      for (const key of ["merchant_id", "store_id", "assigned_member_id", "status", "revision", "order_id", "picked_quantity"]) {
        expect(await claim(picker.cookie, a.orderId, { [key]: "forged" }), 400);
        expect(await http(picker.cookie, "GET", "/merchant/picking?" + key + "=forged"), 400);
      }
      const race = await Promise.all([claim(picker.cookie, a.orderId), claim(manager.cookie, a.orderId)]);
      assert.deepEqual(race.map((row) => row.status).sort(), [200, 409], JSON.stringify(race));
      let current = await read(ownerA.cookie, a.orderId);
      const winner = current.assigned_member_id === picker.id ? picker : manager;
      const losing = winner.id === picker.id ? manager : picker;
      expect(await claim(losing.cookie, a.orderId), 409);
      const repeated = await Promise.all([claim(winner.cookie, a.orderId), claim(winner.cookie, a.orderId)]);
      repeated.forEach((row) => expect(row));
      assert.equal((await sessionRows()).length, 1);
      const session = await sessionRows().first(); assert.ok(session);
      expect(await claim(ownerA.cookie, session.id), 404);
      const line = current.lines[0]; assert.ok(line);
      const lineRecord = await db<{ id: string }>("pick_line").where({ pick_session_id: session.id }).first(); assert.ok(lineRecord);
      const nativeIdentity = await native.retrieveOrder(a.orderId, { relations: ["items"] });
      const storedIdentity = await db<{ medusa_order_line_id: string }>("pick_line").where({ pick_session_id: session.id });
      assert.deepEqual(storedIdentity.map((row) => row.medusa_order_line_id).sort(),
        (nativeIdentity.items ?? []).map((row) => row.id).sort(), "one operational line for every native line");
      const uniqueViolation = (error: unknown) => z.object({ code: z.literal("23505") }).safeParse(error).success;
      await assert.rejects(() => db.raw(
        'insert into pick_session (id, order_operation_id, assigned_member_id, status, revision, source_lines_fingerprint, started_at) '
        + 'select ?, order_operation_id, assigned_member_id, status, revision, source_lines_fingerprint, started_at from pick_session where id = ?',
        ["pick_" + randomUUID(), session.id],
      ), uniqueViolation);
      await assert.rejects(() => db.raw(
        'insert into pick_line (id, pick_session_id, medusa_order_line_id, ordered_quantity_at_start, raw_ordered_quantity_at_start, picked_quantity, raw_picked_quantity, shortage_recorded) '
        + 'select ?, pick_session_id, medusa_order_line_id, ordered_quantity_at_start, raw_ordered_quantity_at_start, picked_quantity, raw_picked_quantity, shortage_recorded from pick_line where id = ?',
        ["pline_" + randomUUID(), lineRecord.id],
      ), uniqueViolation);
      expect(await update(winner.cookie, a.orderId, lineRecord.id, current.revision, 0), 404);
      expect(await update(winner.cookie, a.orderId, "ordli_foreign", current.revision, 0), 404);
      expect(await update(ownerB.cookie, a.orderId, line.id, current.revision, 0), 404);
      expect(await update(losing.cookie, a.orderId, line.id, current.revision, 0), 403);
      expect(await finish(losing.cookie, a.orderId, current.revision), 403);
      expect(await finish(winner.cookie, a.orderId, current.revision), 409);
      for (const quantity of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1, line.ordered_quantity + 1]) {
        expect(await update(winner.cookie, a.orderId, line.id, current.revision, quantity), 400);
      }
      for (const key of ["merchant_id", "store_id", "member_id", "assigned_member_id", "ordered_quantity", "status", "price", "started_at", "completed_at", "acting_member_id"]) {
        expect(await http(winner.cookie, "PUT", path(a.orderId) + "/lines/" + line.id, {
          expected_revision: current.revision, picked_quantity: 0, shortage_recorded: false, [key]: "forged",
        }), 400);
        expect(await http(winner.cookie, "POST", path(a.orderId) + "/complete", {
          expected_revision: current.revision, confirmed: true, [key]: "forged",
        }), 400);
        expect(await http(ownerA.cookie, "POST", path(a.orderId) + "/reassign", {
          expected_revision: current.revision, target_member_id: managerPeer.id, [key]: "forged",
        }), 400);
      }
      const revision = current.revision;
      const writes = await Promise.all([
        update(winner.cookie, a.orderId, line.id, revision, 0, true),
        update(winner.cookie, a.orderId, line.id, revision, line.ordered_quantity, false),
      ]);
      assert.deepEqual(writes.map((row) => row.status).sort(), [200, 409], JSON.stringify(writes));
      current = await read(winner.cookie, a.orderId);
      const changed = current.lines[0]; assert.ok(changed);
      const eventCount = (await db("pick_event").where({ pick_session_id: session.id })).length;
      const replayed = result.parse(expect(await update(winner.cookie, a.orderId, line.id, revision, changed.picked_quantity, changed.shortage_recorded)));
      assert.equal(replayed.applied_revision, current.revision);
      assert.equal((await db("pick_event").where({ pick_session_id: session.id })).length, eventCount);
      current = result.parse(expect(await update(winner.cookie, a.orderId, line.id, current.revision, 0, true))).picking;
      expect(await finish(winner.cookie, a.orderId, current.revision), 409);
      current = result.parse(expect(await update(winner.cookie, a.orderId, line.id, current.revision, 0, false))).picking;
      assert.equal(current.lines[0]?.shortage_recorded, false);
      assert.equal(current.lines[0]?.unresolved_quantity, line.ordered_quantity);
      expect(await finish(winner.cookie, a.orderId, current.revision), 409);
      expect(await reassign(picker.cookie, a.orderId, current.revision, ownerA.id), 403);
      expect(await reassign(ownerA.cookie, a.orderId, current.revision, ownerB.id), 404);
      expect(await reassign(ownerA.cookie, a.orderId, current.revision, "mmem_missing"), 404);
      expect(await reassign(ownerA.cookie, a.orderId, current.revision, applicant.identity), 404);
      await db("merchant_member").where({ id: managerPeer.id }).update({ status: "INACTIVE" });
      expect(await reassign(ownerA.cookie, a.orderId, current.revision, managerPeer.id), 404);
      await db("merchant_member").where({ id: managerPeer.id }).update({ status: "ACTIVE" });
      const progress = current.lines;
      const reassignRevision = current.revision;
      current = result.parse(expect(await reassign(ownerA.cookie, a.orderId, current.revision, managerPeer.id))).picking;
      assert.deepEqual(current.lines, progress);
      assert.equal(current.assigned_member_id, managerPeer.id);
      expect(await reassign(ownerA.cookie, a.orderId, reassignRevision, managerPeer.id));
      expect(await update(winner.cookie, a.orderId, line.id, current.revision, 0), 403);
      // Manager may explicitly reassign, never implicitly edit another employee's work.
      current = result.parse(expect(await reassign(manager.cookie, a.orderId, current.revision, picker.id))).picking;
      assert.deepEqual(current.lines, progress);
      await db("merchant_member").where({ id: picker.id }).update({ status: "INACTIVE" });
      expect(await update(picker.cookie, a.orderId, line.id, current.revision, 0), 401);
      await db("merchant_member").where({ id: picker.id }).update({ status: "ACTIVE" });

      // Real waiting request sees revocation committed by the holder of the merchant lock.
      let pending: Promise<unknown> | undefined;
      await db.transaction(async (trx) => {
        await trx("merchant").where({ id: first.merchantId }).forUpdate().first();
        let observe: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => { observe = resolve; });
        const onQuery = (query: { sql: string; bindings?: readonly unknown[] }) => {
          if (query.sql.includes('from "merchant"') && query.sql.includes("for update") && query.bindings?.includes(first.merchantId)) observe?.();
        };
        db.on("query", onQuery);
        try {
          pending = service.mutate(picker.identity, a.orderId, "LINE", {
            expected_revision: current.revision, picked_quantity: 0, shortage_recorded: false,
          }, line.id).then(() => null, (error: unknown) => error);
          await Promise.race([blocked, pending.then(() => { throw new Error("Picking did not wait on merchant lock"); })]);
          await trx("merchant_member").where({ id: picker.id }).update({ status: "INACTIVE" });
        } finally { db.off("query", onQuery); }
      });
      const denied = await pending;
      assert.ok(denied instanceof MedusaError); assert.equal(denied.type, MedusaError.Types.UNAUTHORIZED);
      await db("merchant_member").where({ id: picker.id }).update({ status: "ACTIVE" });
      assert.deepEqual((await read(picker.cookie, a.orderId)).lines, progress);

      // Full original goods plus explicit shortage clearing permits completion.
      for (const original of current.lines) {
        current = result.parse(expect(await update(picker.cookie, a.orderId, original.id, current.revision, original.ordered_quantity))).picking;
      }
      const completionRevision = current.revision;
      const competing = await Promise.all([
        finish(picker.cookie, a.orderId, completionRevision),
        update(picker.cookie, a.orderId, line.id, completionRevision, 0),
      ]);
      assert.deepEqual(competing.map((row) => row.status).sort(), [200, 409], JSON.stringify(competing));
      current = await read(picker.cookie, a.orderId);
      if (current.status === "IN_PROGRESS") {
        current = result.parse(expect(await update(picker.cookie, a.orderId, line.id, current.revision, line.ordered_quantity))).picking;
        current = result.parse(expect(await finish(picker.cookie, a.orderId, current.revision))).picking;
      }
      assert.equal(current.status, "COMPLETED"); assert.ok(current.completed_at);
      expect(await finish(picker.cookie, a.orderId, current.revision - 1));
      expect(await update(picker.cookie, a.orderId, line.id, current.revision, 0), 409);
      expect(await reassign(ownerA.cookie, a.orderId, current.revision, manager.id), 409);
      await assert.rejects(() => db("pick_line").where({ id: lineRecord.id }).update({ picked_quantity: 0 }));
      await assert.rejects(() => db("pick_session").where({ id: session.id }).update({ status: "IN_PROGRESS", completed_at: null, revision: current.revision + 1 }));
      const events = await db<InferTypeOf<typeof PickEvent>>("pick_event").where({ pick_session_id: session.id }).orderBy("revision");
      assert.deepEqual(events.map((event) => event.revision), Array.from({ length: current.revision }, (_, index) => index + 1));
      assert.equal(events[0]?.acting_member_id, winner.id);
      assert.equal(events.at(-1)?.acting_member_id, picker.id);
      const terminalClaimReplay = result.parse(expect(await claim(picker.cookie, a.orderId)));
      assert.deepEqual(terminalClaimReplay.picking, current, "old claim cannot reset completed progress");
      assert.equal(terminalClaimReplay.applied_revision, current.revision);
      assert.equal((await db("pick_event").where({ pick_session_id: session.id })).length, events.length);
      assert.ok(events.every((event) => event.occurred_at));
      assert.equal(await evidence(a.orderId), beforeNative, "picking must not alter native order, stock, reservations, payment or fulfillment");
      const safe = JSON.stringify(expect(await http(picker.cookie, "GET", path(a.orderId))));
      for (const key of ["customer", "customer_id", "shipping_address", "totals", "unit_price", "payment_id", "snapshot", "order_operation_id", "merchant_id"]) {
        assert.equal(safe.includes('"' + key + '"'), false, "picking excludes " + key);
      }

      const handoverOrder = await accepted("completion-handover");
      current = result.parse(expect(await claim(ownerA.cookie, handoverOrder))).picking;
      for (const row of current.lines) current = result.parse(expect(await update(ownerA.cookie, handoverOrder, row.id, current.revision, row.ordered_quantity))).picking;
      const handover = await Promise.all([
        finish(ownerA.cookie, handoverOrder, current.revision),
        reassign(manager.cookie, handoverOrder, current.revision, picker.id),
      ]);
      assert.equal(handover.filter((row) => row.status === 200).length, 1, JSON.stringify(handover));
      assert.ok(handover.some((row) => row.status === 403 || row.status === 409), JSON.stringify(handover));
      const final = await read(manager.cookie, handoverOrder);
      assert.ok((final.status === "COMPLETED" && final.assigned_member_id === ownerA.id)
        || (final.status === "IN_PROGRESS" && final.assigned_member_id === picker.id));
      assert.ok(final.lines.every((row) => row.picked_quantity === row.ordered_quantity && !row.shortage_recorded));
      expect(await http(picker.cookie, "POST", "/admin/orders/" + a.orderId + "/fulfillments", {}), 401);
      expect(await http(a.person.cookie, "GET", "/store/orders/" + a.orderId), 404);
      // Real known foreign native line, not just an invented identifier.
      const foreignLines = await native.retrieveOrder(b.orderId, { relations: ["items"] });
      const foreignLine = foreignLines.items?.[0]; assert.ok(foreignLine);
      const targetOrder = await accepted("foreign-line");
      const target = result.parse(expect(await claim(picker.cookie, targetOrder))).picking;
      expect(await update(picker.cookie, targetOrder, foreignLine.id, target.revision, 0), 404);
      // DB quantity constraints and state/audit atomicity are independently enforced.
      const targetSession = await db<{ id: string }>("pick_session").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: targetOrder })).first(); assert.ok(targetSession);
      for (const quantity of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(() =>
        db("pick_line").where({ pick_session_id: targetSession.id }).update({ picked_quantity: quantity }));
      await assert.rejects(() => db("pick_session").where({ id: targetSession.id }).update({ revision: 2 }));
      assert.equal((await read(picker.cookie, targetOrder)).revision, 1);
      const targetLine = target.lines[0]; assert.ok(targetLine);
      const identical = await Promise.all([
        update(picker.cookie, targetOrder, targetLine.id, 1, 0, true),
        update(picker.cookie, targetOrder, targetLine.id, 1, 0, true),
      ]);
      identical.forEach((response) => expect(response));
      assert.deepEqual(identical[0]?.body, identical[1]?.body);
      assert.equal((await read(picker.cookie, targetOrder)).revision, 2);
      assert.equal((await db("pick_event").where({ pick_session_id: targetSession.id, action: "LINE" })).length, 1);
      const beforeFault = await read(picker.cookie, targetOrder);
      // Existing DB deferred audit constraint: intentionally omit the audit for
      // a real line + session write and prove the whole transaction rolls back.
      await assert.rejects(() => db.transaction(async (trx) => {
        await trx("merchant").where({ id: first.merchantId }).forUpdate().first();
        await trx("pick_line").where({ pick_session_id: targetSession.id, medusa_order_line_id: targetLine.id })
          .update({ shortage_recorded: false });
        await trx("pick_session").where({ id: targetSession.id }).update({ revision: 3 });
      }));
      assert.deepEqual(await read(picker.cookie, targetOrder), beforeFault);
      await assert.rejects(() => db("pick_event").where({ pick_session_id: targetSession.id }).update({ acting_member_id: ownerB.id }));
      const foreignQueue = z.object({ orders: z.array(picking), count: z.number() })
        .parse(expect(await http(ownerB.cookie, "GET", "/merchant/picking?limit=100")));
      assert.equal(foreignQueue.count, 0); assert.deepEqual(foreignQueue.orders, []);
      const paged = z.object({ orders: z.array(picking), limit: z.number(), offset: z.number() })
        .parse(expect(await http(picker.cookie, "GET", "/merchant/picking?limit=1&offset=1&status=IN_PROGRESS")));
      assert.equal(paged.limit, 1); assert.equal(paged.offset, 1);
      assert.ok(paged.orders.length <= 1 && paged.orders.every((row) => row.status === "IN_PROGRESS" && ids.has(row.id)));

      // M12-D: every mutation treats a known foreign Order exactly like an unknown one.
      for (const action of ["complete", "reassign"] as const) {
        const body = action === "complete"
          ? { expected_revision: 1, confirmed: true }
          : { expected_revision: 1, target_member_id: ownerB.id };
        const foreignAction = await http(ownerB.cookie, "POST", path(a.orderId) + "/" + action, body);
        const unknownAction = await http(ownerB.cookie, "POST", path("order_missing") + "/" + action, body);
        expect(foreignAction, 404);
        expect(unknownAction, 404);
        assert.deepEqual(foreignAction.body, unknownAction.body);
        for (const hostileId of [op.id, session.id, lineRecord.id]) {
          expect(await http(ownerA.cookie, "POST", path(hostileId) + "/" + action, body), 404);
        }
      }
      const unknownRead = await http(ownerB.cookie, "GET", path("order_missing"));
      assert.deepEqual(foreignRead.body, unknownRead.body);

      // Both requests run concurrently over HTTP; the merchant lock/revision chooses one.
      const lineHandoverOrder = await accepted("line-handover");
      const lineHandoverStart = result.parse(expect(await claim(picker.cookie, lineHandoverOrder))).picking;
      const handoverLine = lineHandoverStart.lines[0]; assert.ok(handoverLine);
      const lineHandoverRace = await Promise.all([
        update(picker.cookie, lineHandoverOrder, handoverLine.id, lineHandoverStart.revision, 0, true),
        reassign(manager.cookie, lineHandoverOrder, lineHandoverStart.revision, managerPeer.id),
      ]);
      assert.equal(lineHandoverRace.filter((response) => response.status === 200).length, 1, JSON.stringify(lineHandoverRace));
      assert.ok(lineHandoverRace.some((response) => response.status === 403 || response.status === 409), JSON.stringify(lineHandoverRace));
      const lineHandoverFinal = await read(manager.cookie, lineHandoverOrder);
      assert.equal(lineHandoverFinal.revision, lineHandoverStart.revision + 1);
      assert.equal(lineHandoverFinal.status, "IN_PROGRESS");
      if (lineHandoverRace[0]?.status === 200) {
        assert.equal(lineHandoverFinal.assigned_member_id, picker.id);
        assert.deepEqual(lineHandoverFinal.lines, lineHandoverStart.lines.map((row) =>
          row.id === handoverLine.id ? { ...row, shortage_recorded: true } : row));
      } else {
        assert.equal(lineHandoverFinal.assigned_member_id, managerPeer.id);
        assert.deepEqual(lineHandoverFinal.lines, lineHandoverStart.lines);
        expect(await finish(picker.cookie, lineHandoverOrder, lineHandoverFinal.revision), 403);
      }

      // Fault injection is restricted to this verifier's direct-service audit INSERT.
      // Knex's query event runs inside the transaction query Promise; throwing here
      // rejects the audit after the real state writes, exercising database rollback.
      const faultOrder = await accepted("audit-rollback");
      const faultNative = await evidence(faultOrder);
      async function operationalRows() {
        const sessions = db("pick_session").whereIn("order_operation_id",
          db("order_operation").select("id").where({ medusa_order_id: faultOrder }));
        return {
          sessions: await sessions.clone().select("*").orderBy("id"),
          lines: await db("pick_line").whereIn("pick_session_id", sessions.clone().select("id")).orderBy("id"),
          events: await db("pick_event").whereIn("pick_session_id", sessions.clone().select("id")).orderBy("revision"),
        };
      }
      async function auditRollback(action: "CLAIM" | "LINE" | "REASSIGN" | "COMPLETE", body: unknown, lineId?: string) {
        const before = await operationalRows();
        const failure = new Error("M12-D injected audit persistence failure: " + action);
        let intercepted = false;
        const onQuery = (query: { sql: string; bindings?: readonly unknown[] }) => {
          if (query.sql.startsWith('insert into "pick_event"') && query.bindings?.includes(action)
            && query.bindings.includes(ownerA.id)) {
            intercepted = true;
            throw failure;
          }
        };
        db.on("query", onQuery);
        try {
          await assert.rejects(() => service.mutate(ownerA.identity, faultOrder, action, body, lineId),
            (error: unknown) => error === failure);
        } finally {
          db.off("query", onQuery);
        }
        assert.equal(intercepted, true, "the real mutation must reach its audit write");
        assert.deepEqual(await operationalRows(), before, "audit failure must roll back " + action);
      }
      await auditRollback("CLAIM", {});
      assert.equal((await read(ownerA.cookie, faultOrder)).status, "NOT_STARTED");
      let faultState = result.parse(expect(await claim(ownerA.cookie, faultOrder))).picking;
      const faultLine = faultState.lines[0]; assert.ok(faultLine);
      await auditRollback("LINE", { expected_revision: faultState.revision, picked_quantity: 0, shortage_recorded: true }, faultLine.id);
      await auditRollback("REASSIGN", { expected_revision: faultState.revision, target_member_id: managerPeer.id });
      for (const row of faultState.lines) {
        faultState = result.parse(expect(await update(ownerA.cookie, faultOrder, row.id, faultState.revision, row.ordered_quantity))).picking;
      }
      await auditRollback("COMPLETE", { expected_revision: faultState.revision, confirmed: true });
      assert.deepEqual(await read(ownerA.cookie, faultOrder), faultState);
      assert.equal(await evidence(faultOrder), faultNative, "failed operational writes cannot change native commerce");

      // Deliberately corrupt only invocation-owned fixture state, after queue checks.
      // No repair, guard disabling or native SQL writes are used to make a test pass.
      const missingOrder = await accepted("missing-line");
      const missingState = result.parse(expect(await claim(picker.cookie, missingOrder))).picking;
      const missingSession = await db<{ id: string }>("pick_session").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: missingOrder })).first(); assert.ok(missingSession);
      const missingLine = missingState.lines[0]; assert.ok(missingLine);
      await db("pick_line").where({ pick_session_id: missingSession.id, medusa_order_line_id: missingLine.id }).delete();
      expect(await finish(picker.cookie, missingOrder, missingState.revision), 409);
      const stillOpen = await db<InferTypeOf<typeof PickSession>>("pick_session").where({ id: missingSession.id }).first();
      assert.equal(stillOpen?.status, "IN_PROGRESS");
      assert.equal(stillOpen?.completed_at, null);
      assert.equal(stillOpen?.revision, missingState.revision);

      // Supported pinned Order API simulates an external native edit to a fixture.
      // The native readback must reject its stale operational quantity baseline.
      const nativeChangeOrder = await accepted("native-line-change");
      const nativeChangeState = result.parse(expect(await claim(picker.cookie, nativeChangeOrder))).picking;
      const nativeChangeLine = nativeChangeState.lines[0]; assert.ok(nativeChangeLine);
      await native.updateOrderLineItems(nativeChangeLine.id, { quantity: nativeChangeLine.ordered_quantity + 1 });
      const changedNative = await native.retrieveOrder(nativeChangeOrder, { relations: ["items"] });
      assert.equal(Number(changedNative.items?.find((row) => row.id === nativeChangeLine.id)?.quantity), nativeChangeLine.ordered_quantity + 1);
      expect(await finish(picker.cookie, nativeChangeOrder, nativeChangeState.revision), 409);
      expect(await update(picker.cookie, nativeChangeOrder, nativeChangeLine.id, nativeChangeState.revision, 0), 409);
      const unchangedSession = await db<InferTypeOf<typeof PickSession>>("pick_session").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: nativeChangeOrder })).first();
      assert.equal(unchangedSession?.status, "IN_PROGRESS");
      assert.equal(unchangedSession?.revision, nativeChangeState.revision);
      assert.equal(unchangedSession?.completed_at, null);

    } catch (error) { failures.push(error); }
    // Only this invocation's orders, inside the existing prerequisite fixture lifetime.
    try {
      await db.transaction(async (trx) => {
        await trx("merchant").whereIn("id", [first.merchantId, second.merchantId]).orderBy("id").forUpdate().select("id");
        const sessions = trx("pick_session").select("id").whereIn("order_operation_id",
          trx("order_operation").select("id").whereIn("medusa_order_id", [...ids]));
        await trx("pick_event").whereIn("pick_session_id", sessions).delete();
        await trx("pick_line").whereIn("pick_session_id", sessions).delete();
        await trx("pick_session").whereIn("id", sessions).delete();
        await trx("merchant_member").whereIn("id", [picker.id, manager.id, managerPeer.id]).update({ status: "ACTIVE" });
      });
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "M12 picking verification failed.");
  });
  console.log("M12 passed: admission, hostile IDs, assignment/revision races, audit rollback, native-line drift, quantities and unchanged native commerce.");
}
