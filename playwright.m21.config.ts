import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
if (process.env.APP_ENV !== "test" || !process.env.M21_BROWSER_MANIFEST || !process.env.M21_VERIFY_SECRET)
  throw new Error("Select the isolated M21 manifest and test credential seed.");
const fixture = JSON.parse(readFileSync(process.env.M21_BROWSER_MANIFEST, "utf8"));
if (fixture.version !== 1 || fixture.api_verified !== true) throw new Error("Run M21 direct API acceptance successfully first.");
export default defineConfig({ testDir: "./tests/acceptance/m21", workers: 1, retries: 0, maxFailures: 1,
  timeout: 180000, expect: { timeout: 15000 }, outputDir: "test-results/m21-browser",
  use: { browserName: "chromium", timezoneId: "Africa/Johannesburg", trace: "off", video: "off", screenshot: "off" },
  webServer: [["driver", 3002], ["admin", 3003]].map(([app, port]) => ({ command: "pnpm --filter @gospaza/" + app + " run dev",
    url: "http://localhost:" + port + "/login", timeout: 120000, reuseExistingServer: false,
    env: { NEXT_PUBLIC_API_URL: "http://localhost:9000", M21_VERIFY_SECRET: "", M21_BROWSER_MANIFEST: "" } })),
});
