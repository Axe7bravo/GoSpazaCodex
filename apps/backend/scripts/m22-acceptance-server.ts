import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { isolatedEnvironment } from "./isolated-verifier";
import { loadNotificationSelection, type NotificationManifest } from "../src/scripts/fixtures/notification-acceptance";
export const m22Backend = resolve(__dirname, "..");
export function notificationBackendEnvironment(fixture: NotificationManifest, revokedOps = false) {
  const file = parseEnv(readFileSync(resolve(m22Backend, ".env"), "utf8"));
  const selected = new URL(process.env.DATABASE_URL ?? file.DATABASE_URL ?? "");
  if (process.env.DATABASE_URL && selected.pathname !== "/" + fixture.database) throw Error("Shell DATABASE_URL differs from the selected M22 test database.");
  selected.pathname = "/" + fixture.database;
  const { env, summary } = isolatedEnvironment(file, { ...process.env, DATABASE_URL: selected.href });
  Object.assign(env, { M22_ACCEPTANCE_SCHEMA: fixture.schema, M22_ACCEPTANCE_RUN: fixture.run, PORT: "9000",
    NOTIFICATION_OPERATIONS_VIEW_USER_IDS: revokedOps ? fixture.actors.operator.id : [fixture.actors.operator.id, fixture.actors.apiOperator.id].join(","),
    FINANCIAL_VIEW_USER_IDS: fixture.actors.financeOnly.id, NOTIFICATION_EMAIL_ENABLED: "false", NOTIFICATION_WEBHOOK_ENABLED: "false",
    NOTIFICATION_DELIVERY_WORKER_ENABLED: "false", NOTIFICATION_REPAIR_WORKER_ENABLED: "false", DISPATCH_WORKER_ENABLED: "false", PICKUP_WORKER_ENABLED: "false", HANDOFF_WORKER_ENABLED: "false" });
  delete env.M20_ACCEPTANCE_SCHEMA; delete env.M21_ACCEPTANCE_SCHEMA;
  return { env, summary };
}
export function spawnNotificationBackend(fixture: NotificationManifest, revokedOps = false) {
  const { env, summary } = notificationBackendEnvironment(fixture, revokedOps);
  // Same explicit selection, no fallback database and no medusa develop.
  if (!/^m22_acceptance_[a-f0-9]{32}$/.test(fixture.schema)) throw Error("Invalid M22 schema.");
  console.log("M22 isolated built backend:", JSON.stringify({ ...summary, run: fixture.run, notification_workers: "disabled" }));
  const child = spawn(process.execPath, [require.resolve("@medusajs/cli/cli.js"), "start"], { cwd: resolve(m22Backend, ".medusa/server"), env, stdio: "inherit", windowsHide: true });
  child.on("error", () => console.error("M22 built backend could not start."));
  return child;
}
if (require.main === module) {
  const { manifest } = loadNotificationSelection();
  const selected = notificationBackendEnvironment(manifest);
  // Validate using the child environment without changing the parent/global env.
  if (selected.env.APP_ENV !== "test" || !new URL(selected.env.DATABASE_URL ?? "").pathname.endsWith("_test")) throw Error("Isolated backend required.");
  // The middleware repeats schema validation in the actual backend process.
  const child = spawnNotificationBackend(manifest);
  child.on("error", () => { console.error("M22 backend could not start."); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  process.once("SIGINT", () => child.kill("SIGINT")); process.once("SIGTERM", () => child.kill("SIGTERM"));
}
