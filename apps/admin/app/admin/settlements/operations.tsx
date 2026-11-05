"use client";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { platformSettlements } from "@gospaza/api-client";
import type { PlatformSettlementDetail, SettlementAction, SettlementDecisionInput, SettlementEvidence,
  RecordSettlementPayout, RecordSettlementFailure, RetrySettlement, ReconcileSettlement } from "@gospaza/contracts";
import { settlementMoney,settlementPeriod } from "@gospaza/ui/settlements";
import { orderTime } from "@gospaza/ui/orders";
const client=platformSettlements(process.env.NEXT_PUBLIC_API_URL!);
export const operationLabels:Record<SettlementAction,string>={PREPARE:"Prepare statement",SUPERSEDE:"Supersede draft",APPROVE:"Approve settlement",
  PAY:"Record external transfer",FAIL:"Record failed transfer attempt",RETRY:"Authorize payout retry",RECONCILE:"Reconcile recorded payout"};
export type ReviewedOperation={action:"PREPARE"|"SUPERSEDE"|"APPROVE";body:SettlementDecisionInput}
  |{action:"PAY";body:RecordSettlementPayout}|{action:"FAIL";body:RecordSettlementFailure}
  |{action:"RETRY";body:RetrySettlement}|{action:"RECONCILE";body:ReconcileSettlement};
