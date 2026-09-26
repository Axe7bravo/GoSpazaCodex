"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthError } from "@gospaza/api-client";
import { authClient } from "./auth-client";
import { merchantClient, merchantError } from "./merchant-client";

export default function Home() {
  const router = useRouter();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function route() {
      try {
        await authClient.me();
        try {
          await merchantClient.context();
          if (active) router.replace("/merchant");
        } catch (error) {
          if (error instanceof AuthError && error.status === 401) {
            if (active) router.replace("/application");
          } else throw error;
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof AuthError && error.kind === "unauthorized") router.replace("/login");
        else setError(merchantError(error));
      }
    }
    void route();
    return () => { active = false; };
  }, [router]);
  return (
    <main>
      {error ? (
        <>
          <p className="auth-error" role="alert">{error}</p>
          <button onClick={() => window.location.reload()}>Try again</button>
        </>
      ) : <p role="status">Opening your merchant workspace…</p>}
    </main>
  );
}
