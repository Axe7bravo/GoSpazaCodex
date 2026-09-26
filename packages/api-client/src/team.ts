import { AuthError } from "./auth";
import type {
  MerchantContext, MerchantMember, MerchantInvitation,
  MerchantMemberChange, MerchantInvitationCreated,
} from "@gospaza/contracts";

export function createMerchantTeamClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new AuthError("configuration", "Invalid API configuration.");
  }
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AuthError("unavailable", "GoSpaza is unavailable. Please try again."); }
    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new AuthError("unauthorized", "An active merchant session or membership is required.", status);
      if (status === 403) throw new AuthError("validation", "Your account is not allowed to perform this team action.", status);
      if (status === 404) throw new AuthError("validation", "Team resource not available.", status);
      if (status === 409) throw new AuthError("validation", path.endsWith("/accept")
        ? "Invitation cannot be accepted. It may be expired, revoked, used, for another email, or your account may already have a membership. Check the account or ask the owner for help."
        : "The team changed or an invitation or membership already exists. Refresh before trying again.", status);
      if (status >= 500 || status === 429) throw new AuthError("unavailable", "GoSpaza is temporarily unavailable. Please try again.", status);
      throw new AuthError("validation", "Check the email, role and membership details.", status);
    }
    try { return await response.json() as T; }
    catch { throw new AuthError("unavailable", "GoSpaza returned an unexpected response."); }
  }
  return {
    context: () => request<MerchantContext>("/merchant/me"),
    members: () => request<{ members: MerchantMember[] }>("/merchant/team"),
    invitations: () => request<{ invitations: MerchantInvitation[] }>("/merchant/team/invitations"),
    invite: (email: string, role: "MANAGER" | "PICKER") => request<MerchantInvitationCreated>("/merchant/team/invitations", "POST", { email, role }),
    revoke: (id: string) => request<{ invitation: MerchantInvitation }>("/merchant/team/invitations/" + encodeURIComponent(id) + "/revoke", "POST", {}),
    change: (id: string, input: MerchantMemberChange) => request<{ member: MerchantMember }>("/merchant/team/members/" + encodeURIComponent(id), "PATCH", input),
    accept: (token: string) => request<{ member_id: string }>("/merchant/team/invitations/accept", "POST", { token }),
  };
}
