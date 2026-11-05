import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";

export const SETTLEMENT_POLICY = "M20_B_V1";
export const SETTLEMENT_TIMEZONE = "Africa/Johannesburg";
export const settlementConflict = () => new MedusaError(MedusaError.Types.CONFLICT,
  "Settlement evidence or revision changed.", "SETTLEMENT_CONFLICT");
export function settlementAllowed(actor: string, action: "VIEW"|"PREPARE"|"APPROVE"|"PAYOUT_RECORD"|"RECONCILE", env: NodeJS.ProcessEnv = process.env) {
  return !!actor && (env[`SETTLEMENT_${action}_USER_IDS`] ?? "").split(",").map(x=>x.trim()).includes(actor);
}
const instant = z.string().datetime({offset:true}).refine(value=>!/[.]\d{4}/.test(value),"Millisecond precision required.");
export const settlementGeneration = z.object({merchant_id:resourceId,store_id:resourceId,
  period_start:instant,policy_id:resourceId}).strict();
export const settlementDecision = z.object({request_id:resourceId,expected_revision:z.number().int().min(1).max(2147483646),
  confirmed:z.literal(true),reason:z.string().trim().min(1).max(240)}).strict();
export const settlementActivation = z.object({id:resourceId,activation_at:instant,confirmed:z.literal(true),
  reason:z.string().trim().min(1).max(240)}).strict();

// Signed values are intentional. Native M19 sources are currently nonnegative;
// this arithmetic does not authorize a new economic source or manual debit.
export function settlementAmounts(effects: readonly (string|number|bigint)[], incoming: string|number|bigint = 0) {
  const integer = (v:string|number|bigint) => {
    if(typeof v === "number" && !Number.isSafeInteger(v) || !/^-?\d+$/.test(String(v))) throw settlementConflict();
    return BigInt(v);
  };
  const carry=integer(incoming);
  if(carry>0n) throw settlementConflict();
  const current=effects.reduce<bigint>((sum,v)=>sum+integer(v),0n),net=current+carry;
  const safe=(v:bigint)=>{const n=Number(v);if(!Number.isSafeInteger(n)) throw settlementConflict();return n;};
  return {current_effects_minor:safe(current),incoming_carry_minor:safe(carry),net_minor:safe(net),
    payable_minor:safe(net>0n?net:0n),outgoing_carry_minor:safe(net<0n?net:0n)};
}
