import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { OrderOperationRow } from "./order-operation-repository";
import { shortageEvidence } from "./shortage-policy";
import { financialConflict, lineAllocations, restrictedFinancialCause, adjustsDelivery } from "./financial-policy";
import type { FinancialAllocation, FinancialCause, FinancialReason } from "./financial-policy";
import type { FinancialEconomics } from "../../lib/financial-native";
import { z } from "@medusajs/framework/zod";

export interface FinancialSource {
  type: string; id: string; revision: number; reason: FinancialReason; cause: FinancialCause;
  allocations: FinancialAllocation[]; review: boolean;
}
// Marketplace owns these sources. Caller holds merchant -> OrderOperation. It never
// acquires an earlier driver lock; M12/M17 mutations also require this operation lock.
export async function financialSources(trx: Knex.Transaction, op: OrderOperationRow, economics: FinancialEconomics): Promise<FinancialSource[]> {
  const full = () => economics.lines.flatMap(line => lineAllocations(line,0,line.quantity));
  const fee = (reason:FinancialReason,cause:FinancialCause): FinancialAllocation[] => adjustsDelivery(cause,reason) ? [
    { component:"DELIVERY_FEE", economic_key:"shipping", start_unit:0, end_unit:1, amount_minor:economics.shipping_net_minor },
    { component:"TAX", economic_key:"shipping", start_unit:0, end_unit:1, amount_minor:economics.shipping_tax_minor },
  ] : [];
  if (op.status === "REJECTED") {
    if (!op.rejected_at || !await trx("order_decision_event").where({ order_operation_id:op.id, to_status:"REJECTED" }).whereNull("deleted_at").first()) throw financialConflict();
    return [{ type:"ORDER_REJECTION", id:op.id, revision:op.revision, reason:"MERCHANT_REJECTED", cause:"MERCHANT", allocations:full().concat(fee("MERCHANT_REJECTED","MERCHANT")), review:false }];
  }
  const session = await trx("pick_session").where({ order_operation_id:op.id, status:"COMPLETED" }).whereNull("deleted_at").first();
  if (!session) return [];
  const sources: FinancialSource[] = [];
  const lines = await trx("pick_line").where({ pick_session_id:session.id }).whereNull("deleted_at").orderBy("id");
  let pickedTotal = 0;
  for (const physical of lines) {
    const native = economics.lines.find(l => l.id === physical.medusa_order_line_id);
    const ordered = Number(physical.ordered_quantity_at_start), picked = Number(physical.picked_quantity);
    if (!native || ordered !== native.quantity || !Number.isSafeInteger(picked) || picked < 0 || picked > ordered) throw financialConflict();
    pickedTotal += picked;
    if (picked === ordered) continue;
    const resolution = await trx("shortage_resolution").where({ pick_line_id:physical.id, status:"RESOLVED_OMITTED", financial_review_required:true }).whereNull("invalidated_at").whereNull("deleted_at").first();
    if (!resolution || !resolution.resolved_at) throw financialConflict();
    const evidence = shortageEvidence.parse(resolution.evidence);
    if (evidence.native_order_id !== op.medusa_order_id || evidence.native_line_id !== native.id || evidence.ordered !== ordered || evidence.picked !== picked) throw financialConflict();
    sources.push({ type:"TERMINAL_OMISSION", id:resolution.id, revision:resolution.revision, reason:"ITEM_OMITTED", cause:"MERCHANT", allocations:lineAllocations(native,picked,ordered), review:false });
  }
  if (lines.length !== economics.lines.length) throw financialConflict();
  if (pickedTotal === 0) {
    // Completed all-omitted picking proves no physical order exists to deliver.
    // Use one full source instead of separate partial entitlements.
    return [{ type:"ALL_OMITTED", id:session.id, revision:session.revision, reason:"FULL_UNFULFILLABLE", cause:"MERCHANT", allocations:full().concat(fee("FULL_UNFULFILLABLE","MERCHANT")), review:false }];
  }
  const delivery = await trx("delivery_operation").where({ order_operation_id:op.id }).whereNull("deleted_at").first();
  if (!delivery) return sources;
  const returned = await trx("restricted_return").where({ delivery_id:delivery.id, state:"RETURNED_TO_STORE" }).whereNull("deleted_at").first();
  if (!returned) return sources;
  if (!returned.received_by || !returned.returned_at || delivery.status !== "RETURNED_TO_STORE"
    || !await trx("restricted_event").where({ target_id:returned.id, action:"STORE_RECEIPT_ACKNOWLEDGED", actor_id:returned.received_by }).first()) throw financialConflict();
  const compliance = await trx("recipient_compliance").where({ id:returned.compliance_id, delivery_id:delivery.id, outcome:"FAILED" }).first();
  const cause = restrictedFinancialCause(compliance?.reason ?? null);
  const manifest=z.array(z.object({id:z.string(),quantity:z.number().int().positive()})).parse(returned.physical_manifest);
  const physical=lines.filter(l=>Number(l.picked_quantity)>0).map(l=>({id:String(l.medusa_order_line_id),quantity:Number(l.picked_quantity)})).sort((a,b)=>a.id.localeCompare(b.id));
  if (JSON.stringify(manifest.map(m=>({id:m.id,quantity:m.quantity})).sort((a,b)=>a.id.localeCompare(b.id)))!==JSON.stringify(physical)) throw financialConflict();
  // Unknown cause requires review; never infer fault from private observations.
  const allocations = lines.flatMap(physical => {
    const native = economics.lines.find(l => l.id === physical.medusa_order_line_id);
    if (!native) throw financialConflict();
    return Number(physical.picked_quantity) === 0 ? [] : lineAllocations(native,0,Number(physical.picked_quantity));
  });
  sources.push({ type:"RESTRICTED_RETURN", id:returned.id, revision:1, reason:"RESTRICTED_HANDOFF_FAILED", cause:cause ?? "POLICY",
    allocations:allocations.concat(fee("RESTRICTED_HANDOFF_FAILED",cause ?? "POLICY")), review:!cause });
  return sources;
}
