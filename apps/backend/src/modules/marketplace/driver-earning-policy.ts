import { z } from "@medusajs/framework/zod";
import { resourceId } from "./team-policy";

export const DRIVER_EARNING_POLICY = "M21_C_V1";
export const driverEarningPage = z.object({ after: resourceId.optional(), through: resourceId.optional(),
  limit: z.coerce.number().int().min(1).max(25).default(25) }).strict();
export function driverEarningsView(actor: string, env: NodeJS.ProcessEnv = process.env) {
  return !!actor && (env.DRIVER_EARNINGS_VIEW_USER_IDS ?? "").split(",").map(v => v.trim()).includes(actor);
}
export function driverEarningEventOrder(data: unknown) {
  if (!data || typeof data !== "object" || !("order_id" in data)) return null;
  const order = resourceId.safeParse(data.order_id);
  return order.success ? order.data : null; // All event-provided economics/driver fields are ignored.
}
export interface DriverEarningEvidence {
  state: "READY" | "PENDING" | "NO_DELIVERY" | "NO_ORDINARY_EARNING" | "HISTORICAL_REVIEW" | "UNRESOLVED";
  reason?: string; delivery_id?: string; order_id?: string; commitment_id?: string | null; completion_id?: string | null;
  driver_profile_id?: string | null; source_fingerprint?: string; event_id?: string; source_revision?: number;
  snapshot?: { id: string; state: string; payer: string; path: string; currency: string; amount_minor: string | null };
}
// Monetary policy consumes only the SQL-validated frozen snapshot, never a rate
// lookup or event payload. Exact strings remain exact through the read model.
export function driverEarningDisposition(source: DriverEarningEvidence) {
  if (source.state !== "READY") return { state: source.state, reason: source.reason };
  const snapshot = source.snapshot;
  if (snapshot?.state === "RESOLVED_NON_GOSPAZA_PAYABLE" && snapshot.path === "MERCHANT"
    && snapshot.payer === "NON_GOSPAZA_PAYABLE" && snapshot.currency === "zar" && snapshot.amount_minor === null)
    return { state: "NON_GOSPAZA_PAYABLE" as const };
  if (snapshot?.state !== "RESOLVED_GOSPAZA_PAYABLE" || snapshot.path !== "PLATFORM" || snapshot.payer !== "GOSPAZA"
    || snapshot.currency !== "zar" || !snapshot.amount_minor || !/^[1-9]\d*$/.test(snapshot.amount_minor)
    || BigInt(snapshot.amount_minor) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid frozen driver compensation evidence.");
  return { state: "EARNED" as const, amount_minor: snapshot.amount_minor };
}
export function driverEarningSourceMatches(original: string, observed: string | undefined) { return original === observed; }
