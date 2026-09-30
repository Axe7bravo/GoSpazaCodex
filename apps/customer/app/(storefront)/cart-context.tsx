"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CartError, createCartClient } from "@gospaza/api-client";
import type { CartFoundation, DiscoveryLocation, PublicProduct } from "@gospaza/contracts";

const client = createCartClient(
  process.env.NEXT_PUBLIC_API_URL!,
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "",
);

interface PendingSwitch {
  input: { variant_id: string; quantity: number; location: DiscoveryLocation };
  product: string;
  store: string;
}
interface CartContextValue {
  foundation: CartFoundation | null;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  pendingSwitch: PendingSwitch | null;
  refresh(): Promise<void>;
  add(product: PublicProduct, variantId: string, quantity: number, location: DiscoveryLocation): Promise<void>;
  update(lineId: string, quantity: number, location?: DiscoveryLocation): Promise<void>;
  remove(lineId: string): Promise<void>;
  keepCurrent(): void;
  confirmSwitch(): Promise<void>;
}
const CartContext = createContext<CartContextValue | null>(null);

export function useCart() {
  const value = useContext(CartContext);
  if (!value) throw new Error("Cart provider is required.");
  return value;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [foundation, setFoundation] = useState<CartFoundation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const generation = useRef(0);
  const mutationInFlight = useRef(false);

  const apply = useCallback((result: CartFoundation) => {
    setFoundation(result);
    setError("");
    setLoading(false);
  }, []);
  const refresh = useCallback(async () => {
    if (mutationInFlight.current) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await client.current();
      if (generation.current === request) apply(result);
    } catch (failure) {
      if (generation.current === request) {
        setLoading(false);
        setError(failure instanceof Error ? failure.message : "Cart unavailable.");
      }
    }
  }, [apply]);
  useEffect(() => {
    let active = true;
    const request = ++generation.current;
    void client.current().then((result) => {
      if (active && generation.current === request) apply(result);
    }).catch((failure: unknown) => {
      if (active && generation.current === request) {
        setLoading(false);
        setError(failure instanceof Error ? failure.message : "Cart unavailable.");
      }
    });
    const focus = () => {
      // The mutation already restores the authoritative cart before completing.
      // A foreground read must not invalidate that result or strand busy state.
      if (document.visibilityState !== "visible" || mutationInFlight.current) return;
      const focusRequest = ++generation.current;
      setLoading(true);
      setError("");
      void client.current().then((result) => {
        if (active && generation.current === focusRequest) apply(result);
      }).catch((failure: unknown) => {
        if (active && generation.current === focusRequest) {
          setLoading(false);
          setError(failure instanceof Error ? failure.message : "Cart unavailable.");
        }
      });
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      active = false;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [apply]);

  async function mutate(work: () => Promise<CartFoundation>, success: string): Promise<boolean> {
    if (mutationInFlight.current) return false;
    mutationInFlight.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (generation.current === request) {
        apply(result);
        setNotice(success);
        return true;
      }
    } catch (failure) {
      if (generation.current !== request) return false;
      if (failure instanceof CartError && failure.kind === "uncertain") {
        setError("We could not confirm that change. Reload your cart before trying again.");
      } else {
        setError(failure instanceof Error ? failure.message : "Cart unavailable.");
      }
    } finally {
      mutationInFlight.current = false;
      if (generation.current === request) setBusy(false);
    }
    return false;
  }
  async function add(product: PublicProduct, variantId: string, quantity: number, location: DiscoveryLocation) {
    const input = {
      ...(foundation?.cart ? { cart_id: foundation.cart.id } : {}),
      variant_id: variantId,
      quantity,
      location,
    };
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.add(input);
      if (generation.current === request) {
        apply(result);
        setNotice(product.title + " added to your cart.");
      }
    } catch (failure) {
      if (generation.current !== request) return;
      if (failure instanceof CartError && failure.code === "CART_MERCHANT_CONFLICT") {
        setPendingSwitch({ input: { variant_id: variantId, quantity, location },
          product: product.title, store: product.store.name });
      } else if (failure instanceof CartError && failure.kind === "uncertain") {
        setError("We could not confirm that change. Reload your cart before trying again.");
      } else {
        setError(failure instanceof Error ? failure.message : "Cart unavailable.");
      }
    } finally {
      mutationInFlight.current = false;
      if (generation.current === request) setBusy(false);
    }
  }
  async function update(lineId: string, quantity: number, location?: DiscoveryLocation) {
    const cart = foundation?.cart;
    if (!cart) return;
    await mutate(() => client.update(lineId, {
      cart_id: cart.id,
      quantity,
      ...(location ? { location } : {}),
    }), "Cart quantity updated.");
  }
  async function remove(lineId: string) {
    const cart = foundation?.cart;
    if (!cart) return;
    await mutate(() => client.remove(lineId, cart.id), "Item removed from your cart.");
  }
  function keepCurrent() {
    setPendingSwitch(null);
    setNotice("Your current cart was kept.");
  }
  async function confirmSwitch() {
    const cart = foundation?.cart;
    const pending = pendingSwitch;
    if (!cart || !pending) {
      setError("Reload your cart before switching stores.");
      return;
    }
    const switched = await mutate(() => client.switchStore({
      cart_id: cart.id,
      ...pending.input,
      confirm: true,
    }), "Started a new cart for " + pending.store + ".");
    if (switched) setPendingSwitch(null);
  }

  return <CartContext.Provider value={{
    foundation, loading, busy, error, notice, pendingSwitch,
    refresh, add, update, remove, keepCurrent, confirmSwitch,
  }}>
    {children}
    {pendingSwitch && <section className="cart-conflict" role="dialog" aria-modal="true" aria-labelledby="cart-conflict-title">
      <h2 id="cart-conflict-title">Start a new store cart?</h2>
      <p>Your current cart belongs to {foundation?.cart?.store.name ?? "another store"}.
        Starting a cart for {pendingSwitch.store} will replace which cart is current without mixing items.</p>
      <p><strong>{pendingSwitch.product}</strong> will be the first item in the new cart.</p>
      <div className="cart-actions">
        <button type="button" className="secondary" disabled={busy} onClick={keepCurrent}>Keep current cart</button>
        <button type="button" disabled={busy} onClick={() => void confirmSwitch()}>
          {busy ? "Switching…" : "Start new cart for this store"}
        </button>
      </div>
    </section>}
  </CartContext.Provider>;
}
