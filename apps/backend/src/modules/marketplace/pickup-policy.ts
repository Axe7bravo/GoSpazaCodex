import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";

export const pickupCommand = z.object({ expected_revision: z.number().int().positive().max(2147483646) }).strict();
export const pickupManifest = z.array(z.object({ id: z.string(), quantity: z.number().int().positive() }).strict());
export type PickupManifest = z.infer<typeof pickupManifest>;
export function physicalManifest(lines: { id: string; ordered: number; picked: number; omitted: number }[]): PickupManifest {
  if (!lines.length || new Set(lines.map(l => l.id)).size !== lines.length
    || lines.some(l => ![l.ordered,l.picked,l.omitted].every(Number.isSafeInteger)
      || l.ordered <= 0 || l.picked < 0 || l.omitted < 0 || l.picked + l.omitted !== l.ordered)) throw pickupConflict();
  return lines.filter(l => l.picked > 0).map(l => ({ id: l.id, quantity: l.picked })).sort((a,b) => a.id.localeCompare(b.id));
}
export function pickupFingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function pickupConflict() { return new MedusaError(MedusaError.Types.CONFLICT, "Pickup state changed or requires operational attention. Refresh before continuing.", "PICKUP_UNAVAILABLE"); }
export const pickupInput = z.object({ order_id: z.string(), location_id: z.string(), shipping_option_id: z.string(),
  items: pickupManifest, commitment_id: z.string(), picking_fingerprint: z.string(),
  fulfillment_id: z.string().nullable(), expected_revision: z.number().int(), driver_profile_id: z.string(),
  financial_review_required: z.boolean(),
  components: z.array(z.object({ line_item_id: z.string(), inventory_item_id: z.string().nullable(), quantity: z.number().int().positive() })),
  reservations: z.array(z.object({ id: z.string(), line_item_id: z.string(), inventory_item_id: z.string(), location_id: z.string(), remaining: z.number().int().nonnegative() })) });
export type PickupInput = z.infer<typeof pickupInput>;
// JSONB does not preserve object key order. Keep exact quantities and duplicates.
export function pickupComponentSignature(items: PickupInput["components"]) {
  return JSON.stringify(items.map(i => JSON.stringify([i.line_item_id, i.inventory_item_id, i.quantity])).sort());
}
export interface PickupOperation {
  id: string; delivery_id: string; action: "PREPARE" | "SHIP"; state: "DISPATCHED" | "SUCCEEDED" | "RECOVERY_REQUIRED";
  workflow_id: string; transaction_id: string; input: PickupInput; input_fingerprint: string;
  native_state: string | null; execution_id: string | null; run_id: string | null;
  fulfillment_id: string | null; terminal_receipt: Record<string, unknown> | null; dispatched_at: Date;
}
