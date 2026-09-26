"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { SessionBoundary } from "@gospaza/ui/auth";
import { Button } from "@gospaza/ui";
import { createApplicationClient, AuthError } from "@gospaza/api-client";
import type { ApplicationDetail, ApplicationDocument, ApplicationReviewAction } from "@gospaza/contracts";
import { authClient } from "../../../auth-client";
const client = createApplicationClient(process.env.NEXT_PUBLIC_API_URL!, true);
function Detail({ id }: { id: string }) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; client.detail(id).then((value) => { if (active) setDetail(value); }).catch((e: unknown) => { if (active) { if (e instanceof AuthError && e.kind === "unauthorized") window.location.replace("/login"); setError(e instanceof Error ? e.message : "Unable to load application."); } }); return () => { active = false; }; }, [id]);
  async function download(document: ApplicationDocument) { setBusy(true); setError(""); try {
    const url = URL.createObjectURL(await client.download(id, document)); const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = document.display_name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { setError(e instanceof Error ? e.message : "Document unavailable."); } finally { setBusy(false); } }
  const [reason, setReason] = useState("");
  async function decide(action: ApplicationReviewAction) {
    if (busy || !detail?.application) return;
    if (action !== "start-review" && !reason.trim()) { setError("Enter a review reason."); return; }
    const prompt = action === "approve" ? "Approve this application and provision its merchant, physical store and owner membership?" : action === "reject" ? "Reject this application? It will remain read-only." : action === "request-information" ? "Send this review request to the applicant?" : "Start reviewing this application?";
    if (!window.confirm(prompt)) return;
    setBusy(true); setError("");
    try { setDetail(await client.review(id, action, action === "start-review" ? {} : { reason: reason.trim(), ...(action === "approve" ? { confirmed: true } : {}) })); setReason(""); }
    catch (e) {
      setError(e instanceof Error ? e.message : "Review action failed. Refresh before retrying.");
      // Reconcile a transport failure or another admin's decision without retrying a mutation.
      try { setDetail(await client.detail(id)); } catch { setDetail(null); setError("Review result could not be refreshed. Use Retry to reload the application before making a decision."); }
    } finally { setBusy(false); }
  }
  const app = detail?.application;
  return <div className="application-content"><Link href="/admin/merchant-applications">Back to applications</Link>
    {error && <p role="alert" className="auth-error">{error}</p>}{!detail && !error && <p role="status">Loading application…</p>}
    {!detail && error && <Button onClick={() => window.location.reload()}>Retry</Button>}
    {detail && app && <><h2>{app.trading_name}</h2><p>Status: {app.status.replaceAll("_", " ")}</p><p>Review decisions are recorded in the application history.</p>
      {error && <Button disabled={busy} onClick={() => window.location.reload()}>Refresh application</Button>}
      {app.status === "SUBMITTED" && <Button disabled={busy} onClick={() => void decide("start-review")}>Start review</Button>}
      {app.status === "UNDER_REVIEW" && <section><h2>Review decision</h2><label>Review reason<textarea value={reason} maxLength={2000} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label><p>The reason is visible to the applicant. Do not include private credentials or document contents.</p>
        <Button disabled={busy || !reason.trim()} onClick={() => void decide("request-information")}>Request more information</Button>
        <Button disabled={busy || !reason.trim()} onClick={() => void decide("reject")}>Reject application</Button>
        <Button disabled={busy || !reason.trim()} onClick={() => void decide("approve")}>Approve application</Button></section>}
      {app.status === "APPROVED" && detail.tenant && <p>Provisioned merchant: {detail.tenant.merchant.trading_name} — store: {detail.tenant.store.name}</p>}
      <section><h2>Review history</h2>{!(detail.review_history ?? []).length && <p>No review events yet.</p>}<ol>{(detail.review_history ?? []).map((event) => <li key={event.id}>{event.action.replaceAll("_", " ")} — {new Date(event.created_at).toLocaleString()}{event.platform_user_id && <span> — platform user {event.platform_user_id}</span>}{event.reason && <p>{event.reason}</p>}</li>)}</ol></section>
      <dl className="application-summary">{Object.entries({ "Legal name": app.legal_name, "Contact name": app.contact_name, "Contact email": app.contact_email, "Contact phone": app.contact_phone,
        "Street address": app.address_line_1, "Address line 2": app.address_line_2, "City or town": app.city, Province: app.province, "Postal code": app.postal_code, Country: app.country_code,
        "Intends to sell alcohol": app.intends_to_sell_alcohol ? "Yes" : "No", Notes: app.notes, Submitted: app.submitted_at ? new Date(app.submitted_at).toLocaleString() : "—",
      }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
      <h2>Supporting documents</h2><p>Document categories do not establish regulatory compliance.</p>{!detail.documents.length && <p>No documents uploaded.</p>}
      <ul>{detail.documents.map((document) => <li key={document.id}>{document.display_name} — {document.document_type.replaceAll("_", " ")} — {Math.ceil(document.size_bytes / 1024)} KB <Button disabled={busy || document.removal_pending} onClick={() => void download(document)}>Download {document.display_name}</Button></li>)}</ul>
    </>}
  </div>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <main className="auth-layout admin application-layout"><SessionBoundary client={authClient} title="Application review">{() => <Detail key={id} id={id} />}</SessionBoundary></main>; }
