import { defineConfig } from "@playwright/test";
import base from "./playwright.m15.config";
export default defineConfig({ ...base, testMatch: ["delivery.spec.ts"], workers: 1 });
