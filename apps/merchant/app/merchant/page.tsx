"use client";
import Link from "next/link";
import { useMerchant } from "./shell";
export default function MerchantHome() {
  const { tenant } = useMerchant();
  return <>
    <h1>Merchant portal</h1>
    <p>Provisioning complete. Your store workspace is ready.</p>
    <dl className="application-summary">
      <div><dt>Merchant</dt><dd>{tenant.merchant.legal_name}</dd></div>
      <div><dt>Store</dt><dd>{tenant.store.name}</dd></div>
      <div><dt>Your role</dt><dd>{tenant.membership.member_type}</dd></div>
    </dl>
    {tenant.membership.capabilities.includes("MERCHANT_TEAM_VIEW") && <Link href="/merchant/team">View team</Link>}
  </>;
}
