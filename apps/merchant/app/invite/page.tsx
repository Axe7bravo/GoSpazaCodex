"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AuthError, validateCredentials } from "@gospaza/api-client";
import { authClient } from "../auth-client";
import { merchantClient, merchantError } from "../merchant-client";

type Access = "checking" | "anonymous" | "authenticated" | "invalid" | "unavailable";

export default function Invite() {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const [access, setAccess] = useState<Access>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    // A ref survives Strict Mode effect replay. The fragment is never sent to
    // Next.js, and is removed before any auth request. No persistent storage.
    if (token.current === null) token.current = window.location.hash.slice(1);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", "/invite");
    }
    async function check() {
      try {
        await authClient.me();
        if (active) {
          setAccess(/^[A-Za-z0-9_-]{43}$/.test(token.current ?? "") ? "authenticated" : "invalid");
          setError("");
        }
      } catch (error) {
        if (!active) return;
        if (!/^[A-Za-z0-9_-]{43}$/.test(token.current ?? "")) {
          setAccess("invalid");
        } else if (error instanceof AuthError && error.kind === "unauthorized") {
          setAccess("anonymous");
          setError("");
        } else {
          setAccess("unavailable");
          setError(merchantError(error));
        }
      }
    }
    void check();
    return () => { active = false; };
  }, [retry]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !token.current) return;
    if (access === "anonymous") {
      const invalid = validateCredentials(email, password, registering);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (access === "anonymous") {
        if (registering) await authClient.register(email, password);
        else await authClient.login(email, password);
        setPassword("");
        setAccess("authenticated");
      }
      await merchantClient.accept(token.current);
      token.current = "";
      router.replace("/merchant");
    } catch (error) {
      setError(merchantError(error));
      setPassword("");
      if (error instanceof AuthError && error.status === 401) setAccess("anonymous");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function switchAccount() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await authClient.logout();
      setAccess("anonymous");
      setError("");
    } catch (error) {
      setError(merchantError(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <p className="brand">GoSpaza</p>
        <h1>Join a merchant team</h1>
        <p>Use the merchant account with the invited email. No merchant details are shown before acceptance.</p>
        {error && <p role="alert" className="auth-error">{error}</p>}
        {access === "checking" && <p role="status">Checking your session…</p>}
        {access === "invalid" && (
          <p>This invitation link is missing or incomplete. Reopen the original link or ask the owner for a new one.</p>
        )}
        {access === "unavailable" && (
          <button onClick={() => setRetry((value) => value + 1)}>Try again</button>
        )}
        {(access === "anonymous" || access === "authenticated") && (
          <form onSubmit={accept} noValidate aria-busy={busy}>
            {access === "anonymous" && (
              <>
                <label htmlFor="invite-email">Email address</label>
                <input
                  id="invite-email" type="email" autoComplete="email" maxLength={254}
                  value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy}
                />
                <label htmlFor="invite-password">Password</label>
                <input
                  id="invite-password" type="password"
                  autoComplete={registering ? "new-password" : "current-password"} maxLength={256}
                  value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy}
                />
                {registering && <p>Use at least 12 characters.</p>}
              </>
            )}
            <button type="submit" disabled={busy}>
              {busy ? "Please wait…" : access === "authenticated" ? "Accept invitation"
                : registering ? "Create account and accept" : "Sign in and accept"}
            </button>
          </form>
        )}
        {access === "anonymous" && (
          <button
            type="button" disabled={busy}
            onClick={() => { setRegistering(!registering); setError(""); }}
          >
            {registering ? "Use an existing account" : "Create a merchant account"}
          </button>
        )}
        {access === "authenticated" && (
          <button type="button" disabled={busy} onClick={() => void switchAccount()}>
            Use a different account
          </button>
        )}
        <p>Keep this page open while signing in. Reloading requires reopening the original invitation link.</p>
        <Link href="/">Back to GoSpaza</Link>
      </section>
    </main>
  );
}
