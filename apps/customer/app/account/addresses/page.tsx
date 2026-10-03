"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createLocationClient } from "@gospaza/api-client";
import type { AddressWrite, SavedAddress, Serviceability } from "@gospaza/contracts";
import { SessionBoundary } from "@gospaza/ui/auth";
import { authClient } from "../../auth-client";

const client = createLocationClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const blank: AddressWrite = { first_name: "", last_name: "", address_1: "", address_2: "", city: "", province: "", postal_code: "", country_code: "za", phone: "", location: null };
const fields = [
  ["first_name", "First name"], ["last_name", "Last name"], ["address_1", "Address line 1"],
  ["address_2", "Address line 2"], ["city", "City"], ["province", "Province"],
  ["postal_code", "Postal code"], ["phone", "Phone"],
] as const;
function Addresses() {
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [form, setForm] = useState<AddressWrite>(blank);
  const [id, setId] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Serviceability | null>(null);
  const life = useRef({ active: false, revision: 0 });
  useEffect(() => {
    const current = { active: true, revision: 0 };
    life.current = current;
    void client.addresses().then((data) => {
      if (current.active) setAddresses(data.addresses);
    }).catch((e: unknown) => {
      if (current.active) setError(e instanceof Error ? e.message : "Could not load addresses.");
    }).finally(() => { if (current.active) setLoading(false); });
    return () => { current.active = false; };
  }, []);
  async function action(work: () => Promise<void>) {
    const current = life.current;
    setBusy(true); setError("");
    try { await work(); }
    catch (e) { if (current.active) setError(e instanceof Error ? e.message : "Request failed."); }
    finally { if (current.active) setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const current = life.current;
    await action(async () => {
      await client.saveAddress(form, id);
      const data = await client.addresses();
      if (current.active) { setAddresses(data.addresses); setId(undefined); setForm(blank); setResult(null); }
    });
  }
  function locate() {
    const current = life.current, revision = ++current.revision;
    setResult(null); setError("");
    if (!navigator.geolocation) { setError("Current location is unavailable in this browser."); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition((position) => {
      if (!current.active || revision !== current.revision) return;
      setForm((value) => ({ ...value, location: {
        latitude: position.coords.latitude, longitude: position.coords.longitude, source: "browser_geolocation",
      } }));
      setBusy(false);
    }, (failure) => {
      if (!current.active || revision !== current.revision) return;
      setError(failure.code === 1 ? "Location permission denied. You can still save your address without coordinates." : "Current location is unavailable. Please try again.");
      setBusy(false);
    }, { timeout: 10000, maximumAge: 0 });
  }
  return <>
    {loading && <p role="status">Loading addresses…</p>}
    {error && <><p role="alert">{error}</p><button disabled={busy} onClick={() => {
      const current = life.current;
      void action(async () => {
        const data = await client.addresses();
        if (current.active) setAddresses(data.addresses);
      });
    }}>Reload addresses</button></>}
    {!loading && !error && !addresses.length && <p>No saved addresses.</p>}
    <ul>{addresses.map((address) => <li key={address.id}>
      <strong>{address.address_1}</strong>, {address.city}
      <button disabled={busy} onClick={() => {
        const { id: addressId, ...data } = address;
        setId(addressId); setForm({ ...blank, ...data }); setResult(null); setError("");
      }}>Edit {address.address_1}</button>
      <button disabled={busy} onClick={() => {
        const current = life.current;
        void action(async () => {
          await client.deleteAddress(address.id);
          const data = await client.addresses();
          if (current.active) { setAddresses(data.addresses); setForm(blank); setId(undefined); setResult(null); }
        });
      }}>Delete {address.address_1}</button>
    </li>)}</ul>
    <h2>{id ? "Edit address" : "New address"}</h2>
    <form onSubmit={save}>
      <fieldset disabled={busy || loading}>
        {fields.map(([key, label]) => <label key={key}>{label}<input
          value={form[key] ?? ""} required={key !== "address_2" && key !== "phone"}
          onChange={(event) => { setForm({ ...form, [key]: event.target.value }); setResult(null); }}
        /></label>)}
        <p>Country: South Africa</p>
        <button type="button" onClick={locate}>Use current location</button>
        <p>{form.location ? "Coordinates attached: " + form.location.latitude + ", " + form.location.longitude : "No coordinates attached."}</p>
        <p>Current location attaches your device coordinates; it does not verify the typed address.</p>
        {form.location && <button type="button" onClick={() => { setForm({ ...form, location: null }); setResult(null); }}>Remove coordinates</button>}
        <button type="button" disabled={!form.location} onClick={() => {
          const point = form.location, current = life.current;
          setResult(null);
          if (point) void action(async () => {
            const data = await client.serviceability(point.latitude, point.longitude);
            if (current.active) setResult(data);
          });
        }}>Check serviceability</button>
        <button type="submit">Save address</button>
        {id && <button type="button" onClick={() => { setId(undefined); setForm(blank); setResult(null); }}>Cancel edit</button>}
      </fieldset>
    </form>
    {result && <p role="status">{result.serviceable ? "Delivery is available at these coordinates." : "Delivery is not available at these coordinates."}</p>}
  </>;
}
export default function Page() {
  return <main className="auth-layout customer">
    <Link href="/account">Your account</Link>
    <SessionBoundary client={authClient} title="Delivery addresses">{(_identity, customer) => <Addresses key={customer?.id} />}</SessionBoundary>
  </main>;
}
