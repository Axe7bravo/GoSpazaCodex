import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { knex } from "@medusajs/framework/mikro-orm/knex";
import { isolatedEnvironment } from "./isolated-verifier";
import { loadOperationsSelection, operationsRoot, operationsSchema, type OperationsManifest } from "../src/scripts/fixtures/operations-acceptance";
import { platformCapabilities } from "../src/modules/marketplace/platform-capabilities";
import { requireM23PortFree } from "./m23-port";
export const m23Backend = resolve(operationsRoot, "apps/backend");
export function operationsBackendEnvironment(manifest?: OperationsManifest, revoked = false) {
  const file = parseEnv(readFileSync(resolve(m23Backend, ".env"), "utf8")), target = "gospaza_m18_c2b_test";
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL ?? file.DATABASE_URL ?? ""); } catch { throw Error("Invalid selected PostgreSQL endpoint."); }
  if (process.env.DATABASE_URL && url.pathname !== "/" + target) throw Error("Shell database differs from the selected M23 database.");
  url.pathname = "/" + target;
  const { env, summary } = isolatedEnvironment(file, { ...process.env, DATABASE_URL: url.href });
  if (!env.JWT_SECRET?.trim() || !env.COOKIE_SECRET?.trim()) throw Error("Required backend session secrets are missing.");
  for (const capability of platformCapabilities) env[capability + "_USER_IDS"] = "";
  for (const capability of ["FINANCIAL_VIEW", "FINANCIAL_VIEW_DISPOSITION", "SETTLEMENT_VIEW", "DRIVER_EARNINGS_VIEW", "DRIVER_COMPENSATION_MANAGE", "COMMISSION_CONFIGURE", "NOTIFICATION_OPERATIONS_VIEW"]) env[capability + "_USER_IDS"] = "";
  env.RESTRICTED_COMMERCE_REVIEWER_IDS = "";
  Object.assign(env, { MEDUSA_WORKER_MODE: "server", PORT: "9000", DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false",
    REFUND_RECOVERY_WORKER_ENABLED: "false", PAYMENT_RECONCILIATION_WORKER_ENABLED: "false", NOTIFICATION_EMAIL_ENABLED: "false", NOTIFICATION_WEBHOOK_ENABLED: "false",
    NOTIFICATION_DELIVERY_WORKER_ENABLED: "false", NOTIFICATION_REPAIR_WORKER_ENABLED: "false", APPLICATION_FILES_PROVIDER: "local", APPLICATION_FILES_LOCAL_DIR: resolve(operationsRoot, ".private/m23-acceptance") });
  for (const key of ["M20_ACCEPTANCE_SCHEMA", "M21_ACCEPTANCE_SCHEMA", "M22_ACCEPTANCE_SCHEMA", "M23_VERIFICATION_SCHEMA", "M23_ACCEPTANCE_SCHEMA", "M23_ACCEPTANCE_RUN"]) delete env[key];
  if (manifest) {
    if (manifest.database !== target || manifest.schema !== "m23_acceptance_" + manifest.run || !/^[a-f0-9]{32}$/.test(manifest.run)) throw Error("Invalid M23 manifest selection.");
    env.M23_ACCEPTANCE_SCHEMA = manifest.schema; env.M23_ACCEPTANCE_RUN = manifest.run;
    const a = manifest.actors, grant = (key: string, ids: string[]) => { env[key + "_USER_IDS"] = ids.join(","); };
    grant("ORDER_OPERATIONS_VIEW", [a.order.id, a.combined.id, ...(revoked ? [] : [a.revokedOrder.id])]);
    grant("DELIVERY_OPERATIONS_VIEW", [a.delivery.id, a.combined.id, a.rescue.id, a.revokedRescue.id, ...(revoked ? [] : [a.revokedDelivery.id])]);
    grant("DELIVERY_RESCUE", [a.rescue.id, a.rescueOnly.id, ...(revoked ? [] : [a.revokedRescue.id])]);
    grant("MERCHANT_REVIEW_VIEW", [a.legacy.id, a.reviewOnly.id, ...(revoked ? [] : [a.revokedLegacy.id])]);
    for (const key of ["MERCHANT_REVIEW_MANAGE", "MERCHANT_DOCUMENT_VIEW", "DRIVER_REVIEW_VIEW", "DRIVER_REVIEW_MANAGE", "SERVICE_CONFIGURATION_VIEW", "SERVICE_CONFIGURATION_MANAGE"]) grant(key, [a.legacy.id]);
    grant("FINANCIAL_VIEW", [a.finance.id]); grant("NOTIFICATION_OPERATIONS_VIEW", [a.notifications.id]);
  }
  return { env, summary };
}
export function spawnOperationsBackend(manifest: OperationsManifest, revoked = false) {
  const { env, summary } = operationsBackendEnvironment(manifest, revoked);
  console.log("M23 isolated built backend:", JSON.stringify({ ...summary, run: manifest.run, workers: "disabled", revoked }));
  const child = spawn(process.execPath, [require.resolve("@medusajs/cli/cli.js"), "start"], { cwd: resolve(m23Backend, ".medusa/server"), env, stdio: "inherit", windowsHide: true });
  child.on("error", () => console.error("M23 built backend could not start.")); return child;
}
async function browserServer() {
  const { manifest } = loadOperationsSelection();
  if (manifest.api_state !== "VERIFIED") throw Error("Complete the selected direct API acceptance before browser acceptance.");
  const { env } = operationsBackendEnvironment(manifest); operationsSchema(manifest.schema, env);
  await requireM23PortFree();
  const db = knex({ client: "pg", connection: env.DATABASE_URL, searchPath: [manifest.schema, "public"], pool: { min: 0, max: 2 } });
  try {
    assert.ok(await db("m23_acceptance_marker").where({ run: manifest.run, version: 1 }).first());
    for (const name of ["browserRescue", "browserPrivacy"] as const) {
      const c = manifest.cases[name], d = await db("delivery_operation").where({ id: c.delivery }).first();
      assert.ok(d, "Browser fixture missing."); assert.equal(d.generation, c.generation, "Browser rescue consumed; generate a fresh selection.");
      assert.equal(d.revision, c.revision); assert.equal(d.status, "ATTENTION_REQUIRED"); assert.equal(d.reason, c.reason);
      assert.equal(await db("dispatch_commitment").where({ delivery_id: c.delivery }).whereIn("status", ["OFFERED", "ASSIGNED"]).first(), undefined);
      assert.equal(await db("delivery_rescue_command").where({ request_id: c.request_id }).first(), undefined);
      assert.equal(await db("delivery_rescue_command").where({ delivery_id: c.delivery }).first(), undefined);
    }
  } finally { await db.destroy(); }
  const child = spawnOperationsBackend(manifest);
  child.on("exit", code => { process.exitCode = code ?? 1; });
  process.once("SIGINT", () => child.kill("SIGINT")); process.once("SIGTERM", () => child.kill("SIGTERM"));
}
if (require.main === module) void browserServer().catch(error => { console.error(error); process.exitCode = 1; });
