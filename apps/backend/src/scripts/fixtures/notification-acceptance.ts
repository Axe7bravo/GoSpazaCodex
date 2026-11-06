import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
export const notificationActorNames = ["customer", "apiCustomer", "foreignCustomer", "revokedCustomer", "merchant", "foreignMerchant", "picker", "revokedMerchant",
  "driver", "browserDriver", "foreignDriver", "revokedDriver", "operator", "apiOperator", "ordinary", "financeOnly"] as const;
export type NotificationActorName = typeof notificationActorNames[number];
export interface NotificationActor { id: string; identity: string; email: string; type: "customer" | "merchant" | "driver" | "user"; profile?: string; member?: string }
export interface NotificationManifest {
  version: 1; run: string; schema: string; database: string; credentials_file: string; publishable_key: string;
  api_state: "READY" | "RUNNING" | "VERIFIED";
  actors: Record<NotificationActorName, NotificationActor>; notices: Record<string, string>; offers: { api: string; browser: string };
  target_order: string; browser_customer_title: string; browser_driver_title: string;
}
export const m22Root = resolve(__dirname, "../../../../..");
export function notificationSelectionPath() { return resolve(m22Root, process.env.M22_ACCEPTANCE_SELECTION || "test-results/m22/current.json"); }
export function notificationAcceptanceSchema(schema: string) {
  if (process.env.APP_ENV !== "test" || process.env.NODE_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")
    || new URL(process.env.REDIS_URL ?? "").pathname !== "/1" || !/^m22_acceptance_[a-f0-9]{32}$/.test(schema)) throw Error("M22 acceptance requires the selected _test database, Redis /1 and test/test.");
  return schema;
}
export function loadNotificationSelection() {
  const selection = JSON.parse(readFileSync(notificationSelectionPath(), "utf8")) as { manifest: string };
  if (typeof selection.manifest !== "string") throw Error("Generate/select the M22 acceptance manifest first.");
  const file = resolve(m22Root, selection.manifest), manifest = JSON.parse(readFileSync(file, "utf8")) as NotificationManifest;
  if (manifest.version !== 1 || !/^[a-f0-9]{32}$/.test(manifest.run) || manifest.schema !== "m22_acceptance_" + manifest.run
    || manifest.database !== "gospaza_m18_c2b_test" || !manifest.publishable_key || typeof manifest.credentials_file !== "string"
    || notificationActorNames.some(name => !manifest.actors?.[name]?.email || !manifest.actors[name].identity)) throw Error("Invalid M22 acceptance selection.");
  const credentials = JSON.parse(readFileSync(resolve(manifest.credentials_file), "utf8")) as { run: string; seed: string };
  if (credentials.run !== manifest.run || !/^[a-f0-9]{64}$/.test(credentials.seed)) throw Error("M22 manifest and credential file do not match.");
  return { manifest, file, password: (email: string) => createHmac("sha256", credentials.seed).update(email).digest("hex") };
}
