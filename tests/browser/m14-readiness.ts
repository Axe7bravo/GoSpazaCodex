import { request } from "@playwright/test";
import type { FullConfig } from "@playwright/test";

// Compile M14 documents and their browser bundles before starting journey budgets.
// This context has no authentication or shared test fixture state.
export default async function prepareM14(config: FullConfig) {
  // Other milestone configurations inherit base settings but may start fewer apps.
  // Keep this preparation scoped to the two configurations that run M14 journeys.
  const configName = config.configFile?.replaceAll("\\", "/").split("/").pop();
  if (configName !== "playwright.config.ts" && configName !== "playwright.m14.config.ts") return;
  const client = await request.newContext();
  try {
    const routes = [
      "http://localhost:3002/", "http://localhost:3002/login", "http://localhost:3002/register",
      "http://localhost:3001/merchant/drivers", "http://localhost:3001/merchant/drivers/daff_fixture",
      "http://localhost:3001/application", "http://localhost:3003/admin/drivers",
      "http://localhost:3003/admin/drivers/drv_fixture",
    ];
    const assets = new Set<string>();
    for (const url of routes) {
      const response = await client.get(url);
      try {
        if (!response.ok()) throw new Error("M14 route readiness failed: " + url + " HTTP " + response.status());
        const html = await response.text();
        for (const match of html.matchAll(/(?:src|href)="([^" ]+)"/g)) {
          const reference = match[1];
          if (!reference) continue;
          const asset = new URL(reference.replaceAll("&amp;", "&"), url);
          if (asset.origin === new URL(url).origin && asset.pathname.startsWith("/_next/static/")) assets.add(asset.href);
        }
      } finally { await response.dispose(); }
    }
    for (const url of assets) {
      const response = await client.get(url);
      try {
        if (!response.ok()) throw new Error("M14 bundle readiness failed: " + url + " HTTP " + response.status());
        await response.body();
      } finally { await response.dispose(); }
    }
  } finally { await client.dispose(); }
}
