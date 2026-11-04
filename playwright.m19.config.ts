import { defineConfig } from "@playwright/test";
if(process.env.APP_ENV!=="test" || !process.env.M19_BROWSER_MANIFEST || !process.env.M19_VERIFY_SECRET)
  throw new Error("Select the isolated M19 acceptance manifest and test secret.");
export default defineConfig({
  testDir:"./tests/acceptance/m19",workers:1,retries:0,maxFailures:1,timeout:180000,expect:{timeout:15000},
  outputDir:"test-results/m19-browser",use:{browserName:"chromium",trace:"off",video:"off",screenshot:"off"},
  webServer:[["admin",3003],["merchant",3001]].map(([app,port])=>({
    command:"pnpm --filter @gospaza/"+app+" run dev",url:"http://localhost:"+port+"/login",timeout:120000,reuseExistingServer:false,
    env:{NEXT_PUBLIC_API_URL:"http://localhost:9000",M19_VERIFY_SECRET:""},
  })),
});
