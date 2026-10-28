"use client";
import { useEffect, useState } from "react";
import { createDispatchClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import RecipientPanel from "./recipient-panel";
const client = createDispatchClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
const load = async () => {
  const { pickup } = await client.pickup();
  const { handoff } = await client.latestHandoff();
  return { pickup, handoff };
};
function HandoffCodeForm({ busy, submit }: { busy: boolean; submit: (code: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  useEffect(() => {
    const clear = () => { if (document.visibilityState !== "visible") setCode(""); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  return <form onSubmit={event => {
    event.preventDefault();
    if (!busy && /^\d{6}$/.test(code)) { const candidate = code; setCode(""); void submit(candidate); }
  }}>
    <label>Customer handoff code<input aria-label="Customer handoff code" type="password" inputMode="numeric" autoComplete="off"
      maxLength={6} value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
    <button disabled={busy || !/^\d{6}$/.test(code)} type="submit">Confirm handoff</button>
  </form>;
}
export default function DeliveryPanel({ changed }: { changed: () => Promise<unknown> }) {
  const resource = useDriverResource(load, denied);
  const { refresh } = resource;
  const [location, setLocation] = useState("");
  const pickup = resource.data?.pickup, handoff = resource.data?.handoff;
  const phase = handoff?.state === "UNAVAILABLE" ? pickup?.state : handoff?.state;
  useEffect(() => { if (phase === "DELIVERED") void changed(); }, [phase, changed]);
  useEffect(() => {
    if (!handoff?.delivery_id || handoff?.state === "DELIVERED") return;
    let remaining = 120;
    const timer = setInterval(() => {
      if (--remaining < 0) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [handoff?.delivery_id, handoff?.state, refresh]);
  async function act(write: () => Promise<unknown>) {
    await resource.mutate(write); // One write, then authoritative readback, even on response loss.
    await changed();
  }
  async function share() {
    if (!handoff) return;
    setLocation("");
    await act(async () => {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error("Unavailable")); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 0, timeout: 10000, enableHighAccuracy: true });
      }).catch(() => null);
      if (!position) { setLocation("Location unavailable. Check permission and share again. Handoff does not require GPS."); return; }
      const generation = await client.beginTracking(handoff.delivery_id, handoff.revision);
      await client.trackingLocation({ generation: generation.generation, sequence: 1,
        latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
      setLocation("Current delivery location shared.");
    });
  }
  return <section className="driver-card" aria-label="Pickup and handoff">
    <h2>Pickup and handoff</h2>
    {resource.error && <p role="alert">Delivery information is unavailable. Refresh before another action.</p>}
    {resource.notice && <p role="status">The latest delivery state has been requested. Check it before another action.</p>}
    <button disabled={resource.busy} onClick={() => void refresh()}>Refresh pickup and handoff</button>
    {!resource.data && !resource.error && <p role="status">Loading delivery progress…</p>}
    {resource.data && !handoff && <p>No delivery to pick up or hand over.</p>}
    {phase === "PREPARING" && <p>Pickup is not ready yet.</p>}
    {phase === "PICKUP_READY" && pickup && <>
      <p>Ready for pickup</p>
      <button disabled={resource.busy} onClick={() => void act(() => client.confirmPickup(pickup.delivery_id, pickup.revision))}>Confirm pickup</button>
    </>}
    {phase === "PICKUP_PENDING" && <p>Confirming pickup. Your delivery remains reserved.</p>}
    {phase === "ATTENTION_REQUIRED" && <p>Delivery needs attention. Your assignment remains recorded. Refresh for a confirmed outcome.</p>}
    {phase === "IN_TRANSIT" && handoff && <>
      <p>In transit</p>
      <button disabled={resource.busy} onClick={() => void act(() => client.arrive(handoff.delivery_id, handoff.revision))}>Mark arrived</button>
    </>}
    {(phase === "IN_TRANSIT" || phase === "ARRIVED") && <>
      <button disabled={resource.busy} onClick={() => void share()}>Share delivery location</button>
      {location && <p role="status">{location}</p>}
      <p>Location sharing does not mark arrival or complete delivery.</p>
    </>}
    {phase === "ARRIVED" && handoff && <>
      <p>Driver arrived</p>
      {handoff.compliance_required ? <p>Additional restricted handoff verification is required. Delivery completion is unavailable.</p> :
        <HandoffCodeForm key={handoff.delivery_id + ":" + resource.busy} busy={resource.busy}
          submit={candidate => act(() => client.verifyHandoff(handoff.delivery_id, handoff.revision, candidate))} />}
    </>}
    {phase === "DELIVERED" && <p role="status">Delivered</p>}
    {handoff && (handoff.restricted_content_present || handoff.compliance_required || handoff.state.startsWith("RETURN")) && phase !== "DELIVERED" &&
      <RecipientPanel key={handoff.delivery_id + ":" + handoff.revision} id={handoff.delivery_id} phase={phase ?? "UNAVAILABLE"} changed={refresh} />}
  </section>;
}
