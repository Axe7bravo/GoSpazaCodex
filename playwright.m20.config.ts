import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
if(process.env.APP_ENV!=="test" || !process.env.M20_BROWSER_MANIFEST || !process.env.M20_VERIFY_SECRET)
  throw new Error("Select the isolated M20 manifest and test secret.");
const fixture=JSON.parse(readFileSync(process.env.M20_BROWSER_MANIFEST,"utf8"));
if(fixture.version!==1 || fixture.api_verified!==true) throw new Error("Run M20 direct API acceptance successfully before browser acceptance.");
export default defineConfig({testDir:"./tests/acceptance/m20",workers:1,retries:0,maxFailures:1,timeout:180000,expect:{timeout:15000},
  outputDir:"test-results/m20-browser",use:{browserName:"chromium",timezoneId:"Africa/Johannesburg",trace:"off",video:"off",screenshot:"off"},
  webServer:[["admin",3003],["merchant",3001]].map(([app,port])=>({command:"pnpm --filter @gospaza/"+app+" run dev",
    url:"http://localhost:"+port+"/login",timeout:120000,reuseExistingServer:false,
    env:{NEXT_PUBLIC_API_URL:"http://localhost:9000",M20_VERIFY_SECRET:""}}))});
