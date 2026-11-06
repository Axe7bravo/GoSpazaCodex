import { AuthError } from "@gospaza/api-client";
export type RescueOutcome = "RECORDED" | "CONFLICT" | "DENIED" | "UNCERTAIN";
// Request lifecycle only. A successful POST never substitutes for current GET
// readback, and an uncertain result never creates a fresh command identity.
export async function rescueAndRefresh(write: () => Promise<unknown>, refresh: () => Promise<boolean>): Promise<RescueOutcome> {
  let outcome: RescueOutcome;
  try { await write(); outcome = "RECORDED"; }
  catch (cause) {
    outcome = cause instanceof AuthError && cause.status === 409 ? "CONFLICT"
      : cause instanceof AuthError && [400, 401, 403, 404].includes(cause.status ?? 0) ? "DENIED" : "UNCERTAIN";
  }
  await refresh(); return outcome;
}
