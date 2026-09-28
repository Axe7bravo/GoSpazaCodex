import { AuthError } from "./auth";
import type { DiscoveryLocation, DiscoveryResult, PublicCatalogue, PublicProduct, PublicSearch } from "@gospaza/contracts";

export function createStorefrontClient(baseUrl: string, publishableKey: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new AuthError("configuration", "Invalid API configuration.");
  async function request<T>(path: string, location: DiscoveryLocation, query: { q?: string; offset?: number } = {}, post = false): Promise<T> {
    const url = new URL("/store/gospaza/" + path, base);
    const data = { ...location, ...query, limit: 20 };
    if (!post) for (const [name, value] of Object.entries(data)) url.searchParams.set(name, String(value));
    let response: Response;
    try {
      response = await fetcher(url, {
        method: post ? "POST" : "GET", credentials: "include", cache: "no-store",
        signal: AbortSignal.timeout(30000),
        headers: { "x-publishable-api-key": publishableKey, ...(post ? { "Content-Type": "application/json" } : {}) },
        ...(post ? { body: JSON.stringify(data) } : {}),
      });
    } catch { throw new AuthError("unavailable", "Storefront is unavailable. Please try again."); }
    if (!response.ok) {
      if (response.status === 401) throw new AuthError("unauthorized", "Please sign in again.", 401);
      if (response.status === 404) throw new AuthError("validation", "This store, product or address is unavailable at your location.", 404);
      if (response.status === 400) throw new AuthError("validation", "Choose a saved address with coordinates or use current location.", 400);
      throw new AuthError("unavailable", "Storefront is unavailable. Please try again.", response.status);
    }
    return response.json() as Promise<T>;
  }
  return {
    discover: (location: DiscoveryLocation, offset = 0) => request<DiscoveryResult>("discovery", location, { offset }, true),
    catalogue: (id: string, location: DiscoveryLocation, offset = 0) =>
      request<PublicCatalogue>("stores/" + encodeURIComponent(id) + "/products", location, { offset }),
    product: (id: string, location: DiscoveryLocation) =>
      request<{ product: PublicProduct }>("products/" + encodeURIComponent(id), location),
    search: (q: string, location: DiscoveryLocation, offset = 0) =>
      request<PublicSearch>("search", location, { q, offset }),
  };
}
