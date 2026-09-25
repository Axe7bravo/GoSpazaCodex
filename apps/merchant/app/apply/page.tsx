"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";
export default function Apply() { return <main className="auth-layout merchant"><AuthForm client={authClient} registration title="Apply to join GoSpaza" destination="/application" note="Create an applicant login. Applying does not grant approval or access to merchant operations." /></main>; }
