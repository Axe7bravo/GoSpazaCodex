import { request } from "@playwright/test";
import type { FullConfig } from "@playwright/test";
import prepareM14 from "./m14-readiness";
export default async function prepare(config: FullConfig) {
  await prepareM14(config);
  const name = config.configFile?.replaceAll("\\", "/").split("/").pop();
  if (name !== "playwright.config.ts" && name !== "playwright.m15.config.ts" && name !== "playwright.m16.config.ts" && name !== "playwright.m17.config.ts") return;
  const client = await request.newContext();
  try {
    const routes = ["http://localhost:3002/", "http://localhost:3001/merchant/orders/order_fixture", "http://localhost:3000/orders/order_fixture"];
    if (name === "playwright.config.ts" || name === "playwright.m17.config.ts") routes.push(
      "http://localhost:3001/merchant/compliance", "http://localhost:3001/merchant/returns",
      "http://localhost:3003/admin/restricted-commerce", "http://localhost:3000/checkout",
      "http://localhost:3001/merchant/products/product_fixture",
    );
    // Full-regression storefront preparation belongs outside the per-file hook
    // budget. Each request still has a bounded timeout and must succeed.
    if (name === "playwright.config.ts") routes.push(...["/", "/stores", "/stores/mstore_first", "/products/prod_tomatoes", "/search"]
      .map(path => "http://localhost:3000" + path));
    if (name === "playwright.config.ts") routes.push(
      "http://localhost:3000/cart", "http://localhost:3000/products/prod_first", "http://localhost:3000/products/prod_second",
      "http://localhost:3001/merchant/orders", "http://localhost:3001/merchant/picking",
      "http://localhost:3001/merchant/picking/order_fixture",
    );
    // Compile all affected documents before collecting their current bundles.
    // Compiling a later route can change a shared dev chunk prepared earlier.
    // This is explicit startup preparation, not a retry of a failed journey.
    for (const url of routes) {
      const response = await client.get(url);
      try {
        if (!response.ok()) throw new Error("Browser document readiness failed: " + url + " HTTP " + response.status());
        await response.body();
      } finally { await response.dispose(); }
    }
    const assets = new Set<string>();
    for (const url of routes) {
      const response = await client.get(url);
      try {
        if (!response.ok()) throw new Error("Browser route readiness failed: " + url + " HTTP " + response.status());
        const html = await response.text();
        for (const match of html.matchAll(/(?:src|href)="([^" ]+)"/g)) {
          const value = match[1]; if (!value) continue;
          const asset = new URL(value.replaceAll("&amp;", "&"), url);
          if (asset.origin === new URL(url).origin && (asset.pathname.startsWith("/_next/static/")
            || asset.pathname.startsWith("/__nextjs_font/"))) assets.add(asset.href);
        }
      } finally { await response.dispose(); }
    }
    // These same-origin dev font URLs were pending in the failed navigation
    // traces. Fetch them outside journey/setup-hook budgets as well.
    if (name === "playwright.config.ts") {
      assets.add("http://localhost:3000/__nextjs_font/geist-latin.woff2");
      assets.add("http://localhost:3001/__nextjs_font/geist-latin.woff2");
    }
    for (const asset of assets) {
      const bundle = await client.get(asset);
      try {
        if (!bundle.ok()) throw new Error("Browser bundle readiness failed: " + asset + " HTTP " + bundle.status());
        await bundle.body();
      } finally { await bundle.dispose(); }
    }
  } finally { await client.dispose(); }
}
