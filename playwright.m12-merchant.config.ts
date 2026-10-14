import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer];
const merchant = servers.filter((server) => server?.url === "http://localhost:3001/login");
if (merchant.length !== 1 || !merchant[0]) throw new Error("Expected the configured merchant web server.");
export default defineConfig({ ...base, testMatch: "picking.spec.ts", workers: 1, webServer: merchant[0] });
