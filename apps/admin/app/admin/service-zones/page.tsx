"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { SessionBoundary } from "@gospaza/ui/auth";
import { createLocationClient } from "@gospaza/api-client";
import type { ServiceZoneInput, ZoneDetail, ZoneList, ZoneGeometry } from "@gospaza/contracts";
import { authClient } from "../../auth-client";

const client = createLocationClient(process.env.NEXT_PUBLIC_API_URL!);
const blank = { name: "", active: true, fee: "0", geometry: "" };
function Zones() {
  const [list, setList] = useState<ZoneList>({ zones: [], stores: [] });
  const [detail, setDetail] = useState<ZoneDetail | null>(null);
  const [form, setForm] = useState(blank);
  const [store, setStore] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const life = useRef({ active: false });
  useEffect(() => {
    const current = { active: true };
    life.current = current;
    void client.zones().then((data) => { if (current.active) setList(data); })
      .catch((e: unknown) => { if (current.active) setError(e instanceof Error ? e.message : "Could not load zones."); })
      .finally(() => { if (current.active) setLoading(false); });
    return () => { current.active = false; };
  }, []);
  async function action(work: () => Promise<void>) {
    const current = life.current;
    setBusy(true); setError("");
    try { await work(); }
    catch (e) { if (current.active) setError(e instanceof Error ? e.message : "Request failed."); }
    finally { if (current.active) setBusy(false); }
  }
  function show(data: ZoneDetail) {
    setDetail(data);
    setForm({ name: data.zone.name, active: data.zone.active, fee: String(data.zone.delivery_fee_minor), geometry: JSON.stringify(data.zone.geometry, null, 2) });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const current = life.current;
    await action(async () => {
      let geometry: ZoneGeometry;
      try { geometry = JSON.parse(form.geometry) as ZoneGeometry; }
      catch { throw new Error("Enter valid GeoJSON JSON."); }
      const data: ServiceZoneInput = { name: form.name, active: form.active, geometry,
        delivery_fee_minor: Number(form.fee), currency_code: "zar" };
      const updated = await client.saveZone(data, detail?.zone.id);
      const refreshed = await client.zones();
      if (current.active) { show(updated); setList(refreshed); }
    });
  }
  return <>
    {loading && <p role="status">Loading service zones…</p>}
    {error && <><p role="alert">{error}</p><button disabled={busy} onClick={() => {
      const current = life.current;
      void action(async () => {
        const data = await client.zones();
        if (current.active) setList(data);
      });
    }}>Reload zones</button></>}
    {!loading && !error && !list.zones.length && <p>No service zones configured.</p>}
    <ul>{list.zones.map((zone) => <li key={zone.id}>
      <button disabled={busy} onClick={() => {
        const current = life.current;
        void action(async () => { const data = await client.zone(zone.id); if (current.active) show(data); });
      }}>{zone.name}</button> — {zone.active ? "Active" : "Inactive"} — {zone.delivery_fee_minor} ZAR cents
    </li>)}</ul>
    <button disabled={busy} onClick={() => { setDetail(null); setForm(blank); setError(""); }}>New zone</button>
    <h2>{detail ? "Edit zone" : "Create zone"}</h2>
    <form onSubmit={save}>
      <fieldset disabled={busy || loading}>
        <label>Zone name<input required maxLength={150} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />Active zone</label>
        <label>Delivery fee (ZAR cents)<input required type="number" min="0" max="2147483647" step="1" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></label>
        <label>GeoJSON geometry<textarea required rows={14} value={form.geometry} onChange={(e) => setForm({ ...form, geometry: e.target.value })} /></label>
        <p>Use Polygon or MultiPolygon with closed longitude/latitude rings. Outer and hole boundaries are included. Maximum 2000 coordinates; antimeridian edges are unsupported.</p>
        <button type="submit">Save zone</button>
      </fieldset>
    </form>
    {detail && <section>
      <h2>Assigned stores</h2>
      {!detail.assignments.some((a) => a.active) && <p>No active assignments.</p>}
      <ul>{detail.assignments.map((assignment) => <li key={assignment.id}>
        {assignment.name} — {assignment.active ? "Active" : "Inactive"}
        {assignment.active && <button disabled={busy} onClick={() => {
          const current = life.current;
          void action(async () => { const data = await client.unassign(detail.zone.id, assignment.id); if (current.active) setDetail(data); });
        }}>Unassign {assignment.name}</button>}
      </li>)}</ul>
      <label htmlFor="zone-store">Merchant store</label>
      <select id="zone-store" value={store} disabled={busy} onChange={(e) => setStore(e.target.value)}>
        <option value="">Choose a store</option>
        {list.stores.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.active && item.merchant_status === "ACTIVE" ? "active" : "inactive"})</option>)}
      </select>
      <button disabled={busy || !store} onClick={() => {
        const current = life.current;
        void action(async () => { const data = await client.assign(detail.zone.id, store); if (current.active) setDetail(data); });
      }}>Assign store</button>
    </section>}
  </>;
}
export default function Page() {
  return <main className="auth-layout admin">
    <Link href="/">Platform admin portal</Link>
    <SessionBoundary client={authClient} title="Service zones">{(identity) => <Zones key={"id" in identity ? identity.id : "unauthorized"} />}</SessionBoundary>
  </main>;
}
