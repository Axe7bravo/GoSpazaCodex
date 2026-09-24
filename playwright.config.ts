import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { browserName: "chromium", trace: "retain-on-failure" },
  webServer: ["customer", "merchant", "driver", "admin"].map((app, index) => ({
    command: "pnpm --filter @gospaza/" + app + " run dev",
    url: "http://localhost:" + (3000 + index) + "/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  })),
});

