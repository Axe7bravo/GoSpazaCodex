"use client";
import { AuthForm } from "@gospaza/ui/auth";
import { authClient } from "../auth-client";
export default function Register() {
  return <main className="auth-layout customer"><AuthForm client={authClient} title="Create your account" destination="/account" registration /></main>;
}

