import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { readOrderHandoff } from "./order-operation-repository";
import type { CompletedOrderHandoff } from "./order-operation-policy";
import { PickingService } from "../../lib/picking-service";
import { productionDefinition } from "../../lib/notification-catalogue";
import { digest, id, NotificationConflict, type CreateInput, type Link } from "../../lib/notification-policy";

export type Discovery = "ORDER" | "DELIVERY" | "REFUND" | "CREDIT" | "SETTLEMENT" | "DRIVER_PAYMENT" | "MARKETPLACE_EXCEPTION" | "DRIVER_EXCEPTION";
export type PlatformAudience = "CUSTOMER_FINANCE" | "SETTLEMENT" | "DRIVER_PAYMENT" | "MARKETPLACE_RECOGNITION" | "DRIVER_RECOGNITION" | "DELIVERY_OPERATIONS";
export interface NotificationOrder { id: string; customerId: string; registered: boolean; contact: string | null; reference: string;
  lines: { id: string; quantity: number }[] }
export interface NotificationOrderReader { order(handoff: CompletedOrderHandoff): Promise<NotificationOrder> }
type GuardTable = "order_operation" | "delivery_operation" | "dispatch_commitment" | "restricted_return" | "shortage_resolution"
  | "payable_settlement" | "merchant_period_statement" | "refund_operation" | "store_credit_operation" | "driver_payment" | "pick_session" | "pickup_operation" | "delivery_completion";
interface Guard { table: GuardTable; id: string; match: Record<string, string | number>; soft?: boolean; future?: string }
export interface NotificationFact {
  source: CreateInput["source"]; template: string; kind: string; audience: "customer" | "merchant" | "driver" | "user";
  input: CreateInput["input"]; order?: NotificationOrder; merchantId?: string; storeId?: string; driverId?: string;
  assignedMember?: string; merchantPolicy?: "MANAGEMENT" | "PICKING" | "RETURN" | "DISPOSITION" | "FINANCE";
  platform?: PlatformAudience; platformAction?: "REFUND" | "CREDIT" | "PREPARE" | "PAYMENT";
  link: Link | null; guards: Guard[]; operationalDriver?: boolean;
}
function present(value: unknown): asserts value { if (!value) throw new NotificationConflict(); }
const iso = (value: unknown) => { const date = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(date.getTime())) throw new NotificationConflict(); return date.toISOString(); };
const route = (name: Link["route"], resource: string): Link => ({ route: name, resource: id.parse(resource) });

