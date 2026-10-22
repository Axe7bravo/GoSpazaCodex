import { AuthError, createDriverAuthClient } from "./auth";
import type {
  DriverAccountDTO, DriverAffiliationDTO, DriverAffiliationInput, DriverDecisionReceipt,
  DriverMutationDTO, DriverPage, DriverProfileDTO, DriverProfileAction, DriverAffiliationAction,
  DriverReviewInput, DriverStatus, DriverTargetPage, MerchantDriverDTO,
} from "@gospaza/contracts";

export function driverTransport(baseUrl: string, fetcher: typeof fetch, headers: Record<string, string> = {}) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new AuthError("configuration", "Invalid API configuration.");
  return async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { ...headers, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new AuthError("unavailable", "Unable to reach GoSpaza. Refresh to check the latest state before trying again."); }
    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new AuthError("unauthorized", "Sign in with the correct account to continue.", status);
      if (status === 403 || status === 404) throw new AuthError("validation", "Driver information or action is unavailable.", status);
      if (status === 409) throw new AuthError("validation", "Driver details changed. Review the latest state before deciding again.", status);
      if (status >= 500 || status === 429) throw new AuthError("unavailable", "GoSpaza is temporarily unavailable. Refresh before trying again.", status);
      throw new AuthError("validation", "Check the details and whether this action is still permitted.", status);
    }
    try { return await response.json() as T; }
    catch { throw new AuthError("unavailable", "Unable to read the latest driver state. Refresh before trying again."); }
  };
}
const ref = (id: string) => encodeURIComponent(id);
const page = (offset = 0) => "?limit=20&offset=" + offset;
const review = (input: DriverReviewInput) => ({ expected_revision: input.expected_revision, confirmed: input.confirmed, reason: input.reason });

export function createDriverClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = driverTransport(baseUrl, fetcher);
  const auth = createDriverAuthClient({ baseUrl, fetcher });
  return {
    // The onboarding probe authenticates a DRIVER even before its profile exists.
    async restore(): Promise<DriverAccountDTO | null> {
      await auth.me();
      try { return await request<DriverAccountDTO>("/driver/profile"); }
      catch (error) {
        if (!(error instanceof AuthError && error.status === 401)) throw error;
        // Distinguish a missing profile from an expired/wrong-actor session.
        await auth.me();
        return null;
      }
    },
    bootstrap: () => request<DriverAccountDTO>("/driver/profile/bootstrap", "POST", {}),
    update: (revision: number, fields: { display_name: string; contact_phone: string }) => request<DriverMutationDTO>("/driver/profile", "PATCH", {
      expected_revision: revision, display_name: fields.display_name, contact_phone: fields.contact_phone,
    }),
    submit: (revision: number) => request<DriverMutationDTO>("/driver/profile/submit", "POST", { expected_revision: revision }),
    targets: (offset = 0) => request<DriverTargetPage>("/driver/affiliation-targets" + page(offset)),
    history: (offset = 0) => request<DriverPage<DriverAffiliationDTO>>("/driver/affiliations" + page(offset)),
    requestAffiliation: (input: DriverAffiliationInput) => request<DriverMutationDTO>("/driver/affiliations", "POST", input.kind === "PLATFORM"
      ? { kind: input.kind, expected_revision: input.expected_revision }
      : { kind: input.kind, expected_revision: input.expected_revision, merchant_store_id: input.merchant_store_id }),
    withdraw: (id: string, revision: number) => request<DriverMutationDTO>("/driver/affiliations/" + ref(id) + "/withdraw", "POST", { expected_revision: revision }),
  };
}
export function createMerchantDriverClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = driverTransport(baseUrl, fetcher);
  return {
    list: (offset = 0) => request<DriverPage<MerchantDriverDTO>>("/merchant/drivers" + page(offset)),
    detail: (id: string) => request<{ item: MerchantDriverDTO }>("/merchant/drivers/" + ref(id)),
    decide: (id: string, action: "endorse" | "decline" | "revoke", input: DriverReviewInput) =>
      request<{ receipt: DriverDecisionReceipt }>("/merchant/drivers/" + ref(id) + "/" + action, "POST", review(input)),
  };
}
export function createAdminDriverClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = driverTransport(baseUrl, fetcher);
  const path = (id: string) => "/admin/gospaza/drivers/" + ref(id);
  return {
    list: (offset = 0, status?: DriverStatus) => request<DriverPage<DriverProfileDTO>>("/admin/gospaza/drivers" + page(offset) + (status ? "&status=" + status : "")),
    detail: (id: string) => request<DriverAccountDTO>(path(id)),
    decide: (id: string, action: DriverProfileAction, input: DriverReviewInput) => request<DriverMutationDTO>(path(id) + "/" + action, "POST", review(input)),
    affiliation: (id: string, affiliation: string, action: DriverAffiliationAction, input: DriverReviewInput) =>
      request<DriverMutationDTO>(path(id) + "/affiliations/" + ref(affiliation) + "/" + action, "POST", review(input)),
  };
}
