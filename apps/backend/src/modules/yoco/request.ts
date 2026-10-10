import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { identifier, minorAmount, options } from "./validation";
import type { YocoOptions } from "./types";

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export const requestSchema = z.object({
  amount: minorAmount, currency: z.literal("ZAR"),
  metadata: z.object({
    operation_id: identifier, attempt_id: identifier,
    // A legacy already-sent request retains its original correlation unchanged.
    session_id: identifier.optional(),
  }).strict(),
  externalId: identifier, successUrl: z.string().url(), cancelUrl: z.string().url(), failureUrl: z.string().url(),
}).strict();

export function initiationRequest(id: string, attemptId: string, amount: number, config: YocoOptions): string {
  const fixed = options(config);
  return JSON.stringify(requestSchema.parse({
    amount, currency: "ZAR", metadata: { operation_id: id, attempt_id: attemptId }, externalId: id,
    successUrl: fixed.successUrl, cancelUrl: fixed.cancelUrl, failureUrl: fixed.failureUrl,
  }));
}
