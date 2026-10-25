"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createDispatchClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
const denied = () => window.location.replace("/login");
function VisibleDelivery({ id }: { id: string }) {
  const client = useMemo(() => createDispatchClient(process.env.NEXT_PUBLIC_API_URL!, fetch, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ""), []);
  const load = useCallback(async () => {
    const tracking = await client.tracking(id);
    const code = tracking.state === "ARRIVED" ? await client.handoffCode(id) : null;
    return { tracking, code };
  }, [id, client]);
  const resource = useDriverResource(load, denied);
  const { refresh } = resource;
  const [now, setNow] = useState(() => Date.now());
  const phase = resource.data?.tracking.state;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (phase === "DELIVERED") return;
    let remaining = 40;
    const timer = setInterval(() => {
      if (--remaining < 0) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [phase, refresh]);
  const value = resource.data, code = value?.code, sample = value?.tracking.tracking;
  const active = phase === "IN_TRANSIT" || phase === "ARRIVED";
  const fresh = sample?.expires_at && Date.parse(sample.expires_at) > now;
  const visibleCode = !resource.busy && phase === "ARRIVED" && code?.state === "AVAILABLE" && code.expires_at && Date.parse(code.expires_at) > now;
  return <section aria-label="Tracking and handoff">
    <h3>Tracking and handoff</h3>
    {resource.error && <p role="alert">Delivery information is unavailable. Refresh to check again.</p>}
    {resource.notice && <p role="status">Check the latest handoff state before requesting another code.</p>}
    <button disabled={resource.busy} onClick={() => void refresh()}>Refresh tracking and code</button>
    {!value && !resource.error && <p role="status">Loading delivery information…</p>}
    {active && <>
      {fresh && sample ? <p aria-label="Courier location">Current courier location: {sample.latitude.toFixed(5)}, {sample.longitude.toFixed(5)}. Updated {new Date(sample.recorded_at).toLocaleTimeString("en-ZA")}.</p>
        : <p>Courier location is currently unavailable. This does not prevent handoff.</p>}
    </>}
    {phase === "ARRIVED" && code && <>
      {code.compliance_required && <p>Additional handoff verification required.</p>}
      {visibleCode && code.expires_at ? <>
        <p>Share this code only at handoff.</p><output aria-label="Handoff code">{code.code}</output>
        <p>Expires at {new Date(code.expires_at).toLocaleTimeString("en-ZA")}. Refreshing does not extend expiry.</p>
      </> : <p>The handoff code is unavailable, expired or exhausted. Refresh for the current state.</p>}
      <button disabled={resource.busy || code.can_regenerate !== true}
        onClick={() => void resource.mutate(() => client.regenerateHandoff(id, code.revision))}>Request new handoff code</button>
      {!code.can_regenerate && <p>A new code is not currently available. Refresh after the cooldown, or wait for operational review if the limit is reached.</p>}
    </>}
    {phase === "ATTENTION_REQUIRED" && <p>Delivery needs attention. This does not confirm cancellation or a refund.</p>}
    {phase === "DELIVERED" && <p>Delivery completed. Location and handoff code are no longer available.</p>}
  </section>;
}
export default function CustomerDelivery({ id }: { id: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  // Unmount sensitive response state when hidden; no browser persistence.
  return visible ? <VisibleDelivery key={id} id={id} /> : null;
}
