import assert from "node:assert/strict";
import type { ExecArgs, IInventoryService, IOrderModuleService, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules, MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import verifyOrderOperations from "./verify-order-operations";
import { cleanupShortages } from "./shortage-verification-cleanup";
import { PickingService } from "../lib/picking-service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";

const preference = z.object({ preference: z.enum(["CONTACT_ME", "NO_SUBSTITUTION"]), revision: z.number(),
  chosen_at: z.string().nullable(), frozen_at: z.string().nullable() }).strict();
const shortage = z.object({ id: z.string(), line_id: z.string(), revision: z.number(),
  status: z.enum(["CUSTOMER_DECISION_REQUIRED", "RESOLVED_OMITTED"]), ordered_quantity: z.number(),
  picked_quantity: z.number(), omitted_quantity: z.number(), unresolved_quantity: z.number(), financial_review_required: z.boolean(),
  preference: z.enum(["CONTACT_ME", "NO_SUBSTITUTION"]), resolved_at: z.string().nullable() }).strict();
// Strict DTO allowlists also catch accidental exposure of payment/workflow/inventory evidence.
const shortages = z.object({ preference, shortages: z.array(shortage) }).strict();
const picking = z.object({ revision: z.number(), status: z.string(), assigned_member_id: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), ordered_quantity: z.number(), picked_quantity: z.number(),
    shortage_recorded: z.boolean(), omitted_quantity: z.number(), unresolved_quantity: z.number() })) });

