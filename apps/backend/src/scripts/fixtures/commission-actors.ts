import { createHmac } from "node:crypto";
import { resolve } from "node:path";

export const commissionActorFile = resolve(__dirname, "../../../../../test-results/m19-commission-actors.json");
export function commissionFixturePassword(email: string) {
  const secret = process.env.M19_VERIFY_SECRET;
  if (process.env.APP_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || !secret || !/^[a-f0-9]{32,128}$/i.test(secret)) throw new Error("Isolated commission verifier credentials required.");
  return createHmac("sha256", secret).update(email).digest("hex");
}
