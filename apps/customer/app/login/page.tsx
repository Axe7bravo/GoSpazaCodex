"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";

export default function Login() {
  return <main className="auth-layout customer"><AuthForm client={authClient} title="Customer sign in"
    destination="/account" registerHref="/register" /></main>;
}