const text=(form:FormData,key:string)=>String(form.get(key)??"").trim();
function observed(form:FormData) {const raw=text(form,"amount");if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<=0) throw new Error("Enter an observed amount in whole ZAR cents.");return Number(raw);}
function instant(form:FormData) {const raw=text(form,"time"),date=new Date(raw);if(!raw||!Number.isFinite(date.getTime())) throw new Error("Enter the actual transfer date and time.");return date.toISOString();}
export function SettlementOperations({detail,write,busy}:{detail:PlatformSettlementDetail;write:(draft:ReviewedOperation)=>Promise<void>;busy:boolean}) {
  const [action,choose]=useState<SettlementAction|null>(null),[draft,setDraft]=useState<ReviewedOperation|null>(null);
  const [evidence,setEvidence]=useState<SettlementEvidence|null>(null),[message,notify]=useState(""),[reading,setReading]=useState(false);
  const choosing=useRef(false);
  async function select(next:SettlementAction) {
    if(choosing.current||busy) return;choosing.current=true;choose(next);setDraft(null);setEvidence(null);notify("");
    if((next==="RETRY"||next==="RECONCILE") && detail.statement.payable_id) {
      setReading(true);try {setEvidence(await client.evidence(detail.statement.payable_id));} catch {notify("Required payout evidence is unavailable. Refresh access before continuing.");}
      finally {setReading(false);}
    }
    choosing.current=false;
  }
  function review(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!action||!detail.actions.includes(action)||busy||reading) return;
    try {
      const form=new FormData(event.currentTarget),reason=text(form,"reason");
      if(!reason||form.get("confirmed")!=="on") throw new Error("A reason and explicit confirmation are required.");
      const base:SettlementDecisionInput={reason,confirmed:true,request_id:crypto.randomUUID(),expected_revision:
        action==="PREPARE"||action==="SUPERSEDE"?detail.statement_revision:detail.payable_revision??0};
      if(action==="PREPARE"||action==="SUPERSEDE"||action==="APPROVE") setDraft({action,body:base});
      else if(action==="PAY") setDraft({action,body:{...base,amount_minor:observed(form),currency:"zar",channel:"BANK_TRANSFER",
        beneficiary_reference:text(form,"beneficiary"),origin_reference:text(form,"origin"),external_transfer_id:text(form,"external"),
        transferred_at:instant(form),...(text(form,"evidence")?{evidence_reference:text(form,"evidence")}: {})}});
      else if(action==="FAIL") {
        const category=text(form,"category");
        if(!["BANK_REJECTED","RETURNED_BEFORE_RECEIPT","RAIL_CONFIRMED_FAILURE"].includes(category)||form.get("nonreceipt")!=="on") throw new Error("Confirm actual attempted transfer and proven beneficiary nonreceipt.");
        setDraft({action,body:{...base,channel:"BANK_TRANSFER",beneficiary_reference:text(form,"beneficiary"),origin_reference:text(form,"origin"),
          ...(text(form,"external")?{external_transfer_id:text(form,"external")}:{}),attempted_at:instant(form),nonreceipt_confirmed:true,
          failure_category:category as RecordSettlementFailure["failure_category"],evidence_reference:text(form,"evidence")}});
      } else if(action==="RETRY") {
        const failures=evidence?.failures??[],failure=failures[failures.length-1];if(!failure) throw new Error("Read the prior failed attempt before reviewing a retry.");
        setDraft({action,body:{...base,failed_attempt_id:failure.id,review_reference:text(form,"review")}});
      } else {
        const receipt=evidence?.receipt;if(!receipt) throw new Error("Read the successful payout receipt before reconciliation.");
        const amount=Number(receipt.amount_minor);if(!Number.isSafeInteger(amount)) throw new Error("Recorded amount is unavailable.");
        setDraft({action,body:{...base,receipt_id:receipt.id,amount_minor:amount,currency:receipt.currency,channel:receipt.channel,
          beneficiary_reference:receipt.beneficiary_reference,origin_reference:receipt.origin_reference,external_transfer_id:receipt.external_transfer_id,
          transferred_at:receipt.transferred_at,review_reference:text(form,"review")}});
      }
      notify("");
    } catch(error) {notify(error instanceof Error?error.message:"Check the required fields.");}
  }
  return <section aria-label="Settlement operations"><h2>Settlement operations</h2>
    {!detail.actions.length && <p>No settlement operation is available for your grants and the current state.</p>}
    {!action && detail.actions.map(a=><button key={a} disabled={busy} onClick={()=>void select(a)}>{operationLabels[a]}</button>)}
    {reading && <p role="status">Loading restricted payout evidence…</p>}
    {action && <><h3>{operationLabels[action]}</h3>
      {action==="PAY" && <p>This records an already-performed external bank transfer. GoSpaza does not send money.</p>}
      {action==="FAIL" && <p>A transfer must actually have been attempted with evidence of beneficiary nonreceipt. Unknown outcomes, timeouts and cancelled forms are not failed transfers.</p>}
      {action==="RECONCILE" && <p>Review and match the recorded payout evidence. Reconciliation does not send money.</p>}
      <p>Store: {detail.statement.store_name} · Period: {settlementPeriod(detail.statement)}</p>
      <p>Authoritative payable: {detail.statement.payable_id?settlementMoney(detail.statement.payable_minor)+" ZAR":"No payout created"} · Held sources: {detail.statement.excluded_count} · Tax held: {settlementMoney(detail.statement.tax_held_minor)}</p>
      {evidence?.failures.map(f=><article key={f.id}><h4>Prior failed attempt</h4><p>{f.failure_category.replaceAll("_"," ")} · {orderTime(f.attempted_at)}</p>
        <p>Beneficiary reference: {f.beneficiary_reference} · Evidence: {f.evidence_reference}</p></article>)}
      {evidence?.receipt && <section aria-label="Payout evidence"><h4>Recorded payout evidence</h4><dl>
        <dt>Recorded amount</dt><dd>{settlementMoney(evidence.receipt.amount_minor)} {evidence.receipt.currency.toUpperCase()}</dd>
        <dt>Verified beneficiary reference</dt><dd>{evidence.receipt.beneficiary_reference}</dd><dt>Transfer channel</dt><dd>{evidence.receipt.channel}</dd>
        <dt>Originating channel/account reference</dt><dd>{evidence.receipt.origin_reference}</dd><dt>External transfer ID</dt><dd>{evidence.receipt.external_transfer_id}</dd>
        <dt>Actual transfer date</dt><dd>{orderTime(evidence.receipt.transferred_at)}</dd></dl><p>No unresolved payment discrepancy is shown by the current statement read.</p></section>}
      {draft?<section aria-label="Review settlement operation"><h3>Review {operationLabels[draft.action].toLowerCase()}</h3><p>Reason: {draft.body.reason}</p>
        {draft.action==="PAY" && <p>Observed amount: {settlementMoney(String(draft.body.amount_minor))} · External transfer ID: {draft.body.external_transfer_id} · {orderTime(draft.body.transferred_at)}</p>}
        {draft.action==="FAIL" && <p>Proven failed attempt: {draft.body.failure_category.replaceAll("_"," ")}</p>}
        <button disabled={busy} onClick={()=>{const reviewed=draft;setDraft(null);choose(null);setEvidence(null);void write(reviewed);}}>Confirm {operationLabels[draft.action].toLowerCase()}</button>
        <button disabled={busy} onClick={()=>setDraft(null)}>Back to evidence</button></section>:
        <form onSubmit={review}><fieldset disabled={busy||reading||((action==="RETRY"||action==="RECONCILE")&&!evidence)}>
          {(action==="PAY"||action==="FAIL") && <>
            {action==="PAY" && <label>Observed amount in ZAR cents <input name="amount" inputMode="numeric" pattern="[0-9]+" required/></label>}
            <p>Currency: ZAR · Transfer channel: bank transfer</p>
            <label>Verified beneficiary reference <input name="beneficiary" required maxLength={120}/></label>
            <label>Originating channel/account reference <input name="origin" required maxLength={120}/></label>
            <label>External transfer ID{action==="FAIL"?" (if available)":""} <input name="external" required={action==="PAY"} maxLength={120}/></label>
            <label>Actual transfer local date and time <input name="time" type="datetime-local" step="0.001" required/></label>
            <label>Evidence reference{action==="PAY"?" (optional)":""} <input name="evidence" required={action==="FAIL"} maxLength={120}/></label>
            {action==="FAIL" && <><label>Failure category <select name="category"><option value="BANK_REJECTED">Bank rejected transfer</option>
              <option value="RETURNED_BEFORE_RECEIPT">Returned before beneficiary receipt</option><option value="RAIL_CONFIRMED_FAILURE">Payment rail confirmed failure</option></select></label>
              <label><input name="nonreceipt" type="checkbox" required/>An external transfer was attempted and evidence confirms beneficiary nonreceipt.</label></>}
          </>}
          {(action==="RETRY"||action==="RECONCILE") && <label>Review reference <input name="review" required maxLength={120}/></label>}
          <label>Reason <textarea name="reason" required maxLength={240}/></label>
          <label><input name="confirmed" type="checkbox" required/>I reviewed this statement and the required evidence for this operation.</label>
          <button>Review operation</button></fieldset></form>}
      <button disabled={busy} onClick={()=>{choose(null);setDraft(null);setEvidence(null);notify("");}}>Cancel review</button></>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
