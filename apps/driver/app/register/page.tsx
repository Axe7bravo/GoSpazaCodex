"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";
export default function Register() {
  return <main className="auth-layout driver"><AuthForm client={authClient} title="Join GoSpaza as a driver" destination="/" registration
    note="Create credentials only if you are new to GoSpaza. If you already have an account, sign in with your existing password. Creating a driver profile does not create another password or grant approval." /></main>;
}
