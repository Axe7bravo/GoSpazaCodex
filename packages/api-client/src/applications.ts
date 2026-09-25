import { AuthError } from "./auth";
import type { ApplicationFields, ApplicationDetail, ApplicationList, ApplicationDocument } from "@gospaza/contracts";
export function createApplicationClient(baseUrl: string, admin = false, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid API URL");
  const prefix = admin ? "/admin/gospaza/merchant-applications" : "/merchant/applications";
  async function request(path: string, method = "GET", body?: unknown, binary = false) {
    let response: Response;
    try { response = await fetcher(new URL(path, base), { method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(60000),
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }); } catch { throw new AuthError("unavailable", "GoSpaza is unavailable. Please try again."); }
    if (!response.ok) {
      if (response.status === 401) throw new AuthError("unauthorized", "Your session has expired. Sign in again.", 401);
      if (response.status >= 500) throw new AuthError("unavailable", "The request could not be completed. Please retry; contact support if it persists.");
      throw new AuthError("validation", response.status === 404 ? "Application or document not available." : "Check the required fields, file type and size, or refresh the application status.", response.status);
    }
    return binary ? response.blob() : response.json();
  }
  const path = (id: string) => prefix + "/" + encodeURIComponent(id);
  const ensureApplicant = () => { if (admin) throw new Error("Admin application review is read-only"); };
  return {
    own: async (): Promise<ApplicationDetail> => { ensureApplicant(); return request(prefix + "/me"); },
    create: async (): Promise<ApplicationDetail> => { ensureApplicant(); return request(prefix, "POST", {}); },
    edit: async (id: string, fields: Partial<ApplicationFields>): Promise<ApplicationDetail> => { ensureApplicant(); return request(path(id), "PATCH", fields); },
    submit: async (id: string): Promise<ApplicationDetail> => { ensureApplicant(); return request(path(id) + "/submit", "POST", {}); },
    upload: async (id: string, document: { document_type: string; display_name: string; mime_type: string; content: string }): Promise<ApplicationDetail> => { ensureApplicant(); return request(path(id) + "/documents", "POST", document); },
    remove: async (id: string, documentId: string): Promise<void> => { ensureApplicant(); await request(path(id) + "/documents/" + encodeURIComponent(documentId), "DELETE"); },
    list: async (query: { status?: string; q?: string; offset?: number }): Promise<ApplicationList> => {
      if (!admin) throw new Error("Admin client required");
      const params = new URLSearchParams({ limit: "20", offset: String(query.offset ?? 0) });
      if (query.status) params.set("status", query.status); if (query.q) params.set("q", query.q);
      return request(prefix + "?" + params);
    },
    detail: async (id: string): Promise<ApplicationDetail> => request(path(id)),
    download: async (id: string, document: ApplicationDocument): Promise<Blob> => request(path(id) + "/documents/" + encodeURIComponent(document.id) + "/access", "GET", undefined, true),
  };
}
