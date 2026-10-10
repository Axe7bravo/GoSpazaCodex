"use client";

import { useEffect, useRef, useState } from "react";
import { createDeliveryClient } from "@gospaza/api-client";
import type { DeliveryAvailability, DeliverySelection, SelectDeliveryInput, ReleaseDeliveryInput } from "@gospaza/contracts";
import { useDiscoveryLocation } from "./shell";

const client = createDeliveryClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const money = (minor: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(minor / 100);
function date(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-ZA", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
interface Controls {
  refresh(): void;
  select(input: SelectDeliveryInput): void;
  release(input: ReleaseDeliveryInput): void;
}

export function DeliveryPanel({ cartId }: { cartId: string }) {
  const { location } = useDiscoveryLocation();
  const [selection, setSelection] = useState<DeliverySelection | null>(null);
  const [availability, setAvailability] = useState<{ key: string; data: DeliveryAvailability } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [deadlinePending, setDeadlinePending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [optionId, setOptionId] = useState("");
  const [slotId, setSlotId] = useState("");
  const controls = useRef<Controls | null>(null);
  const locationKey = JSON.stringify(location);

  useEffect(() => {
    // Each location/cart lifecycle owns its cancellation and request generation.
    // Late responses cannot restore a previous location's quote or selection.
    let active = true;
    let generation = 0;
    let writing = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let checkedElapsedExpiry: string | null = null;
    const message = (cause: unknown) => cause instanceof Error ? cause.message : "Delivery could not be loaded. Please try again.";
    function apply(value: DeliverySelection) {
      setSelection(value);
      if (value.state !== "held" && value.state !== "unselected") {
        setNotice("Your delivery selection is " + value.state + ". Review availability and confirm a new selection.");
      }
      clearTimeout(expiryTimer);
      if (value.state === "held" && value.selection) {
        // This timer only requests authoritative expiry evaluation. It never
        // releases, renews, or decides whether a reservation is valid.
        const expiry = value.selection.expires_at;
        const delay = Date.parse(expiry) - Date.now();
        setDeadlinePending(delay <= 0);
        if (delay > 0 || checkedElapsedExpiry !== expiry) {
          // An elapsed response still needs one authoritative read. Limit the
          // immediate check per deadline so browser clock skew cannot poll-loop.
          if (delay <= 0) checkedElapsedExpiry = expiry;
          expiryTimer = setTimeout(() => {
            if (!active) return;
            setDeadlinePending(true);
            refresh();
          }, Math.min(Math.max(0, delay), 2147483647));
        }
      }
    }
    async function read() {
      const version = ++generation;
      let restored = false;
      try {
        const value = await client.current(cartId);
        if (!active || version !== generation) return;
        apply(value);
        restored = true;
        setVerified(true);
        // Restoration must stay usable when location/availability is missing.
        const available = location ? await client.availability(cartId, location) : null;
        if (!active || version !== generation) return;
        setAvailability(available ? { key: locationKey, data: available } : null);
      } catch (cause) {
        if (!active || version !== generation) return;
        if (!restored) setVerified(false);
        setAvailability(null);
        setError(message(cause));
      } finally {
        if (active && version === generation) { setLoading(false); setBusy(false); }
      }
    }
    function refresh() {
      if (!active || writing) return;
      setLoading(true);
      setError("");
      void read();
    }
    async function mutate(operation: () => Promise<DeliverySelection>) {
      if (!active || writing) return;
      writing = true;
      ++generation;
      setBusy(true);
      setError("");
      setNotice("");
      clearTimeout(expiryTimer);
      try {
        const value = await operation();
        if (!active) return;
        apply(value);
        setOptionId("");
        setSlotId("");
      } catch (cause) {
        if (!active) return;
        setNotice(message(cause));
        setOptionId("");
        setSlotId("");
      } finally {
        if (active) {
          writing = false;
          // Always re-read; never replay a write after an ambiguous response.
          setLoading(true);
          await read();
        }
      }
    }
    controls.current = {
      refresh,
      select: (input) => { void mutate(() => client.select(input)); },
      release: (input) => { void mutate(() => client.release(input)); },
    };
    const foreground = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    void read();
    return () => {
      active = false;
      clearTimeout(expiryTimer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [cartId, location, locationKey]);

  const available = availability?.key === locationKey ? availability.data : null;
  const option = available?.options.find((item) => item.id === optionId);
  const slot = available?.slots.find((item) => item.id === slotId);
  const held = selection?.state === "held" ? selection.selection : null;
  const disabled = loading || busy;
  return <section className="delivery-panel" aria-labelledby="delivery-heading" aria-busy={disabled}>
    <h3 id="delivery-heading">Delivery</h3>
    {loading && <p role="status">Checking delivery…</p>}
    {busy && <p role="status">Saving delivery selection…</p>}
    {notice && <p role="status" className="cart-warning">{notice}</p>}
    {error && <p role="alert" className="shop-error">{error}</p>}
    <button type="button" disabled={busy} onClick={() => controls.current?.refresh()}>Refresh delivery</button>
    {held && selection?.timezone && <div className="delivery-hold">
      <h4>{verified && !deadlinePending ? "Reserved delivery window" : "Last reported delivery window — refresh required"}</h4>
      <p>{date(held.start_at, selection.timezone)} – {date(held.end_at, selection.timezone)} ({selection.timezone})</p>
      <p>Delivery quote: <strong>{money(held.fee_minor)}</strong></p>
      <p>Hold expires <time dateTime={held.expires_at}>{date(held.expires_at, selection.timezone)}</time>. Refreshing does not extend this hold.</p>
      <button type="button" disabled={disabled || !verified} onClick={() => controls.current?.release({
        cart_id: cartId, reservation_id: held.id, expected_revision: selection.revision,
      })}>Release delivery selection</button>
    </div>}
    {!held && !loading && !error && <p>No active delivery reservation.</p>}
    {!location && <p>Choose a delivery location to see options. You can still release an existing reservation.</p>}
    {available && location && <fieldset disabled={disabled}>
      <legend>{held ? "Change delivery selection" : "Choose delivery"}</legend>
      {!available.options.length && <p>No delivery options are available for this location.</p>}
      <label htmlFor="delivery-option">Delivery option</label>
      <select id="delivery-option" value={option?.id ?? ""} onChange={(event) => { setOptionId(event.target.value); setSlotId(""); }}>
        <option value="">Choose an option</option>
        {available.options.map((item) => <option key={item.id} value={item.id}>
          {item.mode === "ASAP" ? "ASAP — earliest available window" : "Scheduled delivery"} — {money(item.fee_minor)}
        </option>)}
      </select>
      {option?.mode === "SCHEDULED" && <div>
        <label htmlFor="delivery-slot">Delivery date and time</label>
        <select id="delivery-slot" value={slot?.id ?? ""} onChange={(event) => setSlotId(event.target.value)}>
        <option value="">Choose a window</option>
        {available.slots.map((item) => <option key={item.id} value={item.id} disabled={item.remaining <= 0}>
          {date(item.start_at, available.timezone)} – {date(item.end_at, available.timezone)} ({available.timezone})
        </option>)}
      </select></div>}
      {option && <p>Delivery quote: <strong>{money(option.fee_minor)}</strong>. Capacity and fee are checked again when you confirm.</p>}
      {!available.slots.some((item) => item.remaining > 0) && <p>No delivery windows are currently available.</p>}
      <button type="button" disabled={!option || (option.mode === "SCHEDULED" && (!slot || slot.remaining <= 0)) || !available.slots.some((item) => item.remaining > 0)}
        onClick={() => {
          if (!option) return;
          controls.current?.select({ cart_id: cartId, location, option_id: option.id,
            ...(option.mode === "SCHEDULED" && slot ? { slot_id: slot.id } : {}),
            expected_revision: available.revision, expected_option_revision: option.revision });
        }}>Confirm delivery selection</button>
    </fieldset>}
    <p className="muted">This reserves a delivery window only. Checkout verifies your final delivery and total.</p>
  </section>;
}
