import { createHmac } from "node:crypto";
import { resolve } from "node:path";
export interface SettlementActor {id:string;identity:string;email:string}
export interface SettlementAcceptance {
  version:1;schema:string;actors:Record<"operator"|"viewer"|"preparer"|"approver"|"recorder"|"reconciler"|"owner"|"manager"|"picker"|"foreign"|"customer"|"driver",SettlementActor>;
  manager_member:string;statements:Record<"lifecycle"|"failure"|"merchant"|"foreign"|"api"|"api_duplicate"|"api_disputed",{id:string;payable:string}>;
}
export const settlementManifest=()=>process.env.M20_BROWSER_MANIFEST??resolve(__dirname,"../../../../../test-results/m20-settlements.json");
export function settlementFixturePassword(email:string) {
  const secret=process.env.M20_VERIFY_SECRET;
  if(process.env.APP_ENV!=="test" || !new URL(process.env.DATABASE_URL??"").pathname.endsWith("_test") || !secret || !/^[a-f0-9]{32,128}$/i.test(secret))
    throw new Error("M20 acceptance requires an isolated test database and random test secret.");
  return createHmac("sha256",secret).update(email).digest("hex");
}
export function settlementFixtureSchema(schema:string) {
  if(process.env.APP_ENV!=="test" || process.env.NODE_ENV!=="test" || !new URL(process.env.DATABASE_URL??"").pathname.endsWith("_test")
    || !/^m20_acceptance_[a-f0-9]{32}$/.test(schema)) throw new Error("M20 acceptance scope is test-only.");
  return schema;
}
