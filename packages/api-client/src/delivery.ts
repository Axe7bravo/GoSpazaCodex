import type { DeliveryAvailability, DeliverySelection, DiscoveryLocation, ReleaseDeliveryInput, SelectDeliveryInput } from "@gospaza/contracts";

export class DeliveryError extends Error {
  constructor(public readonly status: number, public readonly refreshRequired: boolean, message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}
export function createDeliveryClient(baseUrl: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new DeliveryError(0, false, "Invalid delivery configuration.");
  }
  async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE", data?: unknown): Promise<T> {
    const write = method === "PUT" || method === "DELETE";
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { "x-publishable-api-key": publishableKey, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch {
      throw new DeliveryError(0, write, write
        ? "The delivery change could not be confirmed. Refresh delivery before making another change."
        : "Delivery could not be loaded. Please try again.");
    }
    if (response.ok) {
      try { return await response.json() as T; }
      catch { throw new DeliveryError(response.status, write, "Refresh delivery before making another change."); }
    }
    if (response.status === 401) throw new DeliveryError(401, false, "Please sign in again.");
    if (response.status === 409) throw new DeliveryError(409, true,
      "Delivery availability or your selection changed. Review the refreshed options and fee, then confirm again.");
    if (response.status === 400 || response.status === 404) throw new DeliveryError(response.status, true,
      "Delivery is unavailable for this cart or location. Refresh delivery and check your location.");
    throw new DeliveryError(response.status, write,
      write ? "The delivery change could not be confirmed. Refresh delivery before making another change."
        : "Delivery could not be loaded. Please try again.");
  }
  return {
    current(cartId: string) {
      return request<DeliverySelection>("/store/gospaza/cart/delivery-selection?" + new URLSearchParams({ cart_id: cartId }), "GET");
    },
    availability(cartId: string, location: DiscoveryLocation) {
      return request<DeliveryAvailability>("/store/gospaza/cart/delivery-options", "POST", { cart_id: cartId, location });
    },
    select(input: SelectDeliveryInput) {
      return request<DeliverySelection>("/store/gospaza/cart/delivery-selection", "PUT", input);
    },
    release(input: ReleaseDeliveryInput) {
      return request<DeliverySelection>("/store/gospaza/cart/delivery-selection", "DELETE", input);
    },
  };
}
