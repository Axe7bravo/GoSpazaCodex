import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment } from "./isolated-verifier";
import type { DriverFinanceManifest } from "../src/scripts/fixtures/driver-finance-acceptance";
const backend = resolve(__dirname, "..");
const { env, summary } = isolatedEnvironment(parseEnv(readFileSync(resolve(backend, ".env"), "utf8")), process.env);
if (!env.M21_BROWSER_MANIFEST) throw new Error("Select the fresh M21_BROWSER_MANIFEST.");
const f = JSON.parse(readFileSync(resolve(env.M21_BROWSER_MANIFEST), "utf8")) as DriverFinanceManifest;
if (f.version !== 1 || !/^m21_acceptance_[a-f0-9]{32}$/.test(f.schema)) throw new Error("Invalid M21 manifest.");
const a = f.actors;
Object.assign(env, { M21_ACCEPTANCE_SCHEMA: f.schema, DRIVER_EARNINGS_VIEW_USER_IDS: [a.operator.id, a.viewer.id].join(","),
  DRIVER_COMPENSATION_MANAGE_USER_IDS: [a.operator.id, a.manager.id].join(","), DRIVER_PAYMENT_RECORD_USER_IDS: [a.operator.id, a.recorder.id].join(","),
  DRIVER_PAYMENT_RECONCILE_USER_IDS: [a.operator.id, a.reconciler.id].join(","), DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false" });
delete env.M20_ACCEPTANCE_SCHEMA; delete env.M21_VERIFY_SECRET;
console.log("M21 isolated built backend:", summary);
const child = spawnSync(process.execPath, [require.resolve("@medusajs/cli/cli.js"), "start"], { cwd: resolve(backend, ".medusa/server"), env, stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
