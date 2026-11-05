import type { ExecArgs } from "@medusajs/framework/types";
import { MerchantSettlements } from "../lib/merchant-settlement-service";

// Explicit one-merchant/one-period command. Never silently activates a policy.
export default async function repairMerchantSettlements({container}:ExecArgs) {
  const actor=process.env.M20_PREPARER_USER_ID??"";
  const result=await new MerchantSettlements(container).repair(actor,{merchant_id:process.env.M20_MERCHANT_ID,
    store_id:process.env.M20_STORE_ID,policy_id:process.env.M20_POLICY_ID,period_start:process.env.M20_PERIOD_START});
  console.log("M20 generation/repair:",JSON.stringify(result));
}
