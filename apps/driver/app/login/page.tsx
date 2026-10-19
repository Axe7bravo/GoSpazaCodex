"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";
export default function Login() {
  return <main className="auth-layout driver"><AuthForm client={authClient} title="Driver sign in" destination="/" registerHref="/register"
    note="Already use GoSpaza as a customer? Sign in with your existing credentials. Your driver profile is separate from your customer account." /></main>;
}
