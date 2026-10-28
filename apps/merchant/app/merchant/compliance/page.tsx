"use client";
import { useState } from "react";
import { createRestrictedCommerceClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { useMerchant } from "../shell";
const client = createRestrictedCommerceClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/application");
const localDate = (value?:string|null) => {
  if (!value) return "";
  const date=new Date(value);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
};
function Registration() {
  const resource = useDriverResource(client.registration, denied);
  const [uploadError, setUploadError] = useState("");
  const value = resource.data, row = value?.registration, submission = row?.pending_submission ?? row?.submission;
  return <section className="application-content"><h1>Store alcohol registration</h1>
    <p>This registration applies only to your current physical store. Submission is not approval to sell alcohol.</p>
    {resource.error && <p role="alert">Registration information unavailable.</p>}
    {resource.notice && <p role="status">Review the current registration before another action.</p>}
    <button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh registration</button>
    {value && <>
      <p>Status: {row?.status.replaceAll("_", " ") ?? "Not submitted"}</p>
      {value.review_note && <p>Review outcome: {value.review_note}</p>}
      {row?.pending_submission && <p>Updated evidence is pending review. It does not replace the existing approval.</p>}
      {value.premises && <p>Registered store address: {Object.values(value.premises).filter(Boolean).join(", ")}</p>}
      <h2>Private registration evidence</h2>
      <ul>{value.evidence.map(file => <li key={file.id}><a href={client.evidenceUrl(file.id)} target="_blank" rel="noreferrer">{file.display_name}</a> · {file.size_bytes} bytes</li>)}</ul>
      <form onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get("evidence");
        if (!(file instanceof File) || resource.busy) return;
        if (file.size > 10 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) { setUploadError("Choose a PDF, JPEG or PNG up to 10 MB."); return; }
        setUploadError("");
        void resource.mutate(async () => {
          const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("File unavailable")); reader.readAsDataURL(file); });
          await client.upload({display_name:file.name,mime_type:file.type,content}); form.reset();
        });
      }}><label>Registration evidence<input name="evidence" type="file" accept="application/pdf,image/jpeg,image/png" required /></label><button disabled={resource.busy}>Upload private evidence</button></form>
      {uploadError && <p role="alert">{uploadError}</p>}
      {row?.status !== "REVOKED" && <form key={(row?.revision ?? 0) + ":" + value.evidence.length} onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const category = form.get("category");
        if (category !== "GROCER_WINE" && category !== "LIQUOR_STORE") return;
        const date = (name:string) => { const input=String(form.get(name) ?? ""); return input ? new Date(input).toISOString() : null; };
        void resource.mutate(() => client.submit({registration_number:String(form.get("number")),category,issuing_authority:String(form.get("authority")),
          valid_from:date("from"),valid_until:date("until"),evidence_ids:form.getAll("evidence_id").map(String)}));
      }}><fieldset disabled={resource.busy}><legend>Submit registration details</legend>
        <label>Registration number<input name="number" maxLength={100} required defaultValue={submission?.registration_number} /></label>
        <label>Registration category<select name="category" defaultValue={submission?.category ?? "GROCER_WINE"}><option value="GROCER_WINE">Grocer wine</option><option value="LIQUOR_STORE">Liquor store</option></select></label>
        <label>Issuing authority<input name="authority" required maxLength={200} defaultValue={submission?.issuing_authority} /></label>
        <label>Valid from (device local time)<input name="from" type="datetime-local" defaultValue={localDate(submission?.valid_from)} /></label><label>Valid until (device local time)<input name="until" type="datetime-local" defaultValue={localDate(submission?.valid_until)} /></label>
        <p>Enter the validity dates from the registration, or leave blank only when no date is specified.</p>
        {value.evidence.map(file => <label key={file.id}><input type="checkbox" name="evidence_id" value={file.id} defaultChecked={submission?.evidence_ids.includes(file.id)} />{file.display_name}</label>)}
        <button disabled={!value.evidence.length}>Submit for platform review</button>
      </fieldset></form>}
    </>}
  </section>;
}
export default function Compliance() {
  const {tenant}=useMerchant();
  return tenant.membership.capabilities.includes("MERCHANT_CATALOG_MANAGE") ? <Registration /> : <p>You do not have access to store compliance administration.</p>;
}
