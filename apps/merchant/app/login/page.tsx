"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";

export default function Login() {
  return <main className="auth-layout merchant"><AuthForm client={authClient} title="Merchant and picker sign in"
    destination="/" registerHref="/apply" note="Sign in to start or continue your merchant application." /></main>;
}