// All SQL sources below are Marketplace-owned operational/finance receipts.
// Native commerce is read through the owning Order adapter, never native SQL.
// These are point lookups, not repair scans or independent business transitions.
export class NotificationSources {
  constructor(private readonly container: MedusaContainer, readonly db: Knex, private readonly native: NotificationOrderReader) {}
  private fact(template: string, type: string, sourceId: string, transition: string, at: unknown, evidence: unknown,
    data: Omit<NotificationFact, "template" | "source" | "kind" | "audience" | "input" | "guards"> & {
      reference?: string; amount?: unknown; guards?: Guard[] }): NotificationFact {
    const definition = productionDefinition(template); present(definition);
    const { reference, amount, guards, ...scope } = data;
    const input: CreateInput["input"] = { reference: reference ?? "review" };
    if (definition.money) {
      const value = String(amount); if (!/^\d{1,16}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new NotificationConflict();
      input.amount_minor = value; input.currency = "zar";
    }
    return { template, kind: definition.kind, audience: definition.audience, source: { type: id.parse(type), id: id.parse(sourceId),
      transition: id.parse(transition), committed_at: iso(at), evidence: digest(evidence) }, input, guards: guards ?? [], ...scope };
  }
  private async context(orderId: string) {
    const handoff = await readOrderHandoff(this.db, id.parse(orderId));
    if (!handoff) return null; // native order.placed may precede the terminal handoff
    const order = await this.native.order(handoff);
    if (order.id !== orderId || order.customerId !== handoff.snapshot.customer_id) throw new NotificationConflict();
    const operation = await this.db("order_operation").where({ medusa_order_id: orderId, checkout_completion_id: handoff.completion_id,
      merchant_id: handoff.merchant_id, merchant_store_id: handoff.merchant_store_id }).whereNull("deleted_at").first();
    return { handoff, order, operation };
  }
  async discover(topic: Discovery, sourceId: string, template?: string): Promise<NotificationFact[]> {
    id.parse(sourceId);
    switch (topic) {
      case "ORDER": return this.order(sourceId, template === "customer.order_confirmed");
      case "DELIVERY": return this.delivery(sourceId);
      case "REFUND": return this.compensation(sourceId, false);
      case "CREDIT": return this.compensation(sourceId, true);
      case "SETTLEMENT": return this.settlement(sourceId);
      case "DRIVER_PAYMENT": return this.driverPayment(sourceId);
      case "MARKETPLACE_EXCEPTION": return this.recognition(sourceId, false);
      case "DRIVER_EXCEPTION": return this.recognition(sourceId, true);
    }
  }
  private async order(orderId: string, confirmationOnly = false) {
    const context = await this.context(orderId); if (!context) return [];
    const { order, handoff, operation: op } = context, result: NotificationFact[] = [];
    const receipt = handoff.terminal_receipt as { verified_at: string };
    const scope = { order, merchantId: handoff.merchant_id, storeId: handoff.merchant_store_id, reference: order.reference };
    result.push(this.fact("customer.order_confirmed", "checkout_completion", handoff.completion_id, "COMPLETED", receipt.verified_at,
      { completion: handoff.completion_id, order: order.id, customer: order.customerId, store: handoff.merchant_store_id }, { ...scope, link: route("CUSTOMER_ORDER", order.id) }));
    if (!op || confirmationOnly) return result;
    if (op.status === "PENDING_ACCEPTANCE") result.push(this.fact("merchant.new_order", "checkout_completion", handoff.completion_id, "COMPLETED", receipt.verified_at,
      { operation: op.id, completion: handoff.completion_id }, { ...scope, merchantPolicy: "MANAGEMENT", link: route("MERCHANT_ORDER", order.id),
        guards: [{ table: "order_operation", id: op.id, match: { status: "PENDING_ACCEPTANCE" }, soft: true }] }));
    const decision = await this.db("order_decision_event").where({ order_operation_id: op.id, to_status: "REJECTED" }).whereNull("deleted_at").first();
    if (op.status === "REJECTED" && decision && iso(decision.decided_at) === iso(op.rejected_at)) {
      for (const template of ["customer.order_rejected", "merchant.order_closed"]) result.push(this.fact(template, "order_decision_event", decision.id,
        "REJECTED", decision.decided_at, { operation: op.id, order: order.id, store: op.merchant_store_id },
        { ...scope, merchantPolicy: "MANAGEMENT", link: route(template.startsWith("customer") ? "CUSTOMER_ORDER" : "MERCHANT_ORDER", order.id) }));
    }
    const session = await this.db("pick_session").where({ order_operation_id: op.id }).whereNull("deleted_at").first();
    if (session?.status === "COMPLETED") {
      // Existing owner checks accounting, all original lines and terminal omissions.
      const physical = await this.db.transaction(trx => new PickingService(this.container).completedForRecognition(trx, op.id));
      if (physical.physical.length !== order.lines.length || physical.physical.some(line => !order.lines.some(native => native.id === line.id && native.quantity === line.ordered)))
        throw new NotificationConflict();
      const event = await this.db("pick_event").where({ pick_session_id: session.id, revision: session.revision, action: "COMPLETE" }).whereNull("deleted_at").first();
      if (physical.physical.length && physical.physical.every(line => line.picked === 0)) {
        present(event);
        result.push(this.fact("customer.order_unfulfillable", "pick_event", event.id, "COMPLETE", event.occurred_at,
          { session: session.id, revision: session.revision, completion: handoff.completion_id }, { ...scope, link: route("CUSTOMER_ORDER", order.id) }));
      }
    } else if (session?.status === "IN_PROGRESS") {
      const shortages = await this.db("shortage_resolution").where({ pick_session_id: session.id, status: "CUSTOMER_DECISION_REQUIRED" }).whereNull("invalidated_at").whereNull("deleted_at");
      const assignment = await this.db("pick_event").where({ pick_session_id: session.id }).whereIn("action", ["CLAIM", "REASSIGN"]).whereNull("deleted_at").orderBy("revision", "desc").first();
      if (shortages.length) present(assignment);
      for (const shortage of shortages) result.push(this.fact("merchant.fulfilment_attention", "shortage_resolution", shortage.id, "OPEN_" + assignment.id,
        new Date(shortage.created_at) > new Date(assignment.occurred_at) ? shortage.created_at : assignment.occurred_at,
        { case: shortage.id, session: session.id, line: shortage.pick_line_id, assignment: assignment.id }, { ...scope, merchantPolicy: "PICKING", assignedMember: session.assigned_member_id,
          link: route("MERCHANT_PICKING", order.id), guards: [{ table: "pick_session", id: session.id, match: { status: "IN_PROGRESS", assigned_member_id: session.assigned_member_id }, soft: true },
            { table: "shortage_resolution", id: shortage.id, match: { status: "CUSTOMER_DECISION_REQUIRED" }, soft: true }] }));
    }
    return result;
  }
  private async delivery(deliveryId: string) {
    const d = await this.db("delivery_operation").where({ id: deliveryId }).whereNull("deleted_at").first(); if (!d) return [];
    const context = await this.context(d.medusa_order_id); if (!context?.operation) return [];
    const { order, operation: op, handoff } = context;
    if (op.id !== d.order_operation_id || d.merchant_id !== handoff.merchant_id || d.merchant_store_id !== handoff.merchant_store_id) throw new NotificationConflict();
    const scope = { order, merchantId: d.merchant_id as string, storeId: d.merchant_store_id as string, reference: order.reference };
    const result: NotificationFact[] = [], session = await this.db("pick_session").where({ id: d.pick_session_id }).whereNull("deleted_at").first();
    const commits = await this.db("dispatch_commitment").where({ delivery_id: d.id }).whereNull("deleted_at").orderBy("generation", "desc").limit(100);
    const matching = commits.filter(row => ["OFFERED", "ASSIGNED", "COMPLETED", "RETURNED"].includes(row.status) && Number(row.generation) === Number(d.generation));
    if (matching.length > 1) throw new NotificationConflict();
    const c = matching[0];
    const returned = await this.db("restricted_return").where({ delivery_id: d.id, merchant_store_id: d.merchant_store_id }).whereNull("deleted_at").first();
    const events = await this.db("dispatch_event").where({ target_type: "DELIVERY", target_id: d.id }).whereNull("deleted_at");
    const eventFor = (action: string) => events.find(event => event.action === action && Number(event.revision) <= Number(d.revision)
      && event.evidence?.commitment_id === c?.id);
    const live = [{ table: "delivery_operation" as const, id: d.id, match: { status: d.status as string, generation: Number(d.generation) }, soft: true }];
    if (c?.status === "OFFERED" && d.status === "OFFERED") {
      const event = eventFor("OFFER_CREATED"); present(event);
      result.push(this.fact("driver.dispatch_offer", "dispatch_commitment", c.id, "OFFERED", event.occurred_at,
        { commitment: c.id, driver: c.driver_profile_id, delivery: d.id, generation: c.generation },
        { ...scope, driverId: c.driver_profile_id, operationalDriver: true, link: route("DRIVER_CURRENT", d.id), guards: [...live,
          { table: "dispatch_commitment", id: c.id, match: { status: "OFFERED", generation: Number(d.generation), driver_profile_id: c.driver_profile_id }, soft: true, future: "expires_at" }] }));
    }
    if (c?.status === "ASSIGNED" && d.status === "ASSIGNED" && !returned) {
      const event = eventFor("ASSIGNED"); present(event);
      for (const template of ["customer.driver_assigned", "merchant.driver_assigned", "driver.assignment_confirmed"]) result.push(this.fact(template,
        "dispatch_commitment", c.id, "ASSIGNED", event.occurred_at, { delivery: d.id, driver: c.driver_profile_id, generation: c.generation },
        { ...scope, driverId: c.driver_profile_id, merchantPolicy: "PICKING", assignedMember: session?.assigned_member_id,
          link: route(template.startsWith("customer") ? "CUSTOMER_ORDER" : template.startsWith("merchant") ? "MERCHANT_ORDER" : "DRIVER_CURRENT", template.startsWith("driver") ? d.id : order.id),
          guards: [...live, { table: "dispatch_commitment", id: c.id, match: { status: "ASSIGNED", generation: Number(d.generation) }, soft: true }] }));
    }
    const ship = await this.db("pickup_operation").where({ delivery_id: d.id, action: "SHIP", state: "SUCCEEDED", native_state: "done" }).whereNull("deleted_at").first();
    const picked = eventFor("PICKED_UP");
    if (d.status === "ASSIGNED" && !returned && d.picked_up_at && ship?.terminal_receipt && ship.fulfillment_id === d.native_fulfillment_id && picked) result.push(this.fact("customer.order_picked_up",
      "pickup_operation", ship.id, "SUCCEEDED", picked.occurred_at, { fulfillment: ship.fulfillment_id, operation: ship.id }, { ...scope, link: route("CUSTOMER_ORDER", order.id), guards: live }));
    const completion = await this.db("delivery_completion").where({ delivery_id: d.id, state: "SUCCEEDED", native_done: true }).whereNull("deleted_at").first();
    const delivered = eventFor("DELIVERED");
    if (d.status === "DELIVERED" && d.delivered_at && c?.status === "COMPLETED" && completion?.receipt && delivered
      && completion.commitment_id === c.id && completion.ship_operation_id === ship?.id) {
      for (const template of ["customer.delivery_completed", "merchant.delivery_completed"]) result.push(this.fact(template, "delivery_completion", completion.id,
        "SUCCEEDED", delivered.occurred_at, { completion: completion.id, ship: ship.id, commitment: c.id },
        { ...scope, merchantPolicy: "MANAGEMENT", link: route(template.startsWith("customer") ? "CUSTOMER_ORDER" : "MERCHANT_ORDER", order.id) }));
    }
    if (returned && returned.commitment_id === c?.id && d.status !== "DELIVERED") {
      const failure = await this.db("restricted_event").where({ target_id: returned.id, action: "RETURN_REQUIRED" }).whereNull("deleted_at").first();
      present(failure);
      result.push(this.fact("customer.return_required", "restricted_return", returned.id, "RETURN_REQUIRED", returned.failed_at,
        { return: returned.id, commitment: returned.commitment_id, event: failure.id }, { ...scope, link: route("CUSTOMER_ORDER", order.id) }));
      if (["RETURN_REQUIRED", "RETURNING_TO_STORE"].includes(returned.state)) {
        const guards = [{ table: "restricted_return" as const, id: returned.id, match: { state: returned.state as string }, soft: true }];
        for (const template of ["merchant.return_action", "driver.delivery_attention"]) result.push(this.fact(template, "restricted_return", returned.id, returned.state,
          returned.state === "RETURN_REQUIRED" ? returned.failed_at : returned.started_at, { return: returned.id, state: returned.state },
          { ...scope, merchantPolicy: "RETURN", driverId: c.driver_profile_id, link: route(template.startsWith("driver") ? "DRIVER_CURRENT" : "MERCHANT_ORDER", template.startsWith("driver") ? d.id : order.id), guards }));
      } else if (returned.state === "RETURNED_TO_STORE" && returned.received_by && returned.returned_at) {
        const receipt = await this.db("restricted_event").where({ target_id: returned.id, action: "STORE_RECEIPT_ACKNOWLEDGED", actor_id: returned.received_by }).first();
        present(receipt);
        const manifest = returned.physical_manifest as { id: string }[];
        const dispositions = await this.db("returned_inventory_disposition").where({ return_id: returned.id });
        if (manifest.some(line => !dispositions.some(row => row.line_id === line.id) || dispositions.some(row => row.line_id === line.id && row.status === "ATTENTION_REQUIRED"))) result.push(this.fact("merchant.disposition_required", "restricted_event", receipt.id,
          "RECEIVED", returned.returned_at, { return: returned.id, receipt: receipt.id }, { ...scope, merchantPolicy: "DISPOSITION", link: route("MERCHANT_ORDER", order.id) }));
      }
    }
    if (d.status === "ATTENTION_REQUIRED") {
      const event = [...events].sort((a, b) => Number(b.revision) - Number(a.revision)).find(row => ["ATTENTION_REQUIRED", "PICKUP_ATTENTION"].includes(row.action)); present(event);
      result.push(this.fact("platform.delivery_attention", "dispatch_event", event.id, "ATTENTION", event.occurred_at, { delivery: d.id, revision: event.revision },
        { ...scope, platform: "DELIVERY_OPERATIONS", link: null, guards: live }));
      if (c?.status === "ASSIGNED") result.push(this.fact("driver.delivery_attention", "dispatch_event", event.id, "ATTENTION", event.occurred_at,
        { delivery: d.id, commitment: c.id }, { ...scope, driverId: c.driver_profile_id, link: route("DRIVER_CURRENT", d.id), guards: live }));
      result.push(this.fact("merchant.fulfilment_attention", "dispatch_event", event.id, "ATTENTION", event.occurred_at,
        { delivery: d.id, revision: event.revision }, { ...scope, merchantPolicy: "PICKING", assignedMember: session?.assigned_member_id,
          link: route("MERCHANT_PICKING", order.id), guards: live }));
    }
    const recoveries = await this.db("pickup_operation").where({ delivery_id: d.id, state: "RECOVERY_REQUIRED" }).whereNull("deleted_at");
    const completionRecovery = await this.db("delivery_completion").where({ delivery_id: d.id, state: "RECOVERY_REQUIRED" }).whereNull("deleted_at").first();
    for (const recovery of [...recoveries.map(row => ({ row, table: "pickup_operation" as const, action: "PICKUP_RECOVERY_REQUIRED" })),
      ...(completionRecovery ? [{ row: completionRecovery, table: "delivery_completion" as const, action: "DELIVERY_COMPLETION_RECOVERY_REQUIRED" }] : [])]) {
      const event = events.find(item => item.action === recovery.action && (!item.evidence?.operation_id || item.evidence.operation_id === recovery.row.id)); present(event);
      const guards: Guard[] = [{ table: recovery.table, id: recovery.row.id, match: { state: "RECOVERY_REQUIRED" }, soft: true }];
      const templates = ["platform.delivery_attention", "merchant.fulfilment_attention", ...(c?.status === "ASSIGNED" ? ["driver.delivery_attention"] : [])];
      for (const template of templates) result.push(this.fact(template, recovery.table, recovery.row.id, "RECOVERY_REQUIRED", event.occurred_at,
        { operation: recovery.row.id, commitment: c?.id }, { ...scope, driverId: c?.driver_profile_id, merchantPolicy: "PICKING", assignedMember: session?.assigned_member_id,
          platform: "DELIVERY_OPERATIONS", link: template.startsWith("platform") ? null : route(template.startsWith("driver") ? "DRIVER_CURRENT" : "MERCHANT_PICKING", template.startsWith("driver") ? d.id : order.id), guards }));
    }
    return result;
  }
  private async compensation(operationId: string, credit: boolean) {
    const table = credit ? "store_credit_operation" : "refund_operation", query = this.db(table).where({ id: operationId });
    if (!credit) query.whereNull("deleted_at");
    const op = await query.first(); if (!op) return [];
    const context = await this.context(op.order_id); if (!context) return [];
    const adjustment = await this.db("financial_adjustment").where({ id: op.adjustment_id, medusa_order_id: op.order_id,
      customer_id: op.customer_id, status: "APPROVED", default_method: credit ? "STORE_CREDIT" : "ORIGINAL_PAYMENT" }).whereNull("deleted_at").first();
    const settlement = await this.db("financial_settlement").where({ id: op.settlement_id, adjustment_id: op.adjustment_id,
      method: credit ? "STORE_CREDIT" : "ORIGINAL_PAYMENT", amount_minor: op.amount_minor, currency: "zar" }).whereNull("deleted_at").first();
    if (!adjustment || !settlement || adjustment.customer_id !== context.order.customerId || String(adjustment.amount_minor) !== String(op.amount_minor)
      || adjustment.merchant_id !== context.handoff.merchant_id || adjustment.merchant_store_id !== context.handoff.merchant_store_id
      || op.currency !== "zar" || op.store_id !== context.handoff.merchant_store_id) throw new NotificationConflict();
    const event = credit ? await this.db("store_credit_operation_event").where({ operation_id: op.id, revision: op.revision, status: op.status }).first()
      : await this.db("refund_event").where({ refund_operation_id: op.id, revision: op.revision, status: op.status }).whereNull("deleted_at").first(); present(event);
    const at = credit ? event.occurred_at : event.created_at;
    const scope = { order: context.order, merchantId: adjustment.merchant_id as string, storeId: adjustment.merchant_store_id as string,
      reference: context.order.reference, link: route("CUSTOMER_ORDER", op.order_id) };
    if (op.status === "SETTLED") {
      // M18's deferred guards bind these immutable receipts to exact native
      // accounting. No issuance/refund command is invoked by notification reads.
      if (settlement.state !== "SETTLED" || !op.settled_at || (credit ? !op.account_id || !op.native_transaction_id : !op.native_refund_id || !op.order_transaction_id)) throw new NotificationConflict();
      if (!credit) {
        const attempt = await this.db("provider_refund_attempt").where({ id: op.current_attempt_id, refund_operation_id: op.id, status: "SUCCEEDED" }).first();
        if (!attempt?.verified_event_id || !attempt.provider_refund_id) throw new NotificationConflict();
      }
      return [this.fact(credit ? "customer.store_credit_issued" : "customer.refund_confirmed", table, op.id, "SETTLED", at,
        { operation: op.id, settlement: op.settlement_id, transaction: credit ? op.native_transaction_id : op.order_transaction_id, amount: String(op.amount_minor), currency: op.currency }, { ...scope, amount: op.amount_minor })];
    }
    if (op.status !== "ATTENTION_REQUIRED") return [];
    return [this.fact("platform.financial_attention", table, op.id, "ATTENTION_" + op.revision, at, { operation: op.id, revision: op.revision },
      { ...scope, platform: "CUSTOMER_FINANCE", platformAction: credit ? "CREDIT" : "REFUND", link: route("ADMIN_FINANCIAL", op.id),
        guards: [{ table, id: op.id, match: { status: "ATTENTION_REQUIRED", revision: Number(op.revision) }, soft: !credit }] })];
  }
  private async settlement(statementId: string) {
    const s = await this.db("merchant_period_statement").where({ id: statementId }).first(); if (!s || s.superseded_by) return [];
    const p = await this.db("payable_settlement").where({ statement_id: s.id }).first(), result: NotificationFact[] = [];
    const scope = { merchantId: s.merchant_id as string, storeId: s.store_id as string, reference: "settlement statement", merchantPolicy: "FINANCE" as const, link: route("MERCHANT_SETTLEMENT", s.id) };
    const ready = await this.db("settlement_transition_audit").where({ statement_id: s.id, action: "READY" }).first();
    if (s.status === "READY_FOR_APPROVAL" && p?.status === "READY_FOR_APPROVAL" && ready) {
      const guards: Guard[] = [{ table: "payable_settlement", id: p.id, match: { status: p.status } }];
      result.push(this.fact("merchant.settlement_ready", "settlement_transition_audit", ready.id, "READY", ready.recorded_at, { statement: s.id }, { ...scope, guards }));
      result.push(this.fact("platform.settlement_attention", "settlement_transition_audit", ready.id, "READY", ready.recorded_at, { statement: s.id },
        { ...scope, platform: "SETTLEMENT", platformAction: "PREPARE", link: route("ADMIN_SETTLEMENT", s.id), guards }));
    }
    if (!p) return result;
    const commands = await this.db("merchant_settlement_command").where({ payable_id: p.id }).orderBy("new_revision");
    for (const command of commands) {
      if (command.action === "PAY") {
        if (!["PAID", "RECONCILED"].includes(p.status)) throw new NotificationConflict();
        const receipt = await this.db("merchant_payout_receipt").where({ command_id: command.id, payable_id: p.id, statement_id: s.id,
          merchant_id: s.merchant_id, store_id: s.store_id, amount_minor: p.amount_minor, currency: "zar" }).first(); present(receipt);
        result.push(this.fact("merchant.settlement_paid", "merchant_settlement_command", command.id, "PAY", command.recorded_at,
          { receipt: receipt.id, statement: s.id, amount: String(receipt.amount_minor) }, { ...scope, amount: receipt.amount_minor }));
      } else if (command.action === "FAIL" && p.status === "FAILED" && Number(command.new_revision) === Number(p.revision)) {
        present(await this.db("merchant_payout_failure").where({ command_id: command.id, payable_id: p.id }).first());
        const guards: Guard[] = [{ table: "payable_settlement", id: p.id, match: { status: "FAILED", revision: Number(p.revision) } }];
        result.push(this.fact("merchant.settlement_failed", "merchant_settlement_command", command.id, "FAIL", command.recorded_at, { payable: p.id }, { ...scope, guards }));
        result.push(this.fact("platform.settlement_attention", "merchant_settlement_command", command.id, "FAIL", command.recorded_at, { payable: p.id },
          { ...scope, platform: "SETTLEMENT", platformAction: "PAYMENT", link: route("ADMIN_SETTLEMENT", s.id), guards }));
      } else if (command.action === "DISCREPANCY") {
        present(await this.db("merchant_settlement_discrepancy").where({ command_id: command.id, payable_id: p.id, status: "OPEN" }).first());
        for (const template of ["merchant.settlement_discrepancy", "platform.settlement_attention"]) result.push(this.fact(template,
          "merchant_settlement_command", command.id, "DISCREPANCY", command.recorded_at, { payable: p.id, statement: s.id },
          { ...scope, platform: "SETTLEMENT", platformAction: "PAYMENT", link: route(template.startsWith("merchant") ? "MERCHANT_SETTLEMENT" : "ADMIN_SETTLEMENT", s.id) }));
      }
    }
    return result;
  }
  private async driverPayment(paymentId: string) {
    const p = await this.db("driver_payment").where({ id: paymentId }).first(); if (!p) return [];
    if (p.currency !== "zar" || p.payer !== "GOSPAZA") throw new NotificationConflict();
    const commands = await this.db("driver_payment_command").where({ payment_id: p.id }).orderBy("recorded_at"), result: NotificationFact[] = [];
    const resolution = await this.db("driver_payment_resolution").where({ payment_id: p.id }).first();
    const scope = { driverId: p.driver_profile_id as string, reference: "your payment", link: route("DRIVER_EARNINGS", p.id) };
    const allocations = await this.db("driver_payment_allocation").where({ payment_id: p.id, driver_profile_id: p.driver_profile_id, payer: "GOSPAZA", currency: "zar" });
    const items = await this.db("driver_payment_item").where({ payment_id: p.id });
    const paid = p.initial_outcome === "PAID" || resolution?.outcome === "CONFIRMED_PAID";
    if (paid && (!items.length || items.length !== allocations.length || allocations.some(a => !items.some(i => i.earning_id === a.earning_id && String(i.amount_minor) === String(a.amount_minor)))
      || allocations.reduce((sum, a) => sum + BigInt(a.amount_minor), 0n) !== BigInt(p.amount_minor))) throw new NotificationConflict();
    for (const command of commands) {
      if (paid && (command.action === "RECORD" || command.action === "CONFIRMED_PAID" && resolution?.command_id === command.id))
        result.push(this.fact("driver.payment_recorded", "driver_payment_command", command.id, command.action, command.recorded_at,
          { payment: p.id, driver: p.driver_profile_id, amount: String(p.amount_minor) }, { ...scope, amount: p.amount_minor }));
      if (command.action === "RECONCILE") {
        present(await this.db("driver_payment_reconciliation").where({ payment_id: p.id, command_id: command.id }).first());
        result.push(this.fact("driver.payment_reconciled", "driver_payment_command", command.id, "RECONCILE", command.recorded_at,
          { payment: p.id, amount: String(p.amount_minor) }, { ...scope, amount: p.amount_minor }));
      }
      const unknown = command.action === "UNKNOWN" && !resolution;
      const discrepancy = command.action === "DISCREPANCY" && await this.db("driver_payment_discrepancy").where({ payment_id: p.id, command_id: command.id }).first();
      if (unknown || discrepancy || command.action === "CONFIRMED_NOT_PAID" && resolution?.command_id === command.id) {
        for (const template of ["driver.payment_attention", "platform.driver_payment_attention"]) result.push(this.fact(template,
          "driver_payment_command", command.id, command.action, command.recorded_at, { payment: p.id, driver: p.driver_profile_id },
          { ...scope, platform: "DRIVER_PAYMENT", link: route(template.startsWith("driver") ? "DRIVER_EARNINGS" : "ADMIN_DRIVER_FINANCE", p.id) }));
      }
    }
    return result;
  }
  private async recognition(exceptionId: string, driver: boolean) {
    const table = driver ? "driver_earning_exception" : "order_finance_exception";
    const exception = await this.db(table).where({ id: exceptionId }).first(); if (!exception) return [];
    // Neither owner currently provides a resolution mutation for these immutable
    // exceptions. An existing earning/posting does not prove the issue resolved.
    return [this.fact("platform.recognition_attention", table, exception.id, "UNRESOLVED", exception.recorded_at,
      { exception: exception.id, source: driver ? exception.delivery_id : exception.snapshot_id }, { reference: "financial review",
        platform: driver ? "DRIVER_RECOGNITION" : "MARKETPLACE_RECOGNITION", link: route(driver ? "ADMIN_DRIVER_FINANCE" : "ADMIN_COMMISSION", exception.id) })];
  }
  async current(fact: NotificationFact, trx: Knex.Transaction) {
    const { rows: [clock] } = await trx.raw("select gospaza_notification_now() as instant");
    for (const guard of fact.guards) {
      const query = trx(guard.table).where({ id: guard.id }); if (guard.soft) query.whereNull("deleted_at");
      const row = await query.forShare().first();
      if (!row || Object.entries(guard.match).some(([key, value]) => String(row[key]) !== String(value))
        || guard.table === "shortage_resolution" && row.invalidated_at
        || guard.future && new Date(row[guard.future]) <= new Date(clock.instant)) return false;
    }
    if (fact.kind === "DRIVER_PAYMENT_ATTENTION" && fact.source.type === "driver_payment_command") {
      const command = await trx("driver_payment_command").where({ id: fact.source.id }).first(); if (!command) return false;
      const resolution = await trx("driver_payment_resolution").where({ payment_id: command.payment_id }).first();
      if (command.action === "UNKNOWN" && resolution) return false;
      if (command.action === "CONFIRMED_NOT_PAID" && fact.audience === "user") {
        const items = await trx("driver_payment_item").where({ payment_id: command.payment_id });
        const allocations = items.length ? await trx("driver_payment_allocation").whereIn("earning_id", items.map(row => row.earning_id)) : [];
        if (items.length && allocations.length === items.length) return false;
      }
    }
    if (fact.kind === "RETURNED_GOODS_DISPOSITION_REQUIRED") {
      const receipt = await trx("restricted_event").where({ id: fact.source.id, action: "STORE_RECEIPT_ACKNOWLEDGED" }).first();
      const returned = receipt ? await trx("restricted_return").where({ id: receipt.target_id, state: "RETURNED_TO_STORE" }).first() : null;
      if (!returned) return false;
      const decisions = await trx("returned_inventory_disposition").where({ return_id: returned.id });
      if (!(returned.physical_manifest as { id: string }[]).some(line => !decisions.some(row => row.line_id === line.id)
        || decisions.some(row => row.line_id === line.id && row.status === "ATTENTION_REQUIRED"))) return false;
    }
    return true;
  }
}

export function notificationDatabase(container: MedusaContainer) { return container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
