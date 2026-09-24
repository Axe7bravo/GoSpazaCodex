"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";

export default function Login() {
  return <main className="auth-layout merchant"><AuthForm client={authClient} title="Merchant and picker sign in"
    destination="/" note="Sign in with an account provisioned for this application." /></main>;
}

