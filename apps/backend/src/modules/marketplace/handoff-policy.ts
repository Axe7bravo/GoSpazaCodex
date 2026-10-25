import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
export const handoffPolicy = Object.freeze({ digits: 6, lifetimeMs: 600000, generationFailures: 5, deliveryFailures: 15, generations: 3, cooldownMs: 60000 });
export const handoffRevision = z.object({ expected_revision: z.number().int().positive() }).strict();
export const handoffGuess = handoffRevision.extend({ code: z.string().regex(/^\d{6}$/) }).strict();
export function handoffError(code = "HANDOFF_UNAVAILABLE") { return new MedusaError(MedusaError.Types.CONFLICT, "Handoff state changed or needs attention. Refresh before continuing.", code); }
export function handoffSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env.HANDOFF_OTP_SECRET;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value) || new Set(value).size < 12) throw new Error("HANDOFF_OTP_SECRET must be a dedicated random 32-byte hex secret.");
  for (const name of ["JWT_SECRET","COOKIE_SECRET","YOCO_SECRET_KEY","YOCO_WEBHOOK_SECRET"]) if (value === env[name]) throw new Error("Handoff secret must be dedicated.");
  return Buffer.from(value, "hex");
}
export function handoffCode(secret: Buffer, delivery: string, nonce: string, generation: number): string {
  // Rejection sampling avoids modulo bias; canonical tuples avoid JSONB key ordering.
  for (let round = 0; ; round++) {
    const digest = createHmac("sha256", secret).update(JSON.stringify(["gospaza/handoff/otp/v1", delivery, nonce, generation, round])).digest();
    for (let offset = 0; offset < digest.length; offset += 4) {
      const n = digest.readUInt32BE(offset);
      if (n < 4294000000) return String(n % 1000000).padStart(handoffPolicy.digits, "0");
    }
  }
}
export function matchesHandoff(expected: string, candidate: string) {
  return /^\d{6}$/.test(candidate) && timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}
export function handoffNonce() { return randomBytes(32).toString("hex"); }
export function handoffKeyId(secret: Buffer) { return createHash("sha256").update("gospaza/handoff/key/v1").update(secret).digest("hex"); }
// M17 supplies authoritative evidence here, never a client-settable boolean.
export function handoffCompliance(restricted: boolean): "SATISFIED" | "REQUIRED" { return restricted ? "REQUIRED" : "SATISFIED"; }
export interface HandoffGeneration { id: string; delivery_id: string; number: number; nonce: string; key_id: string; created_at: Date; expires_at: Date; failed_attempts: number; state: "ACTIVE" | "SUPERSEDED" | "EXHAUSTED" | "CONSUMED"; }
export interface DeliveryCompletion { id: string; delivery_id: string; commitment_id: string; generation_id: string; ship_operation_id: string; workflow_id: string; transaction_id: string; state: "DISPATCHED" | "RECOVERY_REQUIRED" | "SUCCEEDED"; dispatched_at: Date; receipt: { fulfillment_id: string; delivered_at: string } | null; }
