"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SessionBoundary } from "@gospaza/ui/auth";
import { checkoutRedirect, createCartClient, createCheckoutClient, createDeliveryClient, createLocationClient } from "@gospaza/api-client";
import type { CartFoundation, CheckoutAttemptInput, CheckoutPreparation, CustomerCheckoutStatus, DeliverySelection, SavedAddress } from "@gospaza/contracts";
import { authClient } from "../auth-client";

const base = process.env.NEXT_PUBLIC_API_URL!;
const key = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "";
const checkout = createCheckoutClient(base, key);
const carts = createCartClient(base, key);
const delivery = createDeliveryClient(base, key);
const locations = createLocationClient(base, key);
const money = (minor: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(minor / 100);
const date = (value: string) => new Date(value).toLocaleString("en-ZA");
const copy: Record<CustomerCheckoutStatus["state"], { title: string; text: string }> = {
  none: { title: "Review checkout", text: "Choose your saved delivery address and review the server-confirmed total." },
  ready_to_pay: { title: "Ready to pay", text: "Your confirmed checkout is reserved. Pay securely with Yoco when you are ready." },
  awaiting_payment: { title: "Awaiting verified payment", text: "We are checking your payment. Do not start another payment. Returning from Yoco does not confirm an Order." },
  reconciliation_pending: { title: "Confirming your order", text: "Your payment and order are still being reconciled. Please do not pay again." },
  recovery_required: { title: "Unable to confirm your order yet", text: "Your payment and order are still being reconciled. Please do not pay again. You can return here for an update." },
  succeeded: { title: "Order confirmed", text: "Your payment and Order have been verified." },
  failed: { title: "Payment was not completed", text: "The backend reported a failed payment. Review your cart and delivery before starting a new checkout." },
  expired: { title: "Checkout attempt expired", text: "This attempt can no longer create an Order. Any later verified payment will be reconciled separately. Review your cart and delivery before starting again." },
  abandoned: { title: "Checkout confirmation released", text: "Review your address, delivery selection and current total before confirming again." },
  refund_pending: { title: "Payment refund is being reconciled", text: "This payment has not produced an Order. A full technical refund is being reconciled; it is not yet confirmed complete." },
  refunded: { title: "Payment refunded", text: "The backend has confirmed the technical refund. This attempt did not produce an Order." },
};
interface Setup { foundation: CartFoundation; addresses: SavedAddress[]; selection: DeliverySelection | null }
interface Actions {
  refresh(): void;
  setup(): void;
  prepare(addressId: string): void;
  confirm(): void;
  pay(): void;
  abandon(): void;
}
function CheckoutContent({ returning }: { returning: boolean }) {
  const [status, setStatus] = useState<CustomerCheckoutStatus | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [prepared, setPrepared] = useState<CheckoutPreparation | null>(null);
  const [addressId, setAddressId] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const actions = useRef<Actions | null>(null);

  useEffect(() => {
    let active = true, writing = false, leaving = false;
    let generation = 0;
    let current: CustomerCheckoutStatus | null = null;
    let readiness: Setup | null = null;
    let preparation: CheckoutPreparation | null = null;
    let selectedAddress = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = (version: number) => active && generation === version;
    const failure = (cause: unknown) => cause instanceof Error ? cause.message : "Checkout is unavailable. Refresh its status before continuing.";
    const attemptInput = (): CheckoutAttemptInput => {
      const attempt = current?.attempt;
      if (!attempt) throw new Error("Refresh checkout before continuing.");
      return { cart_id: attempt.quote.cart_id, attempt_id: attempt.id, checkout_revision: attempt.quote.checkout_revision, confirmed: true };
    };
    async function loadSetup(version: number) {
      const foundation = await carts.current();
      const addresses = await locations.addresses();
      const selection = foundation.cart?.items.length ? await delivery.current(foundation.cart.id) : null;
      if (!alive(version)) return;
      readiness = { foundation, addresses: addresses.addresses, selection };
      setSetup(readiness);
      setAddressId("");
    }
    async function read() {
      const version = ++generation;
      clearTimeout(timer);
      preparation = null;
      try {
        const result = await checkout.status();
        if (!alive(version)) return;
        current = result;
        setStatus(result);
        setPrepared(null);
        setSetup(null);
        setError("");
        if (result.state === "none" && !returning) await loadSetup(version);
        if (alive(version) && ["ready_to_pay", "awaiting_payment", "reconciliation_pending", "recovery_required", "refund_pending"].includes(result.state)) {
          // Polling is read-only: neither browser time nor return query parameters
          // can advance payment, extend capacity, or replay initiation.
          timer = setTimeout(() => { if (active && !writing) void read(); }, 5000);
        }
      } catch (cause) {
        if (alive(version)) { setError(failure(cause)); setPrepared(null); setSetup(null); }
      } finally { if (alive(version)) setLoading(false); }
    }
    async function mutate(label: string, operation: (version: number) => Promise<void>) {
      if (!active || writing) return;
      writing = true;
      const version = ++generation;
      clearTimeout(timer);
      setBusy(label); setError(""); setNotice("");
      try { await operation(version); }
      catch (cause) {
        if (alive(version)) {
          setNotice(failure(cause));
          await read(); // Observe, never automatically replay a write.
        }
      } finally { if (!leaving) { writing = false; if (active) setBusy(""); } }
    }
    actions.current = {
      refresh: () => { if (!writing && active) { setLoading(true); void read(); } },
      setup: () => { void mutate("Loading checkout…", async (version) => {
        preparation = null; setPrepared(null); await loadSetup(version);
      }); },
      prepare: (address) => { void mutate("Preparing checkout…", async (version) => {
        const cart = readiness?.foundation.cart;
        const selection = readiness?.selection;
        if (!cart || selection?.state !== "held") throw new Error("Choose a current delivery selection in your cart first.");
        selectedAddress = address;
        const result = await checkout.prepare({ cart_id: cart.id, address_id: address, expected_reservation_revision: selection.revision });
        if (alive(version)) { preparation = result; setPrepared(result); }
      }); },
      confirm: () => { void mutate("Confirming checkout…", async (version) => {
        if (!preparation || !readiness?.selection) return;
        const result = await checkout.confirm({ cart_id: preparation.quote.cart_id, address_id: selectedAddress,
          expected_reservation_revision: readiness.selection.revision, checkout_revision: preparation.quote.checkout_revision, confirmed: true });
        if (!alive(version)) return;
        if (result.reconfirmation_required) {
          preparation = result; setPrepared(result);
          setNotice("Your checkout changed. Review the updated total and confirm again.");
        } else { await read(); }
      }); },
      pay: () => { void mutate("Starting secure payment…", async (version) => {
        if (current?.state !== "ready_to_pay") return;
        const result = await checkout.pay(attemptInput());
        if (!alive(version)) return;
        if (result.state === "ready" && result.redirect_url) {
          // External navigation only, using the backend's allowlisted URL.
          window.location.assign(checkoutRedirect(result.redirect_url));
          leaving = true;
          return;
        }
        setNotice("Payment is being checked. Refresh status before doing anything else.");
        await read();
      }); },
      abandon: () => { void mutate("Releasing confirmation…", async () => {
        if (current?.state !== "ready_to_pay") return;
        await checkout.abandon(attemptInput());
        await read();
      }); },
    };
    const foreground = () => {
      if (active && !writing && document.visibilityState === "visible") { setLoading(true); void read(); }
    };
    const restored = (event: PageTransitionEvent) => {
      if (!active || !event.persisted) return;
      // A browser back/forward-cache restore must not retain a redirect latch.
      writing = false; leaving = false; setBusy("");
      foreground();
    };
    window.addEventListener("pageshow", restored);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    void read();
    return () => {
      active = false; ++generation; clearTimeout(timer);
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [returning]);

  const quote = prepared?.quote ?? (setup ? undefined : status?.attempt?.quote);
  const view = status ? copy[status.state] : null;
  const disabled = !!busy || loading || !!error;
  const deliveryWindow = setup?.selection?.selection ?? status?.delivery_window;
  return <section className="checkout-page" aria-busy={!!busy || loading}>
    <nav className="shop-nav" aria-label="Checkout"><Link href="/cart">Cart</Link><Link href="/stores">Stores</Link><Link href="/account">Account</Link></nav>
    <h1>{prepared ? "Confirm checkout" : view?.title ?? "Checkout"}</h1>
    {returning && <p>Welcome back. We check GoSpaza for your verified payment and Order status.</p>}
    {view && <p>{view.text}</p>}
    {loading && <p role="status">Checking checkout…</p>}
    {busy && <p role="status">{busy}</p>}
    {notice && <p role="status" className="cart-warning">{notice}</p>}
    {error && <p role="alert" className="shop-error">{error}</p>}
    <button type="button" disabled={!!busy} onClick={() => actions.current?.refresh()}>Refresh checkout status</button>
    <div className="checkout-columns">
      <section aria-label="Delivery details">
        {setup && !prepared && <>
          {setup.foundation.cart?.items.length ? <>
            <h2>{setup.foundation.cart.store.name}</h2>
            <label htmlFor="checkout-address">Delivery address</label>
            <select id="checkout-address" value={addressId} disabled={disabled} onChange={(event) => setAddressId(event.target.value)}>
              <option value="">Choose a saved address</option>
              {setup.addresses.map((address) => <option key={address.id} value={address.id}>{address.address_1}, {address.city}</option>)}
            </select>
            <Link href="/account/addresses">Manage delivery addresses</Link>
            {setup.selection?.state !== "held" && <p>Choose a current delivery selection in your cart first.</p>}
            <button type="button" disabled={disabled || !addressId || setup.selection?.state !== "held"}
              onClick={() => actions.current?.prepare(addressId)}>Review checkout</button>
          </> : <p>Your cart is empty. <Link href="/stores">Browse stores</Link></p>}
        </>}
        {quote?.address && <><h2>Delivery address</h2><address>
          {quote.address.first_name} {quote.address.last_name}<br />
          {quote.address.address_1} {quote.address.address_2}<br />
          {quote.address.city}, {quote.address.province} {quote.address.postal_code}<br />
          {quote.address.phone}
        </address></>}
        {deliveryWindow && <><h2>Delivery window</h2><p>{date(deliveryWindow.start_at)} – {date(deliveryWindow.end_at)}</p></>}
        {status?.attempt?.payment_deadline && <p>Payment deadline: <time dateTime={status.attempt.payment_deadline}>{date(status.attempt.payment_deadline)}</time>. GoSpaza verifies expiry.</p>}
      </section>
      {quote && <section className="checkout-totals" aria-label="Order total">
        <h2>Checkout total</h2>
        <dl><dt>Subtotal</dt><dd>{money(quote.totals.subtotal_minor)}</dd>
          <dt>Discount</dt><dd>{money(quote.totals.discount_total_minor)}</dd>
          <dt>Tax</dt><dd>{money(quote.totals.tax_total_minor)}</dd>
          <dt>Delivery</dt><dd>{money(quote.totals.shipping_total_minor)}</dd>
          <dt>Total to pay</dt><dd><strong>{money(quote.totals.total_minor)}</strong></dd></dl>
        <p>Totals are supplied by GoSpaza checkout. They are checked again before payment.</p>
        {prepared && <button type="button" disabled={disabled} onClick={() => actions.current?.confirm()}>
          {prepared.reconfirmation_required ? "Confirm updated checkout" : "Confirm checkout"}
        </button>}
        {!prepared && status?.state === "ready_to_pay" && <>
          <button type="button" disabled={disabled} onClick={() => actions.current?.pay()}>Pay securely with Yoco</button>
          <button type="button" disabled={disabled} onClick={() => actions.current?.abandon()}>Change checkout details</button>
        </>}
      </section>}
    </div>
    {status?.state === "succeeded" && status.order_id && <section aria-label="Order confirmation">
      <h2>Your Order</h2><p>Order reference: {status.order_id}</p><p>Keep this reference for your records.</p>
    </section>}
    {!setup && !returning && status && ["failed", "expired", "abandoned", "refunded", "succeeded"].includes(status.state) &&
      <button type="button" disabled={disabled} onClick={() => actions.current?.setup()}>Review current cart</button>}
    {returning && status?.state === "none" && <Link href="/checkout">Review current checkout</Link>}
    <p><Link href="/cart">Back to cart and delivery selection</Link></p>
  </section>;
}
export function CheckoutView({ returning = false }: { returning?: boolean }) {
  return <main className="storefront"><SessionBoundary client={authClient} title="Your checkout">
    {(_identity, customer) => <CheckoutContent key={customer?.id} returning={returning} />}
  </SessionBoundary></main>;
}