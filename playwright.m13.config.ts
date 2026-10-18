import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["shortages.spec.ts", "picking.spec.ts", "orders.spec.ts"],
  workers: 1,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).filter((server) =>
    server.url === "http://localhost:3000/login" || server.url === "http://localhost:3001/login"),
});
