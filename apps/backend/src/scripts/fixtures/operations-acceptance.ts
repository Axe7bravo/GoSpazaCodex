import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
export const operationsActors = ["order", "delivery", "combined", "finance", "notifications", "ordinary", "rescue", "rescueOnly", "reviewOnly", "legacy",
  "revokedOrder", "revokedDelivery", "revokedRescue", "revokedLegacy", "customer", "merchant"] as const;
export const operationsCases = ["read", "apiRescue", "apiRace", "apiStale", "apiRevoked", "browserRescue", "browserPrivacy"] as const;
export type OperationsActorName = typeof operationsActors[number];
export type OperationsCaseName = typeof operationsCases[number];
export interface OperationsActor { id: string; identity: string; email: string; type: "user" | "customer" | "merchant" | "driver"; profile?: string }
export interface OperationsCase { order: string; cart: string; delivery: string; driver: OperationsActor; old_offer: string; request_id: string; revision: number; generation: number; reason: string }
export interface OperationsManifest {
  version: 1; run: string; schema: string; database: "gospaza_m18_c2b_test"; api_state: "READY" | "RUNNING" | "VERIFIED";
  actors: Record<OperationsActorName, OperationsActor>; cases: Record<OperationsCaseName, OperationsCase>;
  merchant: string; store: string; application: string; document: string; zone: string; restricted_payment: string; restricted_notification: string; health_at: string;
}
export const operationsRoot = resolve(__dirname, "../../../../..");
export const operationsOutput = resolve(operationsRoot, "test-results/m23");
export function operationsSchema(schema: string, env: NodeJS.ProcessEnv = process.env) {
  let valid = false;
  try { const database = new URL(env.DATABASE_URL ?? ""), redis = new URL(env.REDIS_URL ?? "");
    valid = ["postgres:", "postgresql:"].includes(database.protocol) && database.pathname === "/gospaza_m18_c2b_test"
      && ["redis:", "rediss:"].includes(redis.protocol) && redis.pathname === "/1" && !redis.search;
  } catch { /* Never include a malformed credential-bearing URL in an error. */ }
  if (env.APP_ENV !== "test" || env.NODE_ENV !== "test" || !valid || !/^m23_acceptance_[a-f0-9]{32}$/.test(schema)) throw Error("Select the existing M23 _test database, Redis /1 and test/test.");
  return schema;
}
export function loadOperationsSelection() {
  const pointer = JSON.parse(readFileSync(resolve(operationsOutput, "current.json"), "utf8")) as { run: string };
  if (!/^[a-f0-9]{32}$/.test(pointer.run)) throw Error("Generate the M23 fixture selection first.");
  const directory = resolve(operationsOutput, pointer.run), file = resolve(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as OperationsManifest;
  const credential = JSON.parse(readFileSync(resolve(directory, "credentials.json"), "utf8")) as { run: string; seed: string };
  if (manifest.version !== 1 || manifest.run !== pointer.run || manifest.schema !== "m23_acceptance_" + manifest.run || manifest.database !== "gospaza_m18_c2b_test"
    || !["READY", "RUNNING", "VERIFIED"].includes(manifest.api_state) || credential.run !== manifest.run || !/^[a-f0-9]{64}$/.test(credential.seed)
    || operationsActors.some(name => !manifest.actors?.[name]?.id || !manifest.actors[name].identity || !manifest.actors[name].email)
    || operationsCases.some(name => { const c = manifest.cases?.[name]; return !c?.delivery || !c.order || !c.cart || !c.old_offer || !c.request_id || !c.driver?.identity || !c.driver.profile || !c.driver.email
      || c.generation !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 1 || c.reason !== "POOL_EXHAUSTED"; })) throw Error("M23 manifest/credential selection mismatch.");
  if (new Set(operationsCases.map(name => manifest.cases[name].delivery)).size !== operationsCases.length
    || new Set(operationsCases.map(name => manifest.cases[name].order)).size !== operationsCases.length) throw Error("M23 mutation/read fixtures must be distinct.");
  return { manifest, file, password: (email: string) => createHmac("sha256", credential.seed).update(email).digest("hex") };
}
