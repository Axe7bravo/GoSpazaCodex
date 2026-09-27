"use client";
import Link from "next/link";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "./auth-client";
export default function Page() {
  return <main className="auth-layout admin"><SessionBoundary client={authClient} title="Platform admin portal">
    {() => <><Link href="/admin/merchant-applications">Review merchant applications</Link><p><Link href="/admin/service-zones">Manage service zones</Link></p></>}
  </SessionBoundary></main>;
}

