"use client";
import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SessionBoundary } from "@gospaza/ui/auth";
import { createLocationClient, createStorefrontClient } from "@gospaza/api-client";
import type { DiscoveryLocation, SavedAddress } from "@gospaza/contracts";
import { authClient } from "../auth-client";

export const storefront = createStorefrontClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const addressesClient = createLocationClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const LocationContext = createContext<{ location: DiscoveryLocation | null; revision: number; refresh: () => void } | null>(null);
export function useDiscoveryLocation() {
  const context = useContext(LocationContext);
  if (!context) throw new Error("Storefront location provider is required.");
  return context;
}
function LocationProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<DiscoveryLocation | null>(null);
  const [revision, setRevision] = useState(0);
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const life = useRef({ active: false, generation: 0 });
  useEffect(() => {
    const current = { active: true, generation: 0 };
    life.current = current;
    const refresh = () => setRevision((value) => value + 1);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      current.active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const refresh = () => setRevision((value) => value + 1);
  function locate() {
    const current = life.current, generation = ++current.generation;
    setLocation(null); setError("");
    if (!navigator.geolocation) { setError("Current location is unavailable in this browser."); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition((position) => {
      if (!current.active || current.generation !== generation) return;
      setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setBusy(false);
    }, (failure) => {
      if (!current.active || current.generation !== generation) return;
      setError(failure.code === 1 ? "Location permission denied. Choose a saved address with coordinates." : "Current location is unavailable. Please try again.");
      setBusy(false);
    }, { timeout: 10000, maximumAge: 0 });
  }
  async function loadAddresses() {
    const current = life.current, generation = ++current.generation;
    setBusy(true); setError("");
    try {
      const result = await addressesClient.addresses();
      if (current.active && current.generation === generation) setAddresses(result.addresses);
    } catch (error) {
      if (current.active && current.generation === generation) setError(error instanceof Error ? error.message : "Addresses unavailable.");
    } finally {
      if (current.active && current.generation === generation) setBusy(false);
    }
  }
  return <LocationContext.Provider value={{ location, revision, refresh }}>
    <nav className="shop-nav" aria-label="Shopping"><Link href="/">Home</Link><Link href="/stores">Stores</Link><Link href="/search">Search</Link><Link href="/account">Account</Link></nav>
    <section className="location-panel" aria-label="Delivery location">
      <div><strong>Your neighbourhood</strong><p>{location ? "Location selected. Availability is checked with each request." : "Choose where you want to shop."}</p></div>
      <button disabled={busy} onClick={locate}>Use current location</button>
      <button disabled={busy} onClick={() => void loadAddresses()}>Choose saved address</button>
      {location && <button onClick={() => { ++life.current.generation; setLocation(null); setBusy(false); setError(""); }}>Change location</button>}
      {location && <button disabled={busy} onClick={refresh}>Check location again</button>}
      {busy && <p role="status">Checking location…</p>}
      {error && <p role="alert" className="shop-error">{error}</p>}
      {addresses && <div className="saved-locations">
        <label>Saved address<select value={location && "address_id" in location ? location.address_id : ""} disabled={busy}
          onChange={(event) => { setLocation(event.target.value ? { address_id: event.target.value } : null); setError(""); }}>
          <option value="">Choose an address</option>
          {addresses.filter((address) => address.location).map((address) => <option key={address.id} value={address.id}>{address.address_1}, {address.city}</option>)}
        </select></label>
        {!addresses.some((address) => address.location) && <p>No saved addresses with coordinates.</p>}
        <Link href="/account/addresses">Manage delivery addresses</Link>
      </div>}
    </section>
    {children}
  </LocationContext.Provider>;
}
export function StorefrontShell({ children }: { children: ReactNode }) {
  return <main className="storefront">
    <SessionBoundary client={authClient} title="Shop your neighbourhood">
      {(_identity, customer) => <LocationProvider key={customer?.id}>{children}</LocationProvider>}
    </SessionBoundary>
  </main>;
}
