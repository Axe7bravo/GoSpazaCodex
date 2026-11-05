import { createHmac } from "node:crypto";
export interface DriverFinanceActor { id: string; identity: string; email: string; profile?: string }
export type DriverFinanceActorName = "operator" | "viewer" | "manager" | "recorder" | "reconciler" | "driver" | "apiDriver" | "foreign" | "revoked" | "merchant" | "customer";
export interface DriverFinanceManifest {
  version: 1; schema: string; api_verified?: boolean; actors: Record<DriverFinanceActorName, DriverFinanceActor>;
  earnings: Record<"api" | "apiBlocked" | "browser" | "readonly" | "foreign" | "revoked", string[]>;
}
export function driverFinanceManifestPath() { if (!process.env.M21_BROWSER_MANIFEST) throw new Error("Select a fresh M21_BROWSER_MANIFEST."); return process.env.M21_BROWSER_MANIFEST; }
export function driverFinanceFixtureSchema(schema: string) {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || !/^m21_acceptance_[a-f0-9]{32}$/.test(schema)) throw new Error("M21 acceptance scope is test-only.");
  return schema;
}
export function driverFinancePassword(email: string) {
  const secret = process.env.M21_VERIFY_SECRET;
  if (process.env.APP_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || !secret || !/^[a-f0-9]{32,128}$/i.test(secret)) throw new Error("M21 requires an isolated database and random test credential seed.");
  return createHmac("sha256", secret).update(email).digest("hex");
}
