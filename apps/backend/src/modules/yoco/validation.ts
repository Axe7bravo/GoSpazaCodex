import { BigNumber } from "@medusajs/framework/utils";
import type { BigNumberInput } from "@medusajs/framework/types";
import { z } from "@medusajs/framework/zod";
import { minorPrice } from "../marketplace/catalogue-policy";
import { YocoProviderError, type YocoOptions } from "./types";

export const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const checkoutReceipt = z.object({
  id: identifier,
  redirectUrl: z.string().url(),
  status: z.enum(["created", "started", "processing", "completed"]),
  amount: minorAmount,
  currency: z.literal("ZAR"),
  processingMode: z.enum(["test", "live"]),
});
export const refundReceipt = z.object({
  id: identifier,
  refundId: identifier,
  status: z.enum(["succeeded", "pending"]),
});

export function cents(amount: BigNumberInput, currency: string): number {
  if (currency.toUpperCase() !== "ZAR") throw new YocoProviderError("YOCO_INVALID_INPUT");
  try {
    // Reuse the existing precise boundary, including native raw_amount objects.
    const value = minorPrice(typeof amount === "string" || typeof amount === "number"
      ? amount : new BigNumber(amount));
    if (value <= 0) throw new Error("Amount must be positive.");
    return value;
  } catch {
    throw new YocoProviderError("YOCO_INVALID_INPUT");
  }
}

export function options(input: YocoOptions): YocoOptions {
  const parsed = z.object({
    secretKey: z.string().regex(/^sk_(test|live)_[a-zA-Z0-9_-]+$/),
    webhookSecret: z.string().regex(/^whsec_[a-zA-Z0-9+/]+={0,2}$/),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
    failureUrl: z.string().url(),
    allowedReturnOrigins: z.array(z.string().url()).min(1),
  }).strict().safeParse(input);
  if (!parsed.success) throw new YocoProviderError("YOCO_INVALID_INPUT");
  const result = parsed.data;
  const validUrl = (value: string) => {
    const url = new URL(value);
    const localTest = result.secretKey.startsWith("sk_test_")
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(localTest && url.protocol === "http:"))
      || url.username || url.password || url.hash || /[{}]/.test(value)) {
      throw new YocoProviderError("YOCO_INVALID_INPUT");
    }
    return url;
  };
  for (const origin of result.allowedReturnOrigins) {
    if (validUrl(origin).origin !== origin) throw new YocoProviderError("YOCO_INVALID_INPUT");
  }
  for (const value of [result.successUrl, result.cancelUrl, result.failureUrl]) {
    if (!result.allowedReturnOrigins.includes(validUrl(value).origin)) {
      throw new YocoProviderError("YOCO_INVALID_INPUT");
    }
  }
  webhookKey(result.webhookSecret);
  return result;
}

export function hostedRedirect(value: string): void {
  const url = new URL(value);
  if (url.origin !== "https://c.yoco.com" || url.username || url.password) {
    throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
  }
}

export function webhookKey(secret: string): Buffer {
  if (!/^whsec_[a-zA-Z0-9+/]+={0,2}$/.test(secret)) throw new YocoProviderError("YOCO_INVALID_INPUT");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 16 || key.toString("base64") !== encoded) throw new YocoProviderError("YOCO_INVALID_INPUT");
  return key;
}
