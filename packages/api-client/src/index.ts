import type { LivenessResponse } from "@gospaza/contracts";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly requestId: string | null) {
    super("API request failed (" + status + ")");
    this.name = "ApiError";
  }
}

/** No ambient cookies or actor credentials. Authentication is intentionally not implemented in M0. */
export function createApiClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("API base URL must be HTTP(S) without credentials");
  }
  return {
    async liveness(signal?: AbortSignal): Promise<LivenessResponse> {
      const response = await fetcher(new URL("/health/live", base), {
        method: "GET", credentials: "omit", cache: "no-store",
        signal: signal ?? AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new ApiError(response.status, response.headers.get("x-request-id"));
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("status" in body) || body.status !== "ok") {
        throw new Error("Invalid liveness response");
      }
      return { status: "ok" };
    },
  };
}
