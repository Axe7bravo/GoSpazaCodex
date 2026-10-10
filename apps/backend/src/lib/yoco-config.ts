import { options } from "../modules/yoco/validation";
import type { YocoOptions } from "../modules/yoco/types";

export const YOCO_PROVIDER_ID = "pp_yoco_yoco";
export function paymentDeadlineMinutes(env: NodeJS.ProcessEnv): number {
  const value = env.PAYMENT_PENDING_MINUTES ?? "15";
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
    throw new Error("PAYMENT_PENDING_MINUTES must be an integer from 1 to 1440.");
  }
  return Number(value);
}
export function yocoConfiguration(env: NodeJS.ProcessEnv): YocoOptions | null {
  paymentDeadlineMinutes(env);
  const enabled = env.YOCO_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled)) throw new Error("YOCO_ENABLED must be true or false.");
  if (enabled === "false") return null;
  // Test payments must never establish commercial authority in production.
  if (env.APP_ENV === "production" && !env.YOCO_SECRET_KEY?.startsWith("sk_live_")) {
    throw new Error("Production payments require a live Yoco secret key.");
  }
  return options({
    secretKey: env.YOCO_SECRET_KEY ?? "", webhookSecret: env.YOCO_WEBHOOK_SECRET ?? "",
    successUrl: env.YOCO_SUCCESS_URL ?? "", cancelUrl: env.YOCO_CANCEL_URL ?? "",
    failureUrl: env.YOCO_FAILURE_URL ?? "",
    allowedReturnOrigins: (env.YOCO_RETURN_ORIGINS ?? "").split(",").map((origin) => origin.trim()),
  });
}

export function reconciliationWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PAYMENT_RECONCILIATION_WORKER_ENABLED ?? "true";
  if (!["true", "false"].includes(value)) throw new Error("PAYMENT_RECONCILIATION_WORKER_ENABLED must be true or false.");
  if (env.APP_ENV === "production" && value !== "true") throw new Error("Payment reconciliation must be enabled in production.");
  return value === "true";
}
