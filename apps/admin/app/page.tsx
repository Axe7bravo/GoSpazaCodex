"use client";
import Link from "next/link";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "./auth-client";
export default function Page() {
  return <main className="auth-layout admin"><SessionBoundary client={authClient} title="Platform admin portal">
    {() => <><Link href="/admin/merchant-applications">Review merchant applications</Link><p><Link href="/admin/service-zones">Manage service zones</Link></p><p><Link href="/admin/drivers">Review drivers</Link></p><p><Link href="/admin/driver-finance">Driver finance</Link></p><p><Link href="/admin/restricted-commerce">Review store alcohol compliance</Link></p><p><Link href="/admin/financial-adjustments">Review financial adjustments</Link></p><p><Link href="/admin/commissions">Commission rules</Link></p><p><Link href="/admin/settlements">Merchant settlements</Link></p></>}
  </SessionBoundary></main>;
}

