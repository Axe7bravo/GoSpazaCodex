import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

if(process.env.APP_ENV!=="test" || !process.env.M18_BROWSER_MANIFEST || !process.env.M18_BROWSER_SECRET)
  throw new Error("Prepare the isolated M18 financial dataset and select its manifest first.");
const fixture=JSON.parse(readFileSync(process.env.M18_BROWSER_MANIFEST,"utf8"));
if(fixture.version!==1 || !fixture.key) throw new Error("Invalid financial browser manifest.");
export default defineConfig({
  testDir:"./tests/acceptance/m18",workers:1,fullyParallel:false,retries:0,maxFailures:1,
  timeout:180000,expect:{timeout:15000},outputDir:"test-results/m18-browser",
  use:{browserName:"chromium",trace:"off",screenshot:"off",video:"off"},
  webServer:[["customer",3000],["merchant",3001],["admin",3003]].map(([app,port])=>({
    command:"pnpm --filter @gospaza/"+app+" run dev",url:"http://localhost:"+port+"/login",reuseExistingServer:false,
    env:{NEXT_PUBLIC_API_URL:"http://localhost:9000",NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:fixture.key,M18_BROWSER_SECRET:""},
    timeout:120000,
  })),
});
