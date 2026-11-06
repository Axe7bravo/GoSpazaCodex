import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment, verifierPath } from "./isolated-verifier";
const args = process.argv.slice(2).filter(value => value !== "--");
if (args.length < 1 || args.length > 2 || args[0] !== "gospaza_m18_c2b_test" || ![undefined, "migrate", "rescue", "dispatch-regression"].includes(args[1])) throw Error("Select gospaza_m18_c2b_test and an approved operations verification action.");
const backend = resolve(__dirname, ".."), file = parseEnv(readFileSync(resolve(backend, ".env"), "utf8"));
const selected = new URL(process.env.DATABASE_URL ?? file.DATABASE_URL ?? "");
if (process.env.DATABASE_URL && selected.pathname !== "/" + args[0]) throw Error("Explicit shell database differs from the requested test database.");
selected.pathname = "/" + args[0];
const { env, summary } = isolatedEnvironment(file, { ...process.env, DATABASE_URL: selected.href });
Object.assign(env, { MEDUSA_WORKER_MODE: "server", DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false",
  NOTIFICATION_EMAIL_ENABLED: "false", NOTIFICATION_WEBHOOK_ENABLED: "false", NOTIFICATION_DELIVERY_WORKER_ENABLED: "false", NOTIFICATION_REPAIR_WORKER_ENABLED: "false" });
const scripts = JSON.parse(readFileSync(resolve(backend, "package.json"), "utf8")).scripts;
console.log("Isolated M23:", JSON.stringify(summary));
const command = args[1] === "migrate" ? ["db:migrate"] : ["exec", verifierPath([args[1] === "rescue" ? "test:dispatch-rescue" : args[1] === "dispatch-regression" ? "test:dispatch-generation" : "test:operations"], scripts)];
const child = spawnSync(process.execPath, [require.resolve("@medusajs/cli/cli.js"), ...command], { cwd: backend, env, stdio: "inherit" });
if (child.error) throw Error("Could not start isolated operations verifier."); process.exitCode = child.status ?? 1;
