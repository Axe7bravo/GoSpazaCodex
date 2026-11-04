import { z } from "@medusajs/framework/zod";
import { commissionAt } from "./commission-policy";
import { safeSum, unitShare } from "./financial-policy";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const line = z.object({ id:z.string(), quantity:minor.positive(), net_minor:minor, tax_minor:minor,
  subsidy_minor:minor.optional() });
export const recognitionEvidence = z.object({
  native_economics_fingerprint:z.string().min(1), lines:z.array(line).min(1),
  components:z.object({merchandise_net_minor:minor, merchandise_tax_minor:minor, platform_subsidy_minor:minor}),
  basis_minor:minor,
});
export const adjustmentAllocations=z.array(z.object({
  component:z.enum(["MERCHANDISE","TAX","DELIVERY_FEE","GOODWILL"]), economic_key:z.string(),
  start_unit:minor,end_unit:minor,amount_minor:minor,
}));
export class RecognitionConflict extends Error {
  constructor(readonly reason:"RECOGNITION_EVIDENCE_MISMATCH"|"UNRESOLVED_ADJUSTMENT_ATTRIBUTION"|"POSTING_SOURCE_CONFLICT"){
    super(reason);
  }
}
export interface UnitRange { line:string; start:number; end:number }
export type FrozenRecognition=z.infer<typeof recognitionEvidence>;
type Manifest=readonly {id:string;quantity:number}[];
function requireEvidence(value:unknown):asserts value {
  if(!value) throw new RecognitionConflict("RECOGNITION_EVIDENCE_MISMATCH");
}
function effects(merchandise:number,tax:number,subsidy:number,commission:number) {
  return {merchandise_minor:merchandise,tax_minor:tax,subsidy_minor:subsidy,commission_minor:commission,
    entitlement_minor:merchandise+subsidy-commission};
}
function valueOfRanges(e:FrozenRecognition,ranges:UnitRange[]) {
  const merchandise:number[]=[],tax:number[]=[],subsidies:number[]=[];
  for(const range of ranges) {
    const item=e.lines.find(l=>l.id===range.line);
    requireEvidence(item && range.start>=0 && range.start<range.end && range.end<=item.quantity);
    merchandise.push(unitShare(item.net_minor,item.quantity,range.start,range.end));
    tax.push(unitShare(item.tax_minor,item.quantity,range.start,range.end));
    subsidies.push(unitShare(item.subsidy_minor??0,item.quantity,range.start,range.end));
  }
  return {merchandise:safeSum(merchandise),tax:safeSum(tax),subsidy:safeSum(subsidies)};
}
export function recognizeManifest(e:FrozenRecognition,manifest:Manifest,bps:number) {
  requireEvidence(manifest.length && new Set(manifest.map(x=>x.id)).size===manifest.length
    && new Set(e.lines.map(x=>x.id)).size===e.lines.length);
  requireEvidence(safeSum(e.lines.map(x=>x.net_minor))===e.components.merchandise_net_minor
    && safeSum(e.lines.map(x=>x.tax_minor))===e.components.merchandise_tax_minor
    && safeSum([e.components.merchandise_net_minor,e.components.platform_subsidy_minor])===e.basis_minor);
  const ranges=manifest.map(x=>({line:x.id,start:0,end:x.quantity})).sort((a,b)=>a.line.localeCompare(b.line));
  // Aggregate subsidy is sufficient for a full sale. Partial recognition or
  // reversal needs immutable line allocation evidence; never prorate by guess.
  const full=ranges.length===e.lines.length && ranges.every(r=>e.lines.find(l=>l.id===r.line)?.quantity===r.end);
  const allocated=safeSum(e.lines.map(x=>x.subsidy_minor??0));
  if(allocated!==e.components.platform_subsidy_minor && (!full || allocated!==0))
    throw new RecognitionConflict("UNRESOLVED_ADJUSTMENT_ATTRIBUTION");
  const v=valueOfRanges(e,ranges),subsidy=full?e.components.platform_subsidy_minor:v.subsidy;
  const basis=safeSum([v.merchandise,subsidy]);
  return {ranges,basis,effects:effects(v.merchandise,v.tax,subsidy,commissionAt(basis,bps))};
}
