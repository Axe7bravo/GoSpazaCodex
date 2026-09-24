"use client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "./auth-client";
export default function Page() {
  return <main className="auth-layout driver"><SessionBoundary client={authClient} title="Driver portal">
    {() => <p>You are signed in. Operational features are not available yet.</p>}
  </SessionBoundary></main>;
}

