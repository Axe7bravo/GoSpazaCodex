import type { CheckoutAttemptInput, CheckoutConfirmInput, CheckoutPreparation, CheckoutPrepareInput,
  CustomerCheckoutStatus, PaymentInitiationResult } from "@gospaza/contracts";

export class CheckoutError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(status === 401 ? "Please sign in again to view checkout."
      : status === 400 || status === 404 ? "Check your delivery address and selection, then refresh checkout."
      : "We could not confirm checkout. Refresh its status before making another payment attempt.");
    this.name = "CheckoutError";
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Validate a navigation target only; this never implies payment success. */
export function checkoutRedirect(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://c.yoco.com" || url.username || url.password) {
    throw new CheckoutError(0, "CHECKOUT_REDIRECT_INVALID");
  }
  return url.href;
}
export function createCheckoutClient(baseUrl: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new CheckoutError(0, "CONFIGURATION");
  async function request<T>(path: string, method: "GET" | "POST", data?: unknown, expectedFailure?: (body: Record<string, unknown>, status: number) => boolean): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL("/store/gospaza/checkout" + path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { "x-publishable-api-key": publishableKey, ...(data ? { "Content-Type": "application/json" } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    } catch { throw new CheckoutError(0, "CHECKOUT_REFRESH_REQUIRED"); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new CheckoutError(response.status, "CHECKOUT_REFRESH_REQUIRED"); }
    if (!object(body)) throw new CheckoutError(response.status, "CHECKOUT_REFRESH_REQUIRED");
    if (!response.ok && !expectedFailure?.(body, response.status)) {
      const safe = ["CHECKOUT_RECONFIRM", "CHECKOUT_FROZEN", "CHECKOUT_REFRESH_REQUIRED", "PAYMENT_RECOVERY_REQUIRED"];
      throw new CheckoutError(response.status, typeof body.code === "string" && safe.includes(body.code) ? body.code : "CHECKOUT_REFRESH_REQUIRED");
    }
    return body as T;
  }
  const preparation = (input: CheckoutPrepareInput) => ({ cart_id: input.cart_id, address_id: input.address_id,
    expected_reservation_revision: input.expected_reservation_revision });
  const attempt = (input: CheckoutAttemptInput) => ({ cart_id: input.cart_id, attempt_id: input.attempt_id,
    checkout_revision: input.checkout_revision, confirmed: input.confirmed });
  return {
    status: (attemptId?: string) => request<CustomerCheckoutStatus>("/status" + (attemptId ? "?" + new URLSearchParams({ attempt_id: attemptId }) : ""), "GET"),
    prepare: (input: CheckoutPrepareInput) => request<CheckoutPreparation>("/prepare", "POST", preparation(input)),
    confirm: (input: CheckoutConfirmInput) => request<CheckoutPreparation>("/confirm", "POST", {
      ...preparation(input), checkout_revision: input.checkout_revision, confirmed: input.confirmed,
    }, (body, status) => status === 409 && body.code === "CHECKOUT_RECONFIRM" && body.reconfirmation_required === true && object(body.quote)),
    abandon: (input: CheckoutAttemptInput) => request("/abandon", "POST", attempt(input)),
    pay: (input: CheckoutAttemptInput) => request<PaymentInitiationResult>("/pay", "POST", attempt(input),
      (body, status) => (status === 503 && body.state === "uncertain") || (status === 409 && body.state === "expired")),
  };
}