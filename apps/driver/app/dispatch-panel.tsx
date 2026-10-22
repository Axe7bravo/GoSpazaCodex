"use client";
import { useEffect, useState } from "react";
import { createDispatchClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback } from "@gospaza/ui/drivers";
const client = createDispatchClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
const load = async () => {
  const [availability, current] = await Promise.all([client.availability(), client.current()]);
  return { availability, ...current };
};
export default function DispatchPanel({ eligible }: { eligible: boolean }) {
  const resource = useDriverResource(load, denied);
  const { refresh } = resource;
  const [locationError, setLocationError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const state = resource.data, offer = state?.commitment;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // Bounded foreground observation, never an acceptance/expiry command.
    if (state?.availability.intent !== "ONLINE" && offer?.status !== "OFFERED") return;
    let remaining = 60;
    const timer = setInterval(() => {
      if (--remaining < 0) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [state?.availability.intent, offer?.status, refresh]);
  async function shareLocation() {
    const availability = state?.availability;
    if (!availability?.generation) return;
    const generation = availability.generation;
    setLocationError("");
    await resource.mutate(async () => {
      if (!navigator.geolocation) { setLocationError("Location is unavailable on this device."); return; }
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 0, timeout: 10000, enableHighAccuracy: true }))
        .catch(() => { setLocationError("Location could not be obtained. Check permission and try sharing it again."); return null; });
      if (!position) return;
      await client.location({ generation, sequence: (availability.location_sequence ?? 0) + 1,
        latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy });
    });
  }
  const expired = !!offer && Date.parse(offer.expires_at) <= now;
  const fresh = !!state?.availability.location_fresh && (!state.availability.location_expires_at
    || Date.parse(state.availability.location_expires_at) > now);
  return <section className="driver-card" aria-label="Delivery work">
    <h2>Delivery work</h2>
    <DriverFeedback loading={!state} error={resource.error} notice={resource.notice} />
    <button disabled={resource.busy} onClick={() => void resource.refresh()}>Refresh delivery work</button>
    {state && <>
      <p>Intent: {state.availability.intent === "ONLINE" ? "Online" : "Offline"}</p>
      <p>{state.availability.effective === "AVAILABLE" && fresh ? "Available for new offers"
        : state.availability.effective === "BUSY" ? "Capacity reserved for your delivery"
        : "Not available for new offers"}</p>
      {!eligible && <p>Your profile or affiliation is not currently eligible for new delivery work.</p>}
      {state.availability.intent === "ONLINE" && !fresh &&
        <p>A fresh location is required for new offers. If location service restarted, go offline and online again.</p>}
      <button disabled={resource.busy || state.availability.intent === "OFFLINE" && !eligible}
        onClick={() => void resource.mutate(() => client.intent(state.availability.intent !== "ONLINE", state.availability.revision))}>
        {state.availability.intent === "ONLINE" ? "Go offline" : "Go online"}
      </button>
      {state.availability.intent === "ONLINE" && <button disabled={resource.busy} onClick={() => void shareLocation()}>Share current location</button>}
      {locationError && <p role="alert">{locationError}</p>}
      {!offer && <p>No current delivery offer or assignment.</p>}
      {offer && <article>
        <h3>{offer.status === "ASSIGNED" ? "Assigned delivery" : "Delivery offer"}</h3>
        <p>Pickup: {offer.pickup_store ?? "Your assigned store"}</p>
        <p>Delivery area: {offer.destination_area ?? "Service area"}</p>
        {offer.restricted_content_present && <p>Restricted items in this delivery</p>}
        {offer.attention_required && <p>This delivery needs operational attention. Your commitment remains recorded.</p>}
        {offer.status === "OFFERED" && <>
          <p>{expired ? "Offer time has elapsed. Refresh for the latest state." : "Offer expires in " + Math.max(0, Math.ceil((Date.parse(offer.expires_at) - now) / 1000)) + " seconds."}</p>
          <p>The server confirms whether this offer is still available.</p>
          <button disabled={resource.busy || expired || offer.attention_required}
            onClick={() => void resource.mutate(() => client.decide(offer.id, "accept", offer.revision))}>Accept offer</button>
          <button disabled={resource.busy || expired}
            onClick={() => void resource.mutate(() => client.decide(offer.id, "decline", offer.revision))}>Decline offer</button>
        </>}
        {offer.status === "ASSIGNED" && <p>Your assignment remains recorded when you go offline. Pickup controls are not available yet.</p>}
      </article>}
    </>}
  </section>;
}
