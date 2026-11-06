"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActorNotice, NoticePage, NotificationHealth, NotificationOperationPage } from "@gospaza/contracts";
import { AuthError } from "@gospaza/api-client";
import { noticeHref, noticeTime, notificationCode, operationStatus, type NoticeSurface } from "./notification-presentation";

type InboxClient = { list(cursor?: string): Promise<NoticePage>; markRead(id: string): Promise<ActorNotice> };
export function NoticeFeedback({ loading, error, empty = false, older = false }: { loading: boolean; error: "" | "load" | "mark"; empty?: boolean; older?: boolean }) {
  return <>{loading && <p role="status">Loading notifications…</p>}
    {error && <p role="alert" aria-label="Notification error">{error === "mark" ? "Read status could not be confirmed. Refresh notifications before trying again." : "Notifications are unavailable. Refresh or sign in again."}</p>}
    {!loading && !error && empty && <p>{older ? "No notifications on this page." : "No notifications yet."}</p>}</>;
}
export function NoticeCard({ notice: row, surface, busy, markRead }: { notice: ActorNotice; surface: NoticeSurface; busy: boolean; markRead: (id: string) => void }) {
  const href = noticeHref(row.deep_link, surface);
  return <article className="notice-card" aria-label={row.title}>
    <header><h2>{row.title}</h2><span className={row.read_at ? "notice-read" : "notice-unread"}>{row.read_at ? "Read" : "Unread"}</span></header>
    <p className="notice-body">{row.body}</p><time dateTime={row.created_at}>{noticeTime(row.created_at)}</time>
    <div className="notice-actions">{!row.read_at && <button disabled={busy} onClick={() => markRead(row.id)} aria-label={"Mark notification read: " + row.title}>Mark read</button>}
      {href && <a href={href} aria-label={"Open notification destination: " + row.title}>Open linked workspace</a>}</div>
  </article>;
}
// Shared DTO presentation primitive. Actor wrappers own authentication/shells;
// the server owns recipients, permissions, frozen copy and source actionability.
export function NoticeInbox({ client, surface }: { client: InboxClient; surface: NoticeSurface }) {
  const [page, setPage] = useState<NoticePage>();
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<"" | "load" | "mark">("");
  const [busy, setBusy] = useState(true);
  const lifetime = useRef<{ active: boolean; generation: number; writing: boolean } | null>(null);
  const read = useCallback(async (next?: string) => {
    const life = lifetime.current; if (!life?.active || life.writing) return;
    const version = ++life.generation;
    try {
      const result = await client.list(next);
      if (life.active && version === life.generation) { setPage(result); setCursor(next); setError(""); }
    } catch {
      if (life.active && version === life.generation) { setPage(undefined); setError("load"); }
    } finally { if (life.active && version === life.generation) setBusy(false); }
  }, [client]);
  useEffect(() => {
    const life = { active: true, generation: 0, writing: false }; lifetime.current = life; void read();
    const foreground = () => { if (document.visibilityState === "visible" && !life.writing) { setBusy(true); void read(); } };
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
    return () => { life.active = false; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [read]);
  function refresh(next?: string) { setBusy(true); void read(next); }
  async function markRead(id: string) {
    const life = lifetime.current; if (!life?.active || busy) return;
    const version = ++life.generation; life.writing = true; setBusy(true); setError("");
    try {
      const saved = await client.markRead(id);
      if (life.active && version === life.generation) setPage(old => old ? { ...old, notifications: old.notifications.map(row => row.id === saved.id ? saved : row) } : old);
    } catch (cause) {
      if (life.active && version === life.generation) {
        if (cause instanceof AuthError && [401, 403, 404].includes(cause.status ?? 0)) setPage(undefined);
        setError("mark");
      }
    } finally { life.writing = false; if (life.active && version === life.generation) setBusy(false); }
  }
  return <section className="notice-inbox" aria-label="Your notifications" aria-busy={busy}>
    <h1>Notifications</h1><p>Open the linked workspace for its current status and available actions.</p>
    <button type="button" disabled={busy} onClick={() => refresh(cursor)}>Refresh notifications</button>
    <NoticeFeedback loading={!page && busy} error={error} empty={!!page && !page.notifications.length} older={!!cursor} />
    {page && <>
      <ul className="notice-list">{page.notifications.map(row => <li key={row.id}><NoticeCard notice={row} surface={surface} busy={busy} markRead={id => void markRead(id)} /></li>)}</ul>
      <nav aria-label="Notification pages"><button disabled={busy || !cursor} onClick={() => refresh()}>Newest notifications</button>
        {page.next_cursor && <button disabled={busy} onClick={() => refresh(page.next_cursor ?? undefined)}>Older notifications</button>}</nav>
    </>}
  </section>;
}

type OperationsClient = { list(cursor?: string): Promise<NotificationOperationPage>; health(): Promise<NotificationHealth> };
export function NotificationOperations({ client }: { client: OperationsClient }) {
  const [data, setData] = useState<{ page: NotificationOperationPage; health: NotificationHealth }>();
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const lifetime = useRef<{ active: boolean; generation: number } | null>(null);
  const read = useCallback(async (next?: string) => {
    const life = lifetime.current; if (!life?.active) return;
    const version = ++life.generation;
    try {
      const [page, health] = await Promise.all([client.list(next), client.health()]);
      if (life.active && version === life.generation) { setData({ page, health }); setCursor(next); setError(""); }
    } catch {
      if (life.active && version === life.generation) { setData(undefined); setError("Notification operations are unavailable or access is not permitted."); }
    } finally { if (life.active && version === life.generation) setBusy(false); }
  }, [client]);
  useEffect(() => {
    const life = { active: true, generation: 0 }; lifetime.current = life; void read();
    const foreground = () => { if (document.visibilityState === "visible") { setBusy(true); void read(); } };
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
    return () => { life.active = false; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [read]);
  function refresh(next?: string) { setBusy(true); void read(next); }
  return <section className="notice-operations" aria-label="Notification operations" aria-busy={busy}>
    <h1>Notification operations</h1><p>Transport status does not change an order, payment or delivery outcome. Provider acceptance is not a human read receipt.</p>
    <button disabled={busy} onClick={() => refresh(cursor)}>Refresh notification operations</button>
    {!data && busy && <p role="status">Loading notification operations…</p>}
    {error && <p role="alert" aria-label="Notification operations error">{error}</p>}
    {data && <>
      <section aria-label="Notification worker health"><h2>Worker health</h2>
        {data.health.workers.map(worker => <p key={worker.name}>{worker.name === "delivery" ? "Delivery worker" : "Repair worker"}: {worker.enabled ? "Enabled" : "Disabled"} · Last successful cycle: {worker.last_success_at ? noticeTime(worker.last_success_at) : "Not recorded"}{worker.last_error ? " · A worker error requires review" : ""}</p>)}
        <p>Oldest eligible pending age: {data.health.oldest_pending_age_seconds === null ? "No eligible pending messages" : data.health.oldest_pending_age_seconds + " seconds"}</p>
        <p>Attention required in the sampled window: {data.health.states.ATTENTION_REQUIRED ?? 0}</p>
        <p>Health window begins {noticeTime(data.health.window_start)}. {data.health.truncated ? "Sample limit reached." : "Bounded operational sample."}</p>
      </section>
      {!data.page.operations.length ? <p>No notification operations on this page.</p> : <div className="notice-table-scroll"><table aria-label="Notification delivery operations"><thead><tr>
        <th>Kind</th><th>Channel</th><th>Status</th><th>Created</th><th>Attempts</th><th>Safe classification</th><th>Provider evidence</th>
      </tr></thead><tbody>{data.page.operations.map(row => <tr key={row.id} className={row.state === "ATTENTION_REQUIRED" || row.state === "TERMINAL_FAILURE" ? "notice-attention" : undefined}>
        <td>{row.kind}</td><td>{row.channel === "IN_APP" ? "In app" : "Email"}</td><td>{operationStatus(row)}</td><td>{noticeTime(row.created_at)}</td><td>{row.attempts}</td>
        <td>{notificationCode(row.last_code)}</td><td>{row.transport_disposition === "delivered" ? "Provider reports delivery; human read status is unknown" : row.transport_disposition ?? "No external evidence"}</td>
      </tr>)}</tbody></table></div>}
      <nav aria-label="Notification operation pages"><button disabled={busy || !cursor} onClick={() => refresh()}>Newest operations</button>
        {data.page.next_cursor && <button disabled={busy} onClick={() => refresh(data.page.next_cursor ?? undefined)}>Older operations</button>}</nav>
    </>}
  </section>;
}
