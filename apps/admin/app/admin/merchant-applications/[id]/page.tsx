"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { SessionBoundary } from "@gospaza/ui/auth";
import { Button } from "@gospaza/ui";
import { createApplicationClient, AuthError } from "@gospaza/api-client";
import type { ApplicationDetail, ApplicationDocument } from "@gospaza/contracts";
import { authClient } from "../../../auth-client";
const client = createApplicationClient(process.env.NEXT_PUBLIC_API_URL!, true);
function Detail({ id }: { id: string }) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; client.detail(id).then((value) => { if (active) setDetail(value); }).catch((e: unknown) => { if (active) { if (e instanceof AuthError && e.kind === "unauthorized") window.location.replace("/login"); setError(e instanceof Error ? e.message : "Unable to load application."); } }); return () => { active = false; }; }, [id]);
  async function download(document: ApplicationDocument) { setBusy(true); setError(""); try {
    const url = URL.createObjectURL(await client.download(id, document)); const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = document.display_name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { setError(e instanceof Error ? e.message : "Document unavailable."); } finally { setBusy(false); } }
  const app = detail?.application;
  return <div className="application-content"><Link href="/admin/merchant-applications">Back to applications</Link>
    {error && <p role="alert" className="auth-error">{error}</p>}{!detail && !error && <p role="status">Loading application…</p>}
    {!detail && error && <Button onClick={() => window.location.reload()}>Retry</Button>}
    {detail && app && <><h2>{app.trading_name}</h2><p>Status: {app.status.replaceAll("_", " ")}</p><p>Read-only review. No approval or provisioning action is available.</p>
      <dl className="application-summary">{Object.entries({ "Legal name": app.legal_name, "Contact name": app.contact_name, "Contact email": app.contact_email, "Contact phone": app.contact_phone,
        "Street address": app.address_line_1, "Address line 2": app.address_line_2, "City or town": app.city, Province: app.province, "Postal code": app.postal_code, Country: app.country_code,
        "Intends to sell alcohol": app.intends_to_sell_alcohol ? "Yes" : "No", Notes: app.notes, Submitted: app.submitted_at ? new Date(app.submitted_at).toLocaleString() : "—",
      }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
      <h2>Supporting documents</h2><p>Document categories do not establish regulatory compliance.</p>{!detail.documents.length && <p>No documents uploaded.</p>}
      <ul>{detail.documents.map((document) => <li key={document.id}>{document.display_name} — {document.document_type.replaceAll("_", " ")} — {Math.ceil(document.size_bytes / 1024)} KB <Button disabled={busy || document.removal_pending} onClick={() => void download(document)}>Download {document.display_name}</Button></li>)}</ul>
    </>}
  </div>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <main className="auth-layout admin application-layout"><SessionBoundary client={authClient} title="Application review">{() => <Detail id={id} />}</SessionBoundary></main>; }
