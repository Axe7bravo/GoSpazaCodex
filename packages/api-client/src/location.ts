import { AuthError } from "./auth";
import type { AddressWrite, SavedAddress, ServiceZoneInput, ZoneList, ZoneDetail, Serviceability } from "@gospaza/contracts";

export function createLocationClient(baseUrl: string, publishableKey = "", fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new AuthError("configuration", "Invalid API configuration.");
  async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { ...(publishableKey ? { "x-publishable-api-key": publishableKey } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch { throw new AuthError("unavailable", "Location service is unavailable. Please try again."); }
    if (!response.ok) {
      if (response.status === 401) throw new AuthError("unauthorized", "Please sign in again.", 401);
      if (response.status === 404) throw new AuthError("validation", "Address, zone or store not found.", 404);
      if (response.status >= 500) throw new AuthError("unavailable", "Location service is unavailable. Please try again.", response.status);
      throw new AuthError("validation", "Check your address, coordinates, geometry and fee. The requested change could not be saved.", response.status);
    }
    return response.json() as Promise<T>;
  }
  const zone = (id: string) => "/admin/gospaza/service-zones/" + encodeURIComponent(id);
  const address = (id: string) => "/store/gospaza/addresses/" + encodeURIComponent(id);
  return {
    zones: () => request<ZoneList>("/admin/gospaza/service-zones"),
    zone: (id: string) => request<ZoneDetail>(zone(id)),
    saveZone: (data: ServiceZoneInput, id?: string) => request<ZoneDetail>(id ? zone(id) : "/admin/gospaza/service-zones", id ? "PATCH" : "POST", data),
    assign: (id: string, merchant_store_id: string) => request<ZoneDetail>(zone(id) + "/stores", "POST", { merchant_store_id }),
    unassign: (id: string, storeId: string) => request<ZoneDetail>(zone(id) + "/stores/" + encodeURIComponent(storeId), "DELETE"),
    addresses: () => request<{ addresses: SavedAddress[] }>("/store/gospaza/addresses"),
    saveAddress: (data: AddressWrite, id?: string) => request<{ success: boolean }>(id ? address(id) : "/store/gospaza/addresses", id ? "PATCH" : "POST", data),
    deleteAddress: (id: string) => request<{ success: boolean }>(address(id), "DELETE"),
    serviceability: (latitude: number, longitude: number) => request<Serviceability>("/store/gospaza/serviceability", "POST", { latitude, longitude }),
  };
}
