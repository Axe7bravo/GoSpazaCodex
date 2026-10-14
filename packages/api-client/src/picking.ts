import type { PickingList, PickingOrder, PickingResult, PickingStatus, PickingLineInput, PickingReassignInput, PickingCompleteInput } from "@gospaza/contracts";

export class PickingError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Your merchant access needs to be checked."
      : status === 403 ? "You are no longer allowed to perform this picking action."
      : status === 404 ? "Picking order or team member unavailable."
      : status === 409 ? "Picking changed. Review the refreshed state before continuing."
      : status === 400 ? "Check the picked quantity and shortage marker. Quantity must be a whole number between zero and the ordered quantity."
      : "Picking could not be confirmed. Refresh before taking another action.");
    this.name = "PickingError";
  }
}
export function createPickingClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new PickingError(0);
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new PickingError(0); }
    if (!response.ok) throw new PickingError(response.status);
    try { return await response.json() as T; } catch { throw new PickingError(0); }
  }
  const path = (id: string) => "/merchant/picking/" + encodeURIComponent(id);
  return {
    list: (input: { limit?: number; offset?: number; status?: PickingStatus } = {}) => {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.offset !== undefined) query.set("offset", String(input.offset));
      if (input.status) query.set("status", input.status);
      return request<PickingList>("/merchant/picking?" + query);
    },
    detail: (id: string) => request<{ picking: PickingOrder }>(path(id)),
    claim: (id: string) => request<PickingResult>(path(id) + "/claim", "POST", {}),
    updateLine: (id: string, lineId: string, input: PickingLineInput) => request<PickingResult>(path(id) + "/lines/" + encodeURIComponent(lineId), "PUT", {
      expected_revision: input.expected_revision, picked_quantity: input.picked_quantity, shortage_recorded: input.shortage_recorded,
    }),
    reassign: (id: string, input: PickingReassignInput) => request<PickingResult>(path(id) + "/reassign", "POST", {
      expected_revision: input.expected_revision, target_member_id: input.target_member_id,
    }),
    complete: (id: string, input: PickingCompleteInput) => request<PickingResult>(path(id) + "/complete", "POST", {
      expected_revision: input.expected_revision, confirmed: input.confirmed,
    }),
  };
}
