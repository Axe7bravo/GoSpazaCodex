import { z } from "@medusajs/framework/zod";
import { fingerprint } from "./request";
import type { RefundAttemptRow, RefundRow } from "../marketplace/refund-policy";
import { mayReplayRefund } from "../marketplace/refund-policy";
import { yocoConfiguration } from "../../lib/yoco-config";

export type RefundResponse = { kind: "ACCEPTED"; refundId: string; status: 202 }
  | { kind: "NOT_CREATED"; status: number }
  | { kind: "UNKNOWN" };
export interface RefundTransport { send(row: RefundRow, attempt: RefundAttemptRow): Promise<RefundResponse> }
// Transport owns only the frozen request. A 202 is never settlement proof.
export class YocoRefundTransport implements RefundTransport {
  constructor(private readonly request: typeof fetch = fetch) {}
  async send(row: RefundRow, attempt: RefundAttemptRow): Promise<RefundResponse> {
    const config = yocoConfiguration(process.env);
    if (!config || fingerprint(config.secretKey) !== row.account_fingerprint
      || (config.secretKey.startsWith("sk_live_") ? "live" : "test") !== row.mode
      || fingerprint(attempt.request_json) !== attempt.request_fingerprint
      || !attempt.first_sent_at || !mayReplayRefund(attempt.first_sent_at, new Date())) return { kind: "UNKNOWN" };
    try {
      const response = await this.request("https://payments.yoco.com/api/checkouts/" + encodeURIComponent(row.checkout_id) + "/refund", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: "Bearer " + config.secretKey, "Content-Type": "application/json", "Idempotency-Key": attempt.idempotency_key },
        body: attempt.request_json,
      });
      // A complete, recognizable provider rejection is distinct from a timeout,
      // intermediary HTML, truncated body, or an unrecognized success response.
      const raw = await response.text();
      if (raw.length > 65536) return { kind: "UNKNOWN" };
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return { kind: "UNKNOWN" }; }
      if (response.status === 202) {
        const result = z.object({ refundId: z.string().regex(/^rfd_[A-Za-z0-9_-]+$/).max(200) }).safeParse(body);
        return result.success ? { kind: "ACCEPTED", refundId: result.data.refundId, status: 202 } : { kind: "UNKNOWN" };
      }
      // Do not treat gateway/server errors as proof of non-creation. Support's
      // error-response guarantee applies to an actual Checkout API rejection.
      const rejected = z.object({ code: z.string().min(1).max(200), description: z.string().max(2000).optional(), message: z.string().max(2000).optional() }).safeParse(body);
      return response.status >= 400 && response.status < 500 && response.status !== 422 && rejected.success
        ? { kind: "NOT_CREATED", status: response.status } : { kind: "UNKNOWN" };
    } catch { return { kind: "UNKNOWN" }; }
  }
}
