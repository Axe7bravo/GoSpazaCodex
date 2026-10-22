import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import type { DispatchMode, DispatchPath } from "@gospaza/contracts";
import { resourceId } from "./team-policy";
import { coordinates } from "./location-policy";
export const modes = ["DISABLED", "MERCHANT_ONLY", "PLATFORM_ONLY", "HYBRID"] as const;
export const emptyDispatch = z.object({}).strict();
export const dispatchRevision = z.object({ expected_revision: z.number().int().min(0).max(2147483646) }).strict();
export const dispatchConfigurationInput = dispatchRevision.extend({ mode: z.enum(modes), reason: z.string().trim().min(1).max(500) });
export const dispatchLocationInput = coordinates.extend({
  generation: resourceId, sequence: z.number().int().positive().max(2147483647),
  accuracy: z.number().finite().nonnegative().max(100000).optional(),
}).strict();
export function dispatchParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid dispatch input.");
  return parsed.data;
}
export function dispatchConflict(code = "DISPATCH_CONFLICT"): never {
  throw new MedusaError(MedusaError.Types.CONFLICT, "Dispatch state changed or is unavailable. Refresh before continuing.", code);
}
export function dispatchMissing(): never { throw new MedusaError(MedusaError.Types.NOT_FOUND, "Dispatch resource not found."); }
export interface DispatchPolicy { freshnessMs: number; offerMs: number; merchantPhaseMs: number; searchMs: number; leadMs: number }
export function dispatchPolicy(env: NodeJS.ProcessEnv = process.env): DispatchPolicy {
  function seconds(key: string, fallback: number, min: number, max: number) {
    const raw = env[key], value = raw === undefined ? fallback : Number(raw);
    if (raw === "" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid " + key);
    return value * 1000;
  }
  return { freshnessMs: seconds("DISPATCH_LOCATION_FRESHNESS_SECONDS", 120, 1, 3600),
    offerMs: seconds("DISPATCH_OFFER_SECONDS", 30, 1, 300),
    merchantPhaseMs: seconds("DISPATCH_MERCHANT_PHASE_SECONDS", 120, 1, 3600),
    searchMs: seconds("DISPATCH_SEARCH_SECONDS", 300, 1, 7200),
    leadMs: seconds("DISPATCH_SCHEDULED_LEAD_SECONDS", 1800, 0, 86400) };
}
export function initialPath(mode: DispatchMode): DispatchPath {
  if (mode === "DISABLED") return dispatchConflict("DISPATCH_DISABLED");
  return mode === "PLATFORM_ONLY" ? "PLATFORM" : "MERCHANT";
}
export function pathAllowed(mode: DispatchMode, path: DispatchPath) {
  return mode === "HYBRID" || mode === "MERCHANT_ONLY" && path === "MERCHANT" || mode === "PLATFORM_ONLY" && path === "PLATFORM";
}
export function dispatchNotBefore(mode: "ASAP" | "SCHEDULED", start: Date, policy: DispatchPolicy): Date | null {
  return mode === "ASAP" ? null : new Date(start.getTime() - policy.leadMs);
}
export function dispatchTimeReady(notBefore: Date | null, now: Date) {
  return notBefore === null || now.getTime() >= notBefore.getTime();
}
export function offerExpiry(now: Date, deadline: Date, phaseDeadline: Date | null, offerMs: number) {
  return new Date(Math.min(now.getTime() + offerMs, deadline.getTime(), phaseDeadline?.getTime() ?? Infinity));
}
export function locationFresh(receivedAt: number, now: Date, policy: DispatchPolicy) {
  return Number.isFinite(receivedAt) && receivedAt <= now.getTime() && now.getTime() - receivedAt < policy.freshnessMs;
}
