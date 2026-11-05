import { z } from "@medusajs/framework/zod";
import { resourceId } from "./team-policy";
import { settlementDecision, settlementConflict,settlementAllowed } from "./merchant-settlement-policy";

export const payoutInstant=z.string().datetime({offset:true}).refine(v=>!/[.]\d{4}/.test(v),"Millisecond precision required.");
// Opaque operational references; never account-number or credential fields.
const reference=z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const transferIdentity=z.object({channel:z.literal("BANK_TRANSFER"),origin_reference:reference,external_transfer_id:reference}).strict();
const observed=z.object({amount_minor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.literal("zar"),
  beneficiary_reference:reference,transferred_at:payoutInstant,...transferIdentity.shape});
export const approveSettlement=settlementDecision;
export const recordPayout=settlementDecision.extend({...observed.shape,evidence_reference:reference.optional()}).strict();
export const recordPayoutFailure=settlementDecision.extend({beneficiary_reference:reference,attempted_at:payoutInstant,
  channel:z.literal("BANK_TRANSFER"),origin_reference:reference,external_transfer_id:reference.optional(),
  failure_category:z.enum(["BANK_REJECTED","RETURNED_BEFORE_RECEIPT","RAIL_CONFIRMED_FAILURE"]),
  nonreceipt_confirmed:z.literal(true),evidence_reference:reference}).strict();
export const retryPayout=settlementDecision.extend({failed_attempt_id:resourceId,review_reference:reference}).strict();
export const reconcilePayout=settlementDecision.extend({receipt_id:resourceId,...observed.shape,review_reference:reference}).strict();
export const payoutDiscrepancy=settlementDecision.extend({category:z.enum(["UNKNOWN_OUTCOME","RETURNED_TRANSFER","BENEFICIARY_MISMATCH",
  "AMOUNT_MISMATCH","TRANSFER_DISPUTE","DUPLICATE_EXTERNAL_RECORD","RECONCILIATION_MISMATCH"]),evidence_reference:reference}).strict();
export type PayoutState="DRAFT"|"READY_FOR_APPROVAL"|"APPROVED"|"FAILED"|"PAID"|"RECONCILED";
export type PayoutAction="APPROVE"|"PAY"|"FAIL"|"RETRY"|"RECONCILE"|"DISCREPANCY";
// Shared by commands and read-only action hints; this preserves C's grant rules.
export function settlementActionAllowed(actor:string,action:PayoutAction|"VIEW"|"EVIDENCE",env:NodeJS.ProcessEnv=process.env) {
  if(action==="VIEW") return settlementAllowed(actor,"VIEW",env);
  if(action==="EVIDENCE") return (["APPROVE","PAYOUT_RECORD","RECONCILE"] as const).some(grant=>settlementAllowed(actor,grant,env));
  if(action==="DISCREPANCY") return settlementAllowed(actor,"PAYOUT_RECORD",env)||settlementAllowed(actor,"RECONCILE",env);
  return settlementAllowed(actor,action==="APPROVE"||action==="RETRY"?"APPROVE":action==="RECONCILE"?"RECONCILE":"PAYOUT_RECORD",env);
}
export const payoutEdges:Readonly<Partial<Record<PayoutAction,readonly [PayoutState,PayoutState]>>>={
  APPROVE:["READY_FOR_APPROVAL","APPROVED"],PAY:["APPROVED","PAID"],FAIL:["APPROVED","FAILED"],
  RETRY:["FAILED","APPROVED"],RECONCILE:["PAID","RECONCILED"],
};
export function payoutNext(state:PayoutState,action:PayoutAction) {
  if(action==="DISCREPANCY") {if(state==="DRAFT") throw settlementConflict();return state;}
  const edge=payoutEdges[action];if(!edge || edge[0]!==state) throw settlementConflict();return edge[1];
}
export function exactPayout(observedAmount:number,approved:string|number,currency:string,expectedCurrency:string) {
  if(!Number.isSafeInteger(observedAmount) || observedAmount<=0 || BigInt(observedAmount)!==BigInt(approved)
    || currency!==expectedCurrency) throw settlementConflict();
}
export function payoutTimeValid(actual:string,approved:string|Date,now:string|Date) {
  const at=new Date(actual).getTime(),approval=new Date(approved).getTime(),current=new Date(now).getTime();
  return [at,approval,current].every(Number.isFinite) && at>=approval && at<=current;
}
