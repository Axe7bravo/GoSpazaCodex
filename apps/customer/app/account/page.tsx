"use client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";
export default function Account() {
  return <main className="auth-layout customer"><SessionBoundary client={authClient} title="Your account">
    {(_identity, customer) => <p>Signed in as <strong>{customer?.email}</strong>.</p>}
  </SessionBoundary></main>;
}

