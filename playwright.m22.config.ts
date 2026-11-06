import { defineConfig } from "@playwright/test";
import { loadNotificationSelection } from "./apps/backend/src/scripts/fixtures/notification-acceptance";
const { manifest: fixture } = loadNotificationSelection();
if (fixture.api_state !== "VERIFIED") throw Error("Run the selected M22 direct API acceptance successfully before browser acceptance.");
export default defineConfig({ testDir: "./tests/acceptance/m22", workers: 1, retries: 0, maxFailures: 1,
  timeout: 180000, expect: { timeout: 15000 }, outputDir: "test-results/m22-browser",
  use: { browserName: "chromium", timezoneId: "Africa/Johannesburg", trace: "off", video: "off", screenshot: "off" },
  webServer: [["customer", 3000], ["driver", 3002], ["admin", 3003]].map(([app, port]) => ({ command: "pnpm --filter @gospaza/" + app + " run dev",
    url: "http://localhost:" + port + "/login", timeout: 120000, reuseExistingServer: false,
    env: { NEXT_PUBLIC_API_URL: "http://localhost:9000", NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: fixture.publishable_key, M22_ACCEPTANCE_SELECTION: "" } })),
});
