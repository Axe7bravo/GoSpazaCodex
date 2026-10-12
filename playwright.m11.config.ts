import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// M11 Orders and its M10 checkout regression require customer and merchant only.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer];
const required = servers.filter((server): server is NonNullable<typeof server> => server !== undefined
  && ["http://localhost:3000/login", "http://localhost:3001/login"].includes(server.url ?? ""));
if (required.length !== 2) throw new Error("Expected customer and merchant browser servers.");
export default defineConfig({
  ...base,
  testMatch: ["orders.spec.ts", "checkout.spec.ts"],
  webServer: required,
});
