"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MerchantContext } from "@gospaza/contracts";
import { AuthError } from "@gospaza/api-client";
import { authClient } from "../auth-client";
import { merchantClient, merchantError } from "../merchant-client";

const PortalContext = createContext<{ tenant: MerchantContext; refresh: () => Promise<void> } | null>(null);
export function useMerchant() {
  const context = useContext(PortalContext);
  if (!context) throw new Error("Merchant shell required.");
  return context;
}
export function MerchantShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [tenant, setTenant] = useState<MerchantContext | null>(null);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const lifetime = useRef<{ active: boolean; generation: number } | null>(null);
  const refresh = useCallback((): Promise<void> => {
    const scope = lifetime.current;
    if (!scope?.active) return Promise.resolve();
    const generation = ++scope.generation;
    const isCurrent = () => scope.active && generation === scope.generation;
    // Only request completion updates React state; startup leaves initial loading intact.
    return merchantClient.context().then(
      (context) => {
        if (!isCurrent()) return;
        setTenant(context);
        setError("");
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        setTenant(null); // Remove protected contents on any failed authorization refresh.
        if (error instanceof AuthError && error.status === 401) {
          return authClient.me().then(
            () => { if (isCurrent()) router.replace("/application"); },
            (sessionError: unknown) => {
              if (!isCurrent()) return;
              if (sessionError instanceof AuthError && sessionError.kind === "unauthorized") {
                router.replace("/login");
              } else setError(merchantError(sessionError));
            },
          );
        }
        setError(merchantError(error));
      },
    );
  }, [router]);
  useEffect(() => {
    const scope = { active: true, generation: 0 };
    lifetime.current = scope;
    void refresh();
    const check = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 60000);
    return () => {
      // Cancel this effect's lifetime, not whichever ref a later setup installed.
      scope.active = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refresh]);
  async function logout() {
    const scope = lifetime.current;
    if (!scope?.active) return;
    setSigningOut(true);
    try {
      await authClient.logout();
      if (!scope.active) return;
      scope.active = false;
      setTenant(null);
      router.replace("/login");
    } catch (error) {
      if (!scope.active) return;
      setError(merchantError(error));
      setSigningOut(false);
    }
  }
  return (
    <main className="merchant-portal">
      <p className="brand">GoSpaza</p>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {!tenant && (error
        ? <button onClick={() => void refresh()}>Try again</button>
        : <p role="status">Checking merchant access…</p>)}
      {tenant && (
        <PortalContext.Provider value={{ tenant, refresh }}>
          <header className="portal-header">
            <div>
              <p>{tenant.merchant.trading_name} · {tenant.store.name}</p>
              <p>Role: {tenant.membership.member_type}</p>
            </div>
            <button onClick={logout} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </header>
          <nav aria-label="Merchant navigation">
            <Link href="/merchant">Overview</Link>
            {tenant.membership.capabilities.includes("MERCHANT_CATALOG_VIEW") && <Link href="/merchant/products">Products</Link>}
            {tenant.membership.capabilities.includes("MERCHANT_INVENTORY_VIEW") && <Link href="/merchant/inventory">Inventory</Link>}
            {tenant.membership.capabilities.includes("MERCHANT_TEAM_VIEW") && (
              <Link href="/merchant/team">Team</Link>
            )}
          </nav>
          <section key={tenant.membership.id + tenant.membership.member_type}>{children}</section>
        </PortalContext.Provider>
      )}
    </main>
  );
}
