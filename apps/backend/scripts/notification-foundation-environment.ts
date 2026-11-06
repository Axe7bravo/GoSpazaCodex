import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment, verifierPath } from "./isolated-verifier";

// Thin explicit-database selector around the existing isolation guards. No new
// isolation policy, database creation, .env writes, server startup or shell.
const args = process.argv.slice(2).filter(value => value !== "--");
const [mode, database] = args;
if (args.length !== 2 || !["migrate", "verify", "verify-mappings", "verify-runtime", "fixtures", "verify-surfaces"].includes(mode ?? "") || !database || !/^[A-Za-z0-9_-]+_test$/.test(database))
  throw Error("Choose a notification migrate/verify/fixtures/verify-surfaces mode and an existing explicit _test database name.");
const backend = resolve(__dirname, "..");
const file = parseEnv(readFileSync(resolve(backend, ".env"), "utf8"));
let selected: URL;
try { selected = new URL(process.env.DATABASE_URL ?? file.DATABASE_URL ?? ""); }
catch { throw Error("A valid PostgreSQL connection configuration is required."); }
if (process.env.DATABASE_URL && selected.pathname !== "/" + database)
  throw Error("Explicit shell DATABASE_URL differs from the requested test database; select it deliberately.");
selected.pathname = "/" + database;
const { env, summary } = isolatedEnvironment(file, { ...process.env, DATABASE_URL: selected.href });
Object.assign(env, { DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false", NOTIFICATION_EMAIL_ENABLED: "false",
  NOTIFICATION_DELIVERY_WORKER_ENABLED: "false", NOTIFICATION_REPAIR_WORKER_ENABLED: "false", NOTIFICATION_WEBHOOK_ENABLED: "false" });
const scripts = JSON.parse(readFileSync(resolve(backend, "package.json"), "utf8")).scripts;
const command = mode === "migrate" ? ["db:migrate"] : ["exec", verifierPath([mode === "fixtures" ? "test:notification-fixtures" : mode === "verify-surfaces" ? "test:notification-surfaces"
  : mode === "verify-runtime" ? "test:notification-runtime" : mode === "verify-mappings" ? "test:notification-mappings" : "test:notification-foundation"], scripts)];
console.log("Isolated notification foundation:", JSON.stringify({ ...summary,
  NOTIFICATION_DELIVERY_WORKER_ENABLED: env.NOTIFICATION_DELIVERY_WORKER_ENABLED,
  NOTIFICATION_REPAIR_WORKER_ENABLED: env.NOTIFICATION_REPAIR_WORKER_ENABLED,
  NOTIFICATION_WEBHOOK_ENABLED: env.NOTIFICATION_WEBHOOK_ENABLED }));
const child = spawnSync(process.execPath, [require.resolve("@medusajs/cli/cli.js"), ...command], { cwd: backend, env, stdio: "inherit" });
if (child.error) throw Error("Could not start isolated notification verification.");
process.exitCode = child.status ?? 1;
