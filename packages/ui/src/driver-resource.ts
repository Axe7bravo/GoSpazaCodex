"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "@gospaza/api-client";

/** Request lifecycle only: domain decisions and eligibility remain server-owned. */
export function useDriverResource<T>(load: () => Promise<T>, denied: () => void) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<{ active: boolean; generation: number; writing: boolean } | null>(null);
  const refresh = useCallback(async () => {
    const scope = lifetime.current;
    if (!scope?.active || scope.writing) return false;
    const generation = ++scope.generation;
    try {
      const result = await load();
      if (!scope.active || generation !== scope.generation) return false;
      setData(result); setError("");
      return true;
    } catch (cause) {
      if (!scope.active || generation !== scope.generation) return false;
      setData(undefined);
      setError(cause instanceof AuthError ? cause.message : "Unable to load driver information. Please refresh.");
      if (cause instanceof AuthError && cause.status === 401) denied();
      return false;
    }
  }, [load, denied]);
  useEffect(() => {
    const scope = { active: true, generation: 0, writing: false };
    lifetime.current = scope;
    void refresh();
    const foreground = () => {
      if (document.visibilityState === "visible" && !scope.writing) { setData(undefined); void refresh(); }
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      scope.active = false;
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh]);
  async function mutate(write: () => Promise<unknown>) {
    const scope = lifetime.current;
    if (!scope?.active || scope.writing) return;
    scope.writing = true;
    ++scope.generation; // Older reads must not overwrite the mutation's readback.
    setBusy(true); setNotice(""); setError("");
    let message = "Saved. Showing the latest state.";
    try { await write(); }
    catch (cause) {
      message = cause instanceof AuthError && cause.status === 409
        ? "Details changed. The latest state has been loaded. Review it before a new action."
        : cause instanceof AuthError ? cause.message : "The result could not be confirmed. Refresh before trying again.";
      if (scope.active && cause instanceof AuthError && cause.status === 401) denied();
    }
    if (!scope.active) return;
    scope.writing = false;
    setData(undefined);
    const refreshed = await refresh(); // No mutation replay, including uncertain network outcomes.
    if (scope.active) {
      setNotice(refreshed ? message : "The latest state could not be confirmed. Refresh before another action.");
      setBusy(false);
    }
  }
  return { data, error, notice, busy, refresh, mutate };
}
