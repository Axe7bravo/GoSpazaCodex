"use client";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AuthError, validateCredentials } from "@gospaza/api-client";
import type { AuthClient, CustomerAuthClient } from "@gospaza/api-client";
import type { ActorIdentity, CustomerAccount } from "@gospaza/contracts";
import { Button } from "./index";

function message(error: unknown) {
  return error instanceof AuthError ? error.message : "We cannot complete this request right now. Please try again.";
}
export function AuthForm({ client, title, destination, registration = false, registerHref, note }: {
  client: AuthClient | CustomerAuthClient; title: string; destination: string;
  registration?: boolean; registerHref?: string; note?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let active = true;
    client.me().then(() => { if (active) window.location.replace(destination); })
      .catch((error: unknown) => {
        if (active && !(error instanceof AuthError && error.kind === "unauthorized")) setError(message(error));
      }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [client, destination]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const invalid = validateCredentials(email, password, registration);
    if (invalid) { setError(invalid); return; }
    setSubmitting(true); setError("");
    try {
      if (registration && "register" in client) await client.register(email, password);
      else await client.login(email, password);
      setPassword("");
      window.location.replace(destination);
    } catch (error) { setError(message(error)); setPassword(""); setSubmitting(false); }
  }
  return <section className="auth-card" aria-labelledby="auth-title">
    <p className="brand">GoSpaza</p>
    <h1 id="auth-title">{title}</h1>
    {note && <p className="auth-note">{note}</p>}
    {checking ? <p role="status">Checking your session…</p> :
      <form onSubmit={submit} aria-busy={submitting} noValidate>
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={254}
          value={email} onChange={(event) => setEmail(event.target.value)} disabled={submitting} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required maxLength={256}
          autoComplete={registration ? "new-password" : "current-password"} aria-describedby={registration ? "password-help" : undefined}
          value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting} />
        {registration && <p id="password-help">Use at least 12 characters.</p>}
        {error && <p role="alert" className="auth-error">{error}</p>}
        <Button type="submit" disabled={submitting}>{submitting ? "Please wait…" : registration ? "Create account" : "Sign in"}</Button>
      </form>}
    {registerHref && <p>New to GoSpaza? <a href={registerHref}>Register</a></p>}
    {registration && <p>Already have an account? <a href="/login">Sign in</a></p>}
  </section>;
}

export function SessionBoundary({ client, title, children }: {
  client: AuthClient | CustomerAuthClient; title: string;
  children: (identity: ActorIdentity, customer: CustomerAccount | null) => ReactNode;
}) {
  const [session, setSession] = useState<{ identity: ActorIdentity; customer: CustomerAccount | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let revision = 0;
    async function check() {
      const current = ++revision;
      setSession(null); setError("");
      try {
        const identity = await client.me();
        const customer = "account" in client ? await client.account() : null;
        if (active && current === revision) setSession({ identity, customer });
      } catch (error) {
        if (!active || current !== revision) return;
        if (error instanceof AuthError && error.kind === "unauthorized") window.location.replace("/login");
        else setError(message(error));
      }
    }
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visible);
    // Sessions can change from another local app sharing the backend cookie.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, 60000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, [client]);
  async function logout() {
    setBusy(true); setError("");
    try { await client.logout(); setSession(null); window.location.replace("/login"); }
    catch (error) { setError(message(error)); setBusy(false); }
  }
  return <section className="auth-card">
    <p className="brand">GoSpaza</p><h1>{title}</h1>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!session && !error && <p role="status">Checking your session…</p>}
    {!session && error && <Button onClick={() => window.location.reload()}>Try again</Button>}
    {session && <>{children(session.identity, session.customer)}<Button onClick={logout} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</Button></>}
  </section>;
}

