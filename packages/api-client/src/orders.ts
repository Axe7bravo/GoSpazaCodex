import type { OrderShortages, ShortagePreference, ShortageResolution, ShortagePreferenceInput, ShortageOmissionInput, CustomerOrder, MerchantOrder, MerchantOrderDecision, MerchantOrderList,
  OrderDecisionInput, OrderListInput, OrderRejectInput } from "@gospaza/contracts";

export class OrderError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Please sign in again to view this order."
      : status === 403 ? "Your account cannot access orders."
      : status === 404 ? "Order unavailable."
      : status === 409 ? "The order changed. Its latest status must be reviewed."
      : status === 400 ? "Check the confirmation and rejection reason, then try again."
      : "Order information is unavailable. Refresh before taking another action.");
    this.name = "OrderError";
  }
}
function transport(baseUrl: string, fetcher: typeof fetch, key?: string) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new OrderError(0);
  return async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json", ...(key !== undefined ? { "x-publishable-api-key": key } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new OrderError(0); }
    if (!response.ok) throw new OrderError(response.status); // Never display server diagnostics.
    try { return await response.json() as T; }
    catch { throw new OrderError(0); }
  };
}
export function createMerchantOrderClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = transport(baseUrl, fetcher);
  const path = (id: string) => "/merchant/orders/" + encodeURIComponent(id);
  return {
    list: (input: OrderListInput = {}) => {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.offset !== undefined) query.set("offset", String(input.offset));
      if (input.status) query.set("status", input.status);
      return request<MerchantOrderList>("/merchant/orders?" + query);
    },
    detail: (id: string) => request<{ order: MerchantOrder }>(path(id)),
    accept: (id: string, input: OrderDecisionInput) => request<{ decision: MerchantOrderDecision }>(path(id) + "/accept", "POST", {
      expected_revision: input.expected_revision, confirmed: input.confirmed,
    }),
    reject: (id: string, input: OrderRejectInput) => request<{ decision: MerchantOrderDecision }>(path(id) + "/reject", "POST", {
      expected_revision: input.expected_revision, confirmed: input.confirmed,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
  };
}
export function createCustomerOrderClient(baseUrl: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const request = transport(baseUrl, fetcher, publishableKey);
  const path = (id: string) => "/store/gospaza/orders/" + encodeURIComponent(id);
  return {
    detail: (id: string) => request<{ order: CustomerOrder }>(path(id)),
    preference: (id: string) => request<{ preference: ShortagePreference }>(path(id) + "/substitution-preference"),
    updatePreference: (id: string, input: ShortagePreferenceInput) => request<{ preference: ShortagePreference }>(path(id) + "/substitution-preference", "PUT", {
      preference: input.preference, expected_revision: input.expected_revision,
    }),
    shortages: (id: string) => request<OrderShortages>(path(id) + "/shortages"),
    omit: (id: string, caseId: string, input: ShortageOmissionInput) => request<{ shortage: ShortageResolution }>(path(id) + "/shortages/" + encodeURIComponent(caseId) + "/omit", "POST", {
      expected_revision: input.expected_revision, confirmed: input.confirmed,
    }),
  };
}
