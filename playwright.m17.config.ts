import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
// M17 exercises all four actor apps; the shared config owns their readiness.
export default defineConfig({ ...base, testMatch: ["restricted.spec.ts"], workers: 1 });
