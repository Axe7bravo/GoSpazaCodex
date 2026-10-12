import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Diagnostic subset only. Normal/full-suite server configuration is unchanged.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer];
const merchant = servers.filter((server) => server?.url === "http://localhost:3001/login");
if (merchant.length !== 1 || !merchant[0]) throw new Error("Expected the configured merchant web server.");
export default defineConfig({
  ...base,
  testMatch: "orders.spec.ts",
  grep: /merchant list uses bounded server pages|stale decision refetches|membership loss removes order data/,
  webServer: merchant[0],
});
