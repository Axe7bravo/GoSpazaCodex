import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";

// Only the explicit M18 browser-fixture entry point enables retention. The
// manifest contains synthetic email addresses and resource IDs, never passwords.
const acceptance=new AsyncLocalStorage<string>();
export const retainingBrowserFixture=()=>acceptance.getStore()!==undefined;
export function fixturePassword(email:string) {
  const secret=acceptance.getStore();
  return secret ? createHmac("sha256",secret).update(email).digest("hex"):randomBytes(24).toString("hex");
}
export async function withFinancialBrowserFixture(work:()=>Promise<void>) {
  const secret=process.env.M18_BROWSER_SECRET;
  if(process.env.APP_ENV!=="test" || process.env.M18_C2B_RETAIN_FINANCIAL_FIXTURES!=="true"
    || !secret || !/^[a-f0-9]{32,128}$/i.test(secret)
    || !["localhost","127.0.0.1"].includes(new URL(process.env.BACKEND_URL ?? "").hostname))
    throw new Error("M18 browser fixtures require an isolated loopback test environment, retained financial history and a random test secret.");
  await acceptance.run(secret,work);
}
