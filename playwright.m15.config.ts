import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base, testMatch: ["dispatch.spec.ts"], workers: 1,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).filter(server =>
    ["http://localhost:3000/login", "http://localhost:3001/login", "http://localhost:3002/login"].includes(server.url ?? "")),
});
