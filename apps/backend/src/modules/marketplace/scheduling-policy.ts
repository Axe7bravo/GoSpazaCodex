import { MedusaError } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { minorPrice } from "./catalogue-policy";

export const schedulingDefaults = {
  timezone: "Africa/Johannesburg", minimum_lead_minutes: 60,
  booking_horizon_days: 7, hold_minutes: 15,
  enabled: false, asap_enabled: false, scheduled_enabled: false,
};
export const schedulingConflict = (message: string) => new MedusaError(MedusaError.Types.CONFLICT, message);
export const schedulingId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const configurationReason = z.string().trim().min(3).max(500);
export const policyInput = z.object({
  timezone: z.string().max(100).refine((value) => {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
    try { new Intl.DateTimeFormat("en-ZA", { timeZone: value }).format(); return true; }
    catch { return false; }
  }, "Valid IANA timezone required.").default(schedulingDefaults.timezone),
  minimum_lead_minutes: z.number().int().min(0).max(10080).default(schedulingDefaults.minimum_lead_minutes),
  booking_horizon_days: z.number().int().min(1).max(90).default(schedulingDefaults.booking_horizon_days),
  hold_minutes: z.number().int().min(1).max(1440).default(schedulingDefaults.hold_minutes),
  enabled: z.boolean(), asap_enabled: z.boolean(), scheduled_enabled: z.boolean(),
}).strict();
export const slotInput = z.object({
  start_at: z.string().datetime(), end_at: z.string().datetime(), booking_cutoff_at: z.string().datetime(),
  capacity: z.number().int().min(1).max(100000), enabled: z.boolean(),
}).strict().refine((slot) => Date.parse(slot.start_at) < Date.parse(slot.end_at)
  && Date.parse(slot.booking_cutoff_at) <= Date.parse(slot.start_at), "Invalid slot interval/cutoff.");
export function schedulingInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid scheduling configuration.");
  return result.data;
}
export interface AssignmentCandidate {
  id: string; priority: number; delivery_fee_minor: number; currency_code: string;
  asap_enabled: boolean; scheduled_enabled: boolean;
}
export function resolveDeliveryAssignment<T extends AssignmentCandidate>(eligible: T[]): T | null {
  if (!eligible.length) return null;
  const highest = Math.max(...eligible.map((row) => row.priority));
  const top = eligible.filter((row) => row.priority === highest);
  const signature = (row: T) => JSON.stringify([row.delivery_fee_minor, row.currency_code, row.asap_enabled, row.scheduled_enabled]);
  if (new Set(top.map(signature)).size !== 1) throw schedulingConflict("DELIVERY_ZONE_AMBIGUOUS");
  // Equivalent highest-priority configurations only: stable identity, never cheapest/first-match authority.
  return top.sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}
export function assertDeliverySynchronized(config: {
  revision: number; synced_revision: number | null; sync_state: string; medusa_shipping_option_id: string | null;
}, nativeRevision: unknown, nativeAmount: Parameters<typeof minorPrice>[0], tariff: number) {
  if (config.sync_state !== "READY" || config.revision !== config.synced_revision
    || !config.medusa_shipping_option_id || nativeRevision !== config.revision
    || minorPrice(nativeAmount) !== tariff) throw schedulingConflict("DELIVERY_CONFIGURATION_STALE");
}
