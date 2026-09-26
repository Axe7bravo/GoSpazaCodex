"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SessionBoundary } from "@gospaza/ui/auth";
import { Button } from "@gospaza/ui";
import { createApplicationClient, AuthError } from "@gospaza/api-client";
import { applicationStatuses } from "@gospaza/contracts";
import type { ApplicationList } from "@gospaza/contracts";
import { authClient } from "../../auth-client";
const client = createApplicationClient(process.env.NEXT_PUBLIC_API_URL!, true);
function List() {
  const [result, setResult] = useState<ApplicationList | null>(null); const [error, setError] = useState("");
  const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [busy, setBusy] = useState(false);
  async function load(offset = 0) { setBusy(true); setError(""); try { setResult(await client.list({ q, status, offset })); } catch (e) { if (e instanceof AuthError && e.kind === "unauthorized") window.location.replace("/login"); setError(e instanceof Error ? e.message : "Unable to load applications."); } finally { setBusy(false); } }
  useEffect(() => { let active = true; client.list({}).then((value) => { if (active) setResult(value); }).catch(() => { if (active) setError("Unable to load applications. Retry with Search."); }); return () => { active = false; }; }, []);
  return <div className="application-content"><p>Submitted applications only. Open an application to review it and make a recorded decision.</p>
    <form onSubmit={(e) => { e.preventDefault(); void load(); }} className="review-filters"><label>Search legal or trading name<input value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} /></label>
      <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All submitted states</option>{applicationStatuses.filter((s) => s !== "DRAFT").map((s) => <option key={s}>{s}</option>)}</select></label><Button type="submit" disabled={busy}>Search</Button></form>
    {error && <p role="alert" className="auth-error">{error}</p>}{(!result || busy) && !error && <p role="status">Loading applications…</p>}
    {result && <><p>{result.count} applications</p>{!result.applications.length ? <p>No applications match these filters.</p> : <div className="table-scroll"><table><thead><tr><th>Trading name</th><th>Legal name</th><th>Status</th><th>Submitted</th></tr></thead><tbody>{result.applications.map((app) => <tr key={app.id}><td><Link href={"/admin/merchant-applications/" + encodeURIComponent(app.id)}>{app.trading_name}</Link></td><td>{app.legal_name}</td><td>{app.status.replaceAll("_", " ")}</td><td>{app.submitted_at && new Date(app.submitted_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
      <div className="pagination"><Button disabled={busy || result.offset === 0} onClick={() => void load(Math.max(0, result.offset - result.limit))}>Previous</Button><Button disabled={busy || result.offset + result.limit >= result.count} onClick={() => void load(result.offset + result.limit)}>Next</Button></div></>}
  </div>;
}
export default function Page() { return <main className="auth-layout admin application-layout"><SessionBoundary client={authClient} title="Merchant applications">{() => <List />}</SessionBoundary></main>; }
