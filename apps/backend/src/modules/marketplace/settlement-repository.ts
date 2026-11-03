import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { AdjustmentRow } from "../../lib/financial-service";
import type { SettlementMethod } from "./financial-policy";
import { refundConflict } from "./refund-policy";

// One shared entitlement owner for ORIGINAL_PAYMENT and future STORE_CREDIT.
// Caller locks its order/adjustment first. The database guard also serializes
// every insertion on the adjustment; no independent refundable balance exists.
export async function reserveSettlement(trx: Knex.Transaction, adjustment: AdjustmentRow, method: SettlementMethod, amount: number) {
  if (adjustment.status !== "APPROVED" || !adjustment.eligible_methods.includes(method)
    || adjustment.currency !== "zar" || !Number.isSafeInteger(amount) || amount <= 0) throw refundConflict();
  const id = "fset_" + randomUUID();
  await trx("financial_settlement").insert({ id, adjustment_id: adjustment.id, method, amount_minor: amount, currency: "zar", state: "RESERVED" });
  return id;
}
export async function settlementTotals(db: Knex | Knex.Transaction, adjustment: string) {
  const rows = await db<{ state: string; amount_minor: string | number }>("financial_settlement").where({ adjustment_id: adjustment });
  const sum = (state: string) => Number(rows.filter(r => r.state === state).reduce((s, r) => s + BigInt(r.amount_minor), 0n));
  return { reserved_minor: sum("RESERVED"), settled_minor: sum("SETTLED") };
}
