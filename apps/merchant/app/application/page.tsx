"use client";
import { useEffect, useRef, useState } from "react";
import { SessionBoundary } from "@gospaza/ui/auth";
import { Button } from "@gospaza/ui";
import { AuthError, createApplicationClient } from "@gospaza/api-client";
import type { ApplicationDetail, ApplicationFields, ApplicationDocument } from "@gospaza/contracts";
import { applicationDocumentTypes } from "@gospaza/contracts";
import { authClient } from "../auth-client";
const client = createApplicationClient(process.env.NEXT_PUBLIC_API_URL!);
const fields: Array<{ key: keyof Omit<ApplicationFields, "intends_to_sell_alcohol" | "notes">; label: string; max: number; optional?: boolean }> = [
  { key: "legal_name", label: "Legal name", max: 200 }, { key: "trading_name", label: "Trading name", max: 200 },
  { key: "contact_name", label: "Contact name", max: 150 }, { key: "contact_email", label: "Contact email", max: 254 },
  { key: "contact_phone", label: "Contact phone", max: 40 }, { key: "address_line_1", label: "Street address", max: 200 },
  { key: "address_line_2", label: "Address line 2", max: 200, optional: true }, { key: "city", label: "City or town", max: 100 },
  { key: "province", label: "Province", max: 100 }, { key: "postal_code", label: "Postal code", max: 20 },
  { key: "country_code", label: "Country code (two letters)", max: 2 },
];
function Application() {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [form, setForm] = useState<ApplicationFields | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null); const [category, setCategory] = useState<string>("OTHER");
  function accept(value: ApplicationDetail) { setDetail(value); if (value.application) {
    const data = value.application;
    setForm(Object.fromEntries([...fields.map(({ key }) => [key, data[key]]), ["notes", data.notes], ["intends_to_sell_alcohol", data.intends_to_sell_alcohol]]) as unknown as ApplicationFields);
  } }
  function fail(e: unknown) { if (e instanceof AuthError && e.kind === "unauthorized") window.location.replace("/login"); setError(e instanceof Error ? e.message : "Please try again."); }
  useEffect(() => { let active = true; client.own().then((value) => { if (active) accept(value); }).catch((e: unknown) => { if (active) fail(e); }); return () => { active = false; }; }, []);
  async function action(work: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { fail(e); } finally { setBusy(false); } }
  async function save() { if (detail?.application && form) { accept(await client.edit(detail.application.id, form)); setNotice("Draft saved."); } }
  async function upload() {
    if (!file || !detail?.application) return;
    if (file.size > 10 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a PDF, JPEG or PNG of at most 10 MB.");
    const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Unable to read file.")); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.readAsDataURL(file); });
    // Upload responses refresh documents without discarding unsaved form edits.
    setDetail(await client.upload(detail.application.id, { document_type: category, display_name: file.name, mime_type: file.type, content }));
    setFile(null); if (fileInput.current) fileInput.current.value = ""; setNotice("Document uploaded.");
  }
  async function download(document: ApplicationDocument) {
    if (!detail?.application) return;
    const url = URL.createObjectURL(await client.download(detail.application.id, document));
    const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = document.display_name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const application = detail?.application; const editable = application?.status === "DRAFT" || application?.status === "MORE_INFORMATION_REQUIRED";
  return <div className="application-content">
    {error && <p role="alert" className="auth-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!detail && !error && <p role="status">Loading application…</p>}
    {!detail && error && <Button onClick={() => void action(async () => accept(await client.own()))}>Retry</Button>}
    {detail && !application && <><p>Start an application for one physical store. You can save a draft before submitting.</p><Button disabled={busy} onClick={() => void action(async () => accept(await client.create()))}>Start application</Button></>}
    {detail && application && form && <>
      <p className="application-status">Status: {application.status.replaceAll("_", " ")}</p>
      {application.submitted_at && <p>Submitted: {new Date(application.submitted_at).toLocaleString()}</p>}
      {!editable && application.status !== "APPROVED" && <p>Your application is read-only. Submission is not merchant approval.</p>}
      {application.status === "MORE_INFORMATION_REQUIRED" && <p>More information is needed. Update your details and documents, then resubmit.</p>}
      {application.status === "REJECTED" && <p>This application was rejected. It cannot be edited or restarted.</p>}
      {(detail.review_history ?? []).filter((event) => event.action === "INFORMATION_REQUESTED" || event.action === "REJECTED").map((event) => <section key={event.id}><h2>{event.action === "REJECTED" ? "Rejection reason" : "Review request"}</h2><p>{event.reason}</p></section>)}
      {application.status === "APPROVED" && <section><h2>Application approved</h2>{detail.tenant ? <><p>Merchant setup complete.</p><p>Merchant: {detail.tenant.merchant.trading_name}</p><p>Store: {detail.tenant.store.name}</p></> : <p>Merchant access is unavailable. Contact support.</p>}</section>}
      <form onSubmit={(event) => { event.preventDefault(); void action(save); }} aria-busy={busy}>
        <fieldset disabled={!editable || busy} className="application-fields"><legend>Store and contact details</legend>
          {fields.map(({ key, label, max, optional }) => <label key={key}>{label}{optional ? " (optional)" : ""}<input name={key} value={form[key]} maxLength={max} type={key === "contact_email" ? "email" : "text"} onChange={(e) => setForm({ ...form, [key]: key === "country_code" ? e.target.value.toUpperCase() : e.target.value })} /></label>)}
          <label className="checkbox"><input type="checkbox" checked={form.intends_to_sell_alcohol} onChange={(e) => setForm({ ...form, intends_to_sell_alcohol: e.target.checked })} />Intends to sell alcohol</label>
          <label className="wide">Notes (optional)<textarea maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </fieldset>
        {editable && <Button type="submit" disabled={busy}>Save draft</Button>}
      </form>
      <section><h2>Supporting documents</h2><p>PDF, JPEG or PNG, up to 10 MB each; maximum 20 documents. Categories organise your files and do not establish regulatory compliance.</p>
        {detail.documents.length === 0 && <p>No documents uploaded.</p>}
        <ul>{detail.documents.map((document) => <li key={document.id}><span>{document.display_name} — {document.document_type.replaceAll("_", " ")}{document.removal_pending ? " — removal pending" : ""}</span>
          {!document.removal_pending && <Button disabled={busy} onClick={() => void action(() => download(document))}>Download {document.display_name}</Button>}
          {editable && <Button disabled={busy} onClick={() => void action(async () => { await client.remove(application.id, document.id); setDetail(await client.own()); })}>{document.removal_pending ? "Retry removal" : "Remove"} {document.display_name}</Button>}
        </li>)}</ul>
        {editable && <fieldset disabled={busy}><legend>Add a document</legend><label>Document category<select value={category} onChange={(e) => setCategory(e.target.value)}>{applicationDocumentTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
          <label>File<input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label><Button disabled={!file || busy} onClick={() => void action(upload)}>Upload document</Button>
        </fieldset>}
      </section>
      {editable && <section><h2>{application.status === "MORE_INFORMATION_REQUIRED" ? "Resubmit application" : "Submit application"}</h2><p>Complete the required contact and address fields. Submission locks editing; it does not approve a merchant account.</p><Button disabled={busy || detail.documents.some((d) => d.removal_pending)} onClick={() => { if (window.confirm("Submit this application? It will become read-only.")) void action(async () => { await save(); accept(await client.submit(application.id)); setNotice("Application submitted."); }); }}>{application.status === "MORE_INFORMATION_REQUIRED" ? "Resubmit application" : "Submit application"}</Button></section>}
    </>}
  </div>;
}
export default function Page() { return <main className="auth-layout merchant application-layout"><SessionBoundary client={authClient} title="Merchant application">{() => <Application />}</SessionBoundary></main>; }
