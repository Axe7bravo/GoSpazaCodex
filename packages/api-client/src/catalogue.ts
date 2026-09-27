import { AuthError } from "./auth";
import type { CatalogueList, CatalogueProduct, CatalogueWrite, InventoryList } from "@gospaza/contracts";
export function createCatalogueClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new AuthError("configuration", "Invalid API configuration.");
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30000),
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AuthError("unavailable", "We cannot reach the catalogue. Please try again."); }
    if (!response.ok) {
      if (response.status === 401) throw new AuthError("unauthorized", "An active merchant membership is required.", 401);
      if (response.status === 403) throw new AuthError("validation", "Your role cannot make this change.", 403);
      if (response.status === 404) throw new AuthError("validation", "Catalogue item not available.", 404);
      if (response.status === 409) throw new AuthError("validation", "Catalogue setup or data needs attention. Retry or contact support.", 409);
      if (response.status >= 500) throw new AuthError("unavailable", "Catalogue service is unavailable. Please try again.", response.status);
      throw new AuthError("validation", "Check the product, stock and image details. Images must be JPEG, PNG or WebP, up to 5 MB.", response.status);
    }
    return response.json() as Promise<T>;
  }
  const productPath = (id: string) => "/merchant/products/" + encodeURIComponent(id);
  return {
    list: (query = "") => request<CatalogueList>("/merchant/products" + query),
    detail: (id: string) => request<{ product: CatalogueProduct }>(productPath(id)),
    create: (data: CatalogueWrite) => request<{ product: CatalogueProduct }>("/merchant/products", "POST", data),
    update: (id: string, data: CatalogueWrite) => request<{ product: CatalogueProduct }>(productPath(id), "PATCH", data),
    inventory: (query = "") => request<InventoryList>("/merchant/inventory" + query),
    stock: (id: string, stocked_quantity: number) => request<{ product: CatalogueProduct }>("/merchant/inventory/" + encodeURIComponent(id), "PATCH", { stocked_quantity }),
    upload: (id: string, mime_type: string, content: string) => request<{ product: CatalogueProduct }>(productPath(id) + "/images", "POST", { mime_type, content }),
    removeImage: (id: string, imageId: string) => request<{ product: CatalogueProduct }>(productPath(id) + "/images/" + encodeURIComponent(imageId), "DELETE", {}),
  };
}
