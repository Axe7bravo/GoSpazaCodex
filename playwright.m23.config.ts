import { defineConfig } from "@playwright/test";
import { loadOperationsSelection } from "./apps/backend/src/scripts/fixtures/operations-acceptance";
const { manifest } = loadOperationsSelection();
if (manifest.api_state !== "VERIFIED") throw Error("Complete selected M23 direct API acceptance before browser acceptance.");
export default defineConfig({ testDir: "./tests/acceptance/m23", workers: 1, retries: 0, maxFailures: 1,
  timeout: 180000, expect: { timeout: 15000 }, outputDir: "test-results/m23-browser",
  use: { browserName: "chromium", timezoneId: "Africa/Johannesburg", trace: "off", video: "off", screenshot: "off" },
  webServer: { command: "pnpm --filter @gospaza/admin run dev", url: "http://localhost:3003/login", timeout: 120000, reuseExistingServer: false,
    env: { NEXT_PUBLIC_API_URL: "http://localhost:9000" } },
});
