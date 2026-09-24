"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";

export default function Login() {
  return <main className="auth-layout admin"><AuthForm client={authClient} title="Platform admin sign in"
    destination="/" note="Sign in with an account provisioned for this application." /></main>;
}

