import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Discovery } from "./notification-sources";
export const repairFamilies: readonly Discovery[] = ["ORDER", "DELIVERY", "REFUND", "CREDIT", "SETTLEMENT", "DRIVER_PAYMENT", "MARKETPLACE_EXCEPTION", "DRIVER_EXCEPTION"];
// Marketplace-owned audit read contract. No native commerce scans. Each source
// family exposes only identity/time, and C must independently prove the fact.
const statements: Record<Discovery, string> = {
  ORDER: `select (c.terminal_receipt->>'verified_at')::timestamptz at,'c:'||c.id key,c.order_id source_id from checkout_completion c
    where c.state='SUCCEEDED' and c.terminal_receipt->>'verified_at'>=? and c.terminal_receipt->>'verified_at'<?
    union all select e.decided_at,'d:'||e.id,o.medusa_order_id from order_decision_event e join order_operation o on o.id=e.order_operation_id where e.decided_at>=? and e.decided_at<?
    union all select e.occurred_at,'p:'||e.id,o.medusa_order_id from pick_event e join pick_session p on p.id=e.pick_session_id
    join order_operation o on o.id=p.order_operation_id where e.occurred_at>=? and e.occurred_at<?
    union all select r.created_at,'s:'||r.id,o.medusa_order_id from shortage_resolution r join pick_session p on p.id=r.pick_session_id
    join order_operation o on o.id=p.order_operation_id where r.created_at>=? and r.created_at<?`,
  DELIVERY: `select e.occurred_at at,'d:'||e.id key,e.target_id source_id from dispatch_event e where e.target_type='DELIVERY' and e.occurred_at>=? and e.occurred_at<?
    union all select e.created_at,'r:'||e.id,r.delivery_id from restricted_event e join restricted_return r on r.id=e.target_id where e.created_at>=? and e.created_at<?`,
  REFUND: `select created_at at,id key,refund_operation_id source_id from refund_event where created_at>=? and created_at<?`,
  CREDIT: `select occurred_at at,operation_id||':'||revision::text key,operation_id source_id from store_credit_operation_event where occurred_at>=? and occurred_at<?`,
  SETTLEMENT: `select recorded_at at,'a:'||id key,statement_id source_id from settlement_transition_audit where recorded_at>=? and recorded_at<?
    union all select c.recorded_at,'c:'||c.id,p.statement_id from merchant_settlement_command c join payable_settlement p on p.id=c.payable_id where c.recorded_at>=? and c.recorded_at<?`,
  DRIVER_PAYMENT: `select recorded_at at,id key,payment_id source_id from driver_payment_command where recorded_at>=? and recorded_at<?`,
  MARKETPLACE_EXCEPTION: `select recorded_at at,id key,id source_id from order_finance_exception where recorded_at>=? and recorded_at<?`,
  DRIVER_EXCEPTION: `select recorded_at at,id key,id source_id from driver_earning_exception where recorded_at>=? and recorded_at<?`,
};
export async function repairCandidates(db: Knex, family: Discovery, window: { start: Date; end: Date; at: Date | null; key: string | null }, limit: number) {
  if (!repairFamilies.includes(family) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error("Invalid repair scope.");
  const sql = statements[family], copies = sql.split("union all").length;
  const bindings: (string | number)[] = [];
  for (let index = 0; index < copies; index++) bindings.push(window.start.toISOString(), window.end.toISOString());
  if (window.at && window.key) bindings.push(window.at.toISOString(), window.key);
  bindings.push(limit);
  const result = await db.raw(`select at,key,source_id from (${sql}) candidate ${window.at && window.key ? "where (at,key)>(?::timestamptz,?::text)" : ""} order by at,key limit ?`, bindings);
  return result.rows as { at: Date; key: string; source_id: string }[];
}
