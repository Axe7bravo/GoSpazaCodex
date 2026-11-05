import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment } from "./isolated-verifier";

// Small companion to test:isolated for this verifier's existing built-backend
// prerequisite. It creates no database, writes no env file and starts no develop server.
const backend = resolve(__dirname, "..");
const mode = process.argv[2];
if (mode !== "migrate" && mode !== "start") throw new Error("Choose migrate or start.");
const { env, summary } = isolatedEnvironment(parseEnv(readFileSync(resolve(backend, ".env"), "utf8")), process.env);
Object.assign(env, { DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false" });
delete env.M20_ACCEPTANCE_SCHEMA;
console.log("M21 isolated backend:", summary);
const child = spawnSync(process.execPath, [require.resolve("@medusajs/cli/cli.js"), mode === "migrate" ? "db:migrate" : "start"],
  { cwd: mode === "migrate" ? backend : resolve(backend, ".medusa/server"), env, stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