export default async function verifyShortages(args: ExecArgs) {
  await verifyOrderOperations(args, async (f) => {
    const { http, expect, ownerA, ownerB, picker, managerPeer, a, b } = f;
    const { container, first, second } = f.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const decisions = new OrderOperationsService(container), service = new PickingService(container);
    const native = container.resolve<IOrderModuleService>(Modules.ORDER);
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
    const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const ids = new Set([a.orderId, b.orderId]);
    const merchantPath = (id: string) => "/merchant/picking/" + id;
    const customerPath = (id: string) => "/store/gospaza/orders/" + id;
    const choose = (cookie: string, id: string, value: "CONTACT_ME" | "NO_SUBSTITUTION", revision: number) =>
      http(cookie, "PUT", customerPath(id) + "/substitution-preference", { preference: value, expected_revision: revision });
    const read = async (cookie: string, id: string) => shortages.parse(expect(await http(cookie, "GET", customerPath(id) + "/shortages")));
    const picked = async (id: string) => z.object({ picking }).parse(expect(await http(ownerA.cookie, "GET", merchantPath(id)))).picking;
    const claim = async (id: string) => z.object({ picking }).parse(expect(await http(picker.cookie, "POST", merchantPath(id) + "/claim", {}))).picking;
    const lineUpdate = (id: string, line: string, revision: number, quantity: number, short = true, cookie = picker.cookie) =>
      http(cookie, "PUT", merchantPath(id) + "/lines/" + line, { expected_revision: revision, picked_quantity: quantity, shortage_recorded: short });
    const admit = (cookie: string, id: string, line: string, revision: number) =>
      http(cookie, "POST", merchantPath(id) + "/lines/" + line + "/shortage", { expected_revision: revision });
    const omit = (cookie: string, id: string, item: { id: string; revision: number }) =>
      http(cookie, "POST", customerPath(id) + "/shortages/" + item.id + "/omit", { expected_revision: item.revision, confirmed: true });
    const finish = (id: string, revision: number) => http(picker.cookie, "POST", merchantPath(id) + "/complete", { expected_revision: revision, confirmed: true });
    async function accepted(suffix: string) {
      const order = await f.complete("m13-" + suffix, first.variantId, 5); ids.add(order.orderId);
      await decisions.ensure(order.orderId);
      await decisions.decide(ownerA.identity, order.orderId, "accept", { expected_revision: 0, confirmed: true });
      const state = await claim(order.orderId); const line = state.lines[0]; assert.ok(line);
      assert.equal(line.ordered_quantity, 5);
      return { ...order, state, line };
    }
    async function nativeEvidence(id: string) {
      const handoff = await readOrderHandoff(db, id); assert.ok(handoff);
      const receipt = z.object({ payment_id: z.string() }).parse(handoff.terminal_receipt);
      const order = await native.retrieveOrder(id, { relations: ["items", "shipping_methods"] });
      const reservations = await inventory.listReservationItems({ line_item_id: (order.items ?? []).map((item) => item.id) }, { take: null });
      const levels = reservations.length ? await inventory.listInventoryLevels({ inventory_item_id: reservations.map((item) => item.inventory_item_id) }, { take: null }) : [];
      const payment = await payments.retrievePayment(receipt.payment_id, { relations: ["captures", "refunds"] });
      const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
      const fulfillment = await query.graph({ entity: "order_fulfillment", fields: ["order_id", "fulfillment_id"], filters: { order_id: id } });
      return JSON.stringify({ order, reservations: reservations.sort((x,y) => x.id.localeCompare(y.id)),
        levels: levels.sort((x,y) => x.id.localeCompare(y.id)), payment, fulfillment: fulfillment.data });
    }
    const failures: unknown[] = [];
    try {
      // Increase only this invocation's native fixture stock before the shortage
      // scenarios. This is test setup, outside every native-immutability baseline.
      const fixtureOrder = await native.retrieveOrder(a.orderId, { relations: ["items"] });
      const fixtureReservations = await inventory.listReservationItems({ line_item_id: (fixtureOrder.items ?? []).map((item) => item.id) }, { take: null });
      assert.ok(fixtureReservations.length);
      for (const reservation of fixtureReservations) await inventory.updateInventoryLevels({
        inventory_item_id: reservation.inventory_item_id, location_id: reservation.location_id, stocked_quantity: 100,
      });
      // Preference is customer-owned even before merchant acceptance.
      assert.deepEqual((await read(a.person.cookie, a.orderId)).preference,
        { preference: "CONTACT_ME", revision: 0, chosen_at: null, frozen_at: null });
      const explicit = z.object({ preference }).parse(expect(await choose(a.person.cookie, a.orderId, "CONTACT_ME", 0))).preference;
      assert.ok(explicit.chosen_at); assert.equal(explicit.frozen_at, null);
      const noSub = z.object({ preference }).parse(expect(await choose(a.person.cookie, a.orderId, "NO_SUBSTITUTION", explicit.revision))).preference;
      const replay = expect(await choose(a.person.cookie, a.orderId, "NO_SUBSTITUTION", explicit.revision));
      assert.deepEqual(replay, { preference: noSub });
      expect(await choose(a.person.cookie, a.orderId, "CONTACT_ME", explicit.revision), 409);
      assert.deepEqual((await read(a.person.cookie, a.orderId)).preference, noSub);
      expect(await choose(a.person.cookie, a.orderId, "CONTACT_ME", noSub.revision));
      expect(await admit(picker.cookie, a.orderId, "ordli_unknown", 1), 409);
      await decisions.decide(ownerB.identity, b.orderId, "reject", { expected_revision: 0, confirmed: true });
      expect(await admit(ownerB.cookie, b.orderId, "ordli_unknown", 1), 409);
      const foreign = await http(b.person.cookie, "GET", customerPath(a.orderId) + "/shortages");
      const missing = await http(b.person.cookie, "GET", customerPath("order_missing") + "/shortages");
      expect(foreign, 404); expect(missing, 404); assert.deepEqual(foreign.body, missing.body);
      for (const cookie of ["", picker.cookie, f.platform.cookie]) expect(await choose(cookie, a.orderId, "CONTACT_ME", 0), 401);
      for (const key of ["customer_id", "merchant_id", "store_id", "status", "omitted_quantity", "refund_amount"]) {
        expect(await http(a.person.cookie, "PUT", customerPath(a.orderId) + "/substitution-preference",
          { preference: "CONTACT_ME", expected_revision: 0, [key]: "forged" }), 400);
      }

      const partial = await accepted("partial");
      const original = await nativeEvidence(partial.orderId);
      expect(await admit(picker.cookie, partial.orderId, partial.line.id, partial.state.revision), 409);
      // The first shortage, frozen preference, physical edit and audit are one transaction.
      const freezeFault = new Error("M13 fixture shortage creation audit failure");
      const partialOperation = await db<{ id: string }>("order_operation").where({ medusa_order_id: partial.orderId }).first();
      assert.ok(partialOperation);
      let freezeIntercepted = false;
      const onFreezeAudit = (query: { sql: string; bindings?: readonly unknown[] }) => {
        if (query.sql.startsWith('insert into "shortage_event"') && query.bindings?.includes("SHORTAGE_CREATED")
          && query.bindings.includes(partialOperation.id)) { freezeIntercepted = true; throw freezeFault; }
      };
      db.on("query", onFreezeAudit);
      try {
        await assert.rejects(() => service.mutate(picker.identity, partial.orderId, "LINE",
          { expected_revision: 1, picked_quantity: 2, shortage_recorded: true }, partial.line.id),
          (error: unknown) => error === freezeFault);
      } finally { db.off("query", onFreezeAudit); }
      assert.equal(freezeIntercepted, true);
      assert.deepEqual(await picked(partial.orderId), partial.state);
      assert.equal((await db("order_shortage_preference").where({ order_operation_id: partialOperation.id })).length, 0);
      assert.equal((await db("shortage_resolution").where({ order_operation_id: partialOperation.id })).length, 0);
      assert.equal((await db("shortage_event").where({ order_operation_id: partialOperation.id })).length, 0);
      expect(await lineUpdate(partial.orderId, partial.line.id, 1, 2));
      let view = await read(partial.person.cookie, partial.orderId);
      assert.equal(view.preference.preference, "CONTACT_ME"); assert.ok(view.preference.frozen_at);
      assert.equal(view.preference.chosen_at, null);
      const stale = view.shortages[0]; assert.ok(stale);
      assert.equal(stale.status, "CUSTOMER_DECISION_REQUIRED"); assert.equal(stale.unresolved_quantity, 3);
      // CONTACT_ME cannot be bypassed by omitting the confirmation or forging provenance.
      for (const body of [{ expected_revision: stale.revision }, { expected_revision: stale.revision, confirmed: false }]) {
        expect(await http(partial.person.cookie, "POST", customerPath(partial.orderId) + "/shortages/" + stale.id + "/omit", body), 400);
      }
      for (const cookie of ["", picker.cookie, f.platform.cookie]) expect(await omit(cookie, partial.orderId, stale), 401);
      for (const key of ["preference", "preference_id", "decision_customer_id", "pick_session_id", "pick_line_id", "order_operation_id", "resolved_at", "currency_code", "payment_state"]) {
        expect(await http(partial.person.cookie, "POST", customerPath(partial.orderId) + "/shortages/" + stale.id + "/omit",
          { expected_revision: stale.revision, confirmed: true, [key]: "forged" }), 400);
      }
      const storedCase = await db<{ pick_session_id: string; pick_line_id: string }>("shortage_resolution").where({ id: stale.id }).first();
      assert.ok(storedCase);
      for (const internalId of [partialOperation.id, storedCase.pick_session_id, storedCase.pick_line_id]) {
        expect(await http(partial.person.cookie, "GET", customerPath(internalId) + "/shortages"), 404);
        expect(await http(ownerA.cookie, "GET", merchantPath(internalId) + "/shortages"), 404);
        expect(await omit(partial.person.cookie, partial.orderId, { id: internalId, revision: 1 }), 404);
      }
      const foreignMerchant = await http(ownerB.cookie, "GET", merchantPath(partial.orderId) + "/shortages");
      const unknownMerchant = await http(ownerB.cookie, "GET", merchantPath("order_missing") + "/shortages");
      expect(foreignMerchant, 404); expect(unknownMerchant, 404); assert.deepEqual(foreignMerchant.body, unknownMerchant.body);
      expect(await finish(partial.orderId, 2), 409);
      assert.deepEqual(await read(partial.person.cookie, partial.orderId), view, "reads do not expire or consent to shortages");
      expect(await choose(partial.person.cookie, partial.orderId, "NO_SUBSTITUTION", view.preference.revision), 409);
      expect(await admit(ownerB.cookie, partial.orderId, partial.line.id, 2), 404);
      expect(await http(ownerB.cookie, "GET", merchantPath(partial.orderId) + "/shortages"), 404);
      const foreignOrder = await native.retrieveOrder(b.orderId, { relations: ["items"] });
      const foreignLine = foreignOrder.items?.[0]; assert.ok(foreignLine);
      expect(await admit(picker.cookie, partial.orderId, foreignLine.id, 2), 404);
      expect(await admit(ownerA.cookie, partial.orderId, partial.line.id, 2), 403);
      expect(await omit(b.person.cookie, partial.orderId, stale), 404);
      expect(await omit(partial.person.cookie, partial.orderId, { id: "shr_foreign", revision: 1 }), 404);
      for (const key of ["picked_quantity", "omitted_quantity", "customer_id", "merchant_id", "store_id", "financial_review_required", "refund_amount"]) {
        expect(await http(partial.person.cookie, "POST", customerPath(partial.orderId) + "/shortages/" + stale.id + "/omit",
          { expected_revision: 1, confirmed: true, [key]: 3 }), 400);
      }
      const admitted = await Promise.all([admit(picker.cookie, partial.orderId, partial.line.id, 2), admit(picker.cookie, partial.orderId, partial.line.id, 2)]);
      admitted.forEach((response) => expect(response)); assert.deepEqual(admitted[0]?.body, admitted[1]?.body);
      assert.equal((await db("shortage_resolution").where({ id: stale.id })).length, 1);
      await assert.rejects(() => db("order_shortage_preference").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: partial.orderId })).update({ preference: "NO_SUBSTITUTION" }));
      expect(await lineUpdate(partial.orderId, partial.line.id, 2, 3));
      expect(await omit(partial.person.cookie, partial.orderId, stale), 409);
      view = await read(partial.person.cookie, partial.orderId);
      const current = view.shortages[0]; assert.ok(current); assert.notEqual(current.id, stale.id);
      assert.equal(current.unresolved_quantity, 2);
      await assert.rejects(() => db.raw(
        'insert into shortage_resolution (id,order_operation_id,pick_session_id,pick_line_id,preference_id,status,revision,evidence,financial_review_required) '
        + 'select ?,order_operation_id,pick_session_id,pick_line_id,preference_id,status,revision,evidence,financial_review_required from shortage_resolution where id=?',
        [current.id + '_duplicate', current.id]),
        (error: unknown) => z.object({ code: z.literal("23505") }).safeParse(error).success);
      // Audit failure rolls back consent rather than leaving an unaudited omission.
      const failure = new Error("M13 fixture audit failure");
      let intercepted = false;
      const onAudit = (query: { sql: string; bindings?: readonly unknown[] }) => {
        if (query.sql.startsWith('insert into "shortage_event"') && query.bindings?.includes("CUSTOMER_OMITTED")
          && query.bindings.includes(current.id)) { intercepted = true; throw failure; }
      };
      db.on("query", onAudit);
      try {
        await assert.rejects(() => service.customerShortages(partial.person.id, partial.orderId, "OMIT",
          { expected_revision: current.revision, confirmed: true }, current.id), (error: unknown) => error === failure);
      } finally { db.off("query", onAudit); }
      assert.equal(intercepted, true);
      assert.deepEqual((await read(partial.person.cookie, partial.orderId)).shortages[0], current);

      const duplicates = await Promise.all([omit(partial.person.cookie, partial.orderId, current), omit(partial.person.cookie, partial.orderId, current)]);
      duplicates.forEach((response) => expect(response)); assert.deepEqual(duplicates[0]?.body, duplicates[1]?.body);
      const terminal = (await read(partial.person.cookie, partial.orderId)).shortages[0]; assert.ok(terminal);
      assert.equal(terminal.omitted_quantity, 2); assert.equal(terminal.picked_quantity, 3); assert.equal(terminal.financial_review_required, true);
      const truth = (await picked(partial.orderId)).lines[0]; assert.ok(truth);
      assert.equal(truth.picked_quantity, 3); assert.equal(truth.shortage_recorded, true); assert.equal(truth.unresolved_quantity, 0);
      expect(await lineUpdate(partial.orderId, partial.line.id, 3, 4), 409);
      // Failed completion audit cannot turn a resolved but in-progress pick into completion.
      const completionFault = new Error("M13 fixture completion audit failure");
      let completionIntercepted = false;
      const onCompleteAudit = (query: { sql: string; bindings?: readonly unknown[] }) => {
        if (query.sql.startsWith('insert into "pick_event"') && query.bindings?.includes("COMPLETE")
          && query.bindings.includes(storedCase.pick_session_id)) { completionIntercepted = true; throw completionFault; }
      };
      db.on("query", onCompleteAudit);
      try {
        await assert.rejects(() => service.mutate(picker.identity, partial.orderId, "COMPLETE",
          { expected_revision: 3, confirmed: true }), (error: unknown) => error === completionFault);
      } finally { db.off("query", onCompleteAudit); }
      assert.equal(completionIntercepted, true);
      assert.equal((await picked(partial.orderId)).status, "IN_PROGRESS");
      assert.deepEqual((await read(partial.person.cookie, partial.orderId)).shortages[0], terminal);
      expect(await finish(partial.orderId, 3));
      expect(await lineUpdate(partial.orderId, partial.line.id, 4, 4), 409);
      expect(await admit(picker.cookie, partial.orderId, partial.line.id, 4), 409);
      expect(await omit(partial.person.cookie, partial.orderId, current));
      assert.equal(await nativeEvidence(partial.orderId), original, "omission/completion cannot mutate native commerce");
      const events = await db<{ actor_type: string; actor_id: string; action: string }>("shortage_event").where({ shortage_resolution_id: current.id });
      const consent = events.filter((event) => event.action === "CUSTOMER_OMITTED");
      assert.equal(consent.length, 1); assert.equal(consent[0]?.actor_id, partial.person.id); assert.equal(consent[0]?.actor_type, "customer");
      await assert.rejects(() => db("shortage_resolution").where({ id: current.id }).update({ status: "CUSTOMER_DECISION_REQUIRED" }));
      await assert.rejects(() => db("shortage_event").where({ shortage_resolution_id: current.id }).update({ actor_id: b.person.id }));
      const stored = await db<{ evidence: Record<string, unknown>; financial_review_required: boolean }>("shortage_resolution").where({ id: current.id }).first(); assert.ok(stored);
      assert.equal(stored.evidence.native_order_id, partial.orderId); assert.equal(stored.evidence.native_line_id, partial.line.id);
      assert.ok(stored.evidence.checkout_completion_id); assert.equal(stored.financial_review_required, true);
      assert.equal("refund_amount" in stored.evidence, false);
      assert.equal(stored.evidence.ordered, 5); assert.equal(stored.evidence.picked, 3); assert.equal(stored.evidence.missing, 2);
      assert.equal(stored.evidence.preference, "CONTACT_ME"); assert.ok(stored.evidence.source_lines_fingerprint);
      const completionEvent = await db("pick_event").where({ pick_session_id: storedCase.pick_session_id, action: "COMPLETE" });
      assert.equal(completionEvent.length, 1, "M18 evidence retains the operational completion reference");
      await assert.rejects(() => db("shortage_resolution").where({ id: current.id }).update({ financial_review_required: false }));
      // Supported native API simulates external identity drift in this fixture only.
      // Even a replay receipt must revalidate native ownership and M10 binding.
      await native.updateOrders(partial.orderId, { customer_id: b.person.id });
      try {
        for (const cookie of [partial.person.cookie, b.person.cookie]) {
          expect(await http(cookie, "GET", customerPath(partial.orderId) + "/shortages"), 404);
          expect(await omit(cookie, partial.orderId, current), 404);
        }
      } finally { await native.updateOrders(partial.orderId, { customer_id: partial.person.id }); }
      expect(await omit(partial.person.cookie, partial.orderId, current));

      const automatic = await accepted("prior-consent");
      const automaticNative = await nativeEvidence(automatic.orderId);
      expect(await omit(automatic.person.cookie, automatic.orderId, current), 404);
      expect(await choose(automatic.person.cookie, automatic.orderId, "NO_SUBSTITUTION", 0));
      expect(await lineUpdate(automatic.orderId, automatic.line.id, 1, 3));
      const auto = await read(automatic.person.cookie, automatic.orderId);
      assert.equal(auto.shortages[0]?.status, "RESOLVED_OMITTED"); assert.equal(auto.shortages[0]?.omitted_quantity, 2);
      expect(await choose(automatic.person.cookie, automatic.orderId, "NO_SUBSTITUTION", 0));
      expect(await choose(automatic.person.cookie, automatic.orderId, "CONTACT_ME", auto.preference.revision), 409);
      expect(await finish(automatic.orderId, 2));
      assert.equal(await nativeEvidence(automatic.orderId), automaticNative, "prior-consent omission cannot mutate native commerce");

      const found = await accepted("original-found");
      expect(await lineUpdate(found.orderId, found.line.id, 1, 2));
      const pending = (await read(found.person.cookie, found.orderId)).shortages[0]; assert.ok(pending);
      expect(await lineUpdate(found.orderId, found.line.id, 2, 5, false));
      expect(await omit(found.person.cookie, found.orderId, pending), 409);
      assert.equal((await read(found.person.cookie, found.orderId)).shortages.length, 0);
      expect(await admit(picker.cookie, found.orderId, found.line.id, 3), 409);
      expect(await finish(found.orderId, 3));
      expect(await choose(found.person.cookie, found.orderId, "NO_SUBSTITUTION", (await read(found.person.cookie, found.orderId)).preference.revision), 409);

      const racing = await accepted("found-race");
      expect(await lineUpdate(racing.orderId, racing.line.id, 1, 2));
      const raceCase = (await read(racing.person.cookie, racing.orderId)).shortages[0]; assert.ok(raceCase);
      const race = await Promise.all([lineUpdate(racing.orderId, racing.line.id, 2, 5, false), omit(racing.person.cookie, racing.orderId, raceCase)]);
      assert.deepEqual(race.map((r) => r.status).sort(), [200,409], JSON.stringify(race));
      const raceLine = (await picked(racing.orderId)).lines[0]; assert.ok(raceLine);
      assert.equal(raceLine.picked_quantity + raceLine.omitted_quantity, 5);

      const freezing = await accepted("freeze-race");
      const freeze = await Promise.all([choose(freezing.person.cookie, freezing.orderId, "NO_SUBSTITUTION", 0), lineUpdate(freezing.orderId, freezing.line.id, 1, 2)]);
      assert.ok(freeze[0] && freeze[1]); expect(freeze[1]);
      assert.ok([200,409].includes(freeze[0].status));
      const frozen = await read(freezing.person.cookie, freezing.orderId);
      assert.ok(frozen.preference.frozen_at);
      assert.equal(frozen.shortages[0]?.status, freeze[0].status === 200 ? "RESOLVED_OMITTED" : "CUSTOMER_DECISION_REQUIRED");

      const finishing = await accepted("completion-race");
      expect(await lineUpdate(finishing.orderId, finishing.line.id, 1, 3));
      const finishingCase = (await read(finishing.person.cookie, finishing.orderId)).shortages[0]; assert.ok(finishingCase);
      const finishRace = await Promise.all([finish(finishing.orderId, 2), omit(finishing.person.cookie, finishing.orderId, finishingCase)]);
      assert.ok(finishRace[0] && finishRace[1]); expect(finishRace[1]); assert.ok([200,409].includes(finishRace[0].status));
      const finishState = await picked(finishing.orderId);
      assert.equal(finishState.lines[0]?.unresolved_quantity, 0);
      if (finishState.status !== "COMPLETED") expect(await finish(finishing.orderId, finishState.revision));

      const handover = await accepted("handover");
      expect(await lineUpdate(handover.orderId, handover.line.id, 1, 2));
      const handoverCase = (await read(handover.person.cookie, handover.orderId)).shortages[0]; assert.ok(handoverCase);
      const handoverRace = await Promise.all([
        http(ownerA.cookie, "POST", merchantPath(handover.orderId) + "/reassign", { expected_revision: 2, target_member_id: managerPeer.id }),
        lineUpdate(handover.orderId, handover.line.id, 2, 3),
      ]);
      assert.equal(handoverRace.filter((r) => r.status === 200).length, 1, JSON.stringify(handoverRace));
      assert.ok(handoverRace.some((r) => r.status === 403 || r.status === 409));
      let handoverState = await picked(handover.orderId);
      if (handoverState.assigned_member_id === picker.id) {
        expect(await http(ownerA.cookie, "POST", merchantPath(handover.orderId) + "/reassign", { expected_revision: handoverState.revision, target_member_id: managerPeer.id }));
        handoverState = await picked(handover.orderId);
      } else assert.equal((await read(handover.person.cookie, handover.orderId)).shortages[0]?.id, handoverCase.id);
      expect(await admit(picker.cookie, handover.orderId, handover.line.id, handoverState.revision), 403);
      const stable = await read(handover.person.cookie, handover.orderId);
      expect(await admit(managerPeer.cookie, handover.orderId, handover.line.id, handoverState.revision));
      assert.deepEqual(await read(handover.person.cookie, handover.orderId), stable);

      // Membership is revalidated after acquiring the shared merchant row lock.
      let blockedMutation: Promise<unknown> | undefined;
      await db.transaction(async (trx) => {
        await trx("merchant").where({ id: first.merchantId }).forUpdate().first();
        let observe: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => { observe = resolve; });
        const onQuery = (query: { sql: string; bindings?: readonly unknown[] }) => {
          if (query.sql.includes('from "merchant"') && query.sql.includes("for update") && query.bindings?.includes(first.merchantId)) observe?.();
        };
        db.on("query", onQuery);
        try {
          blockedMutation = service.admitShortage(managerPeer.identity, handover.orderId, handover.line.id,
            { expected_revision: handoverState.revision }).then(() => null, (error: unknown) => error);
          await Promise.race([blocked, blockedMutation.then(() => { throw new Error("Shortage mutation did not wait on merchant lock"); })]);
          await trx("merchant_member").where({ id: managerPeer.id }).update({ status: "INACTIVE" });
        } finally { db.off("query", onQuery); }
      });
      const denied = await blockedMutation;
      assert.ok(denied instanceof MedusaError); assert.equal(denied.type, MedusaError.Types.UNAUTHORIZED);
      await db("merchant_member").where({ id: managerPeer.id }).update({ status: "ACTIVE" });
    } catch (error) { failures.push(error); }
    try {
      await db.transaction(async (trx) => {
        await trx("merchant").whereIn("id", [first.merchantId, second.merchantId]).orderBy("id").forUpdate();
        await cleanupShortages(trx, [...ids]);
        const sessions = trx("pick_session").select("id").whereIn("order_operation_id", trx("order_operation").select("id").whereIn("medusa_order_id", [...ids]));
        await trx("pick_event").whereIn("pick_session_id", sessions).delete();
        await trx("pick_line").whereIn("pick_session_id", sessions).delete();
        await trx("pick_session").whereIn("id", sessions).delete();
        await trx("merchant_member").where({ id: managerPeer.id }).update({ status: "ACTIVE" });
      });
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "M13-B shortage verification failed.");
  });
  console.log("M13-B passed: owned preference, frozen consent, current-generation omission, quantity/decision races, truthful picking and unchanged native commerce.");
}
