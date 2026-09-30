"use client";
import Image from "next/image";
import Link from "next/link";
import { useCart } from "./cart-context";
import { useDiscoveryLocation } from "./shell";

const money = (minor: number) => new Intl.NumberFormat("en-ZA", {
  style: "currency", currency: "ZAR",
}).format(minor / 100);

export function CartView() {
  const { foundation, loading, busy, error, notice, refresh, update, remove } = useCart();
  const { location } = useDiscoveryLocation();
  if (loading && !foundation) return <p role="status">Loading your cart…</p>;
  if (error && !foundation) return <section className="shop-empty">
    <h2>Your cart could not be loaded.</h2>
    <p role="alert" className="shop-error">{error}</p>
    <button type="button" onClick={() => void refresh()}>Try again</button>
  </section>;
  if (!foundation || foundation.state === "empty" || foundation.state === "superseded") {
    return <section className="shop-empty">
      <h2>Your cart is empty.</h2>
      {foundation?.state === "superseded" && <p>Your previous cart was replaced by a newer cart.</p>}
      <p>Browse a nearby store to add your first item.</p>
      <Link href="/stores">Browse stores</Link>
      {error && <p role="alert" className="shop-error">{error}</p>}
    </section>;
  }
  const cart = foundation.cart;
  if (!cart) return <section className="shop-empty">
    <h2>Your cart is unavailable.</h2>
    <p>Reload it before making another change.</p>
    <button type="button" onClick={() => void refresh()}>Reload cart</button>
  </section>;
  const stale = foundation.state === "stale" || foundation.eligibility === "unavailable";
  return <section className="cart-page">
    <header>
      <p className="store-label">Shopping from</p>
      <h2>{cart.store.name}</h2>
      <p>{cart.item_count} {cart.item_count === 1 ? "item" : "items"}</p>
    </header>
    {stale && <div className="cart-warning" role="alert">
      <strong>This cart is currently unavailable.</strong>
      <p>You can reduce quantities or remove items. Choose a valid location before increasing anything.</p>
    </div>}
    {error && <div className="cart-warning" role="alert"><p>{error}</p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>Reload cart</button>
    </div>}
    {notice && <p role="status" className="cart-notice">{notice}</p>}
    {!cart.items.length ? <div className="shop-empty"><h3>No items in this cart.</h3>
      <p>The cart remains with {cart.store.name} until you explicitly start another store cart.</p>
      <Link href={"/stores/" + cart.store.id}>Continue shopping</Link></div>
      : <ul className="cart-lines">{cart.items.map((item) => <li key={item.id}>
        {item.image_url
          ? <Image unoptimized src={item.image_url} alt="" width={160} height={120} />
          : <div className="cart-image-placeholder" aria-hidden="true">GoSpaza</div>}
        <div className="cart-line-copy">
          <h3><Link href={"/products/" + item.product_id}>{item.product_title}</Link></h3>
          <p>{item.variant_title}</p>
          <p>{money(item.unit_price_minor)} each</p>
          <p className="price">{money(item.subtotal_minor)}</p>
        </div>
        <div className="quantity-control" aria-label={"Quantity for " + item.product_title}>
          <button type="button" disabled={busy || item.quantity <= 1}
            aria-label={"Decrease " + item.product_title}
            onClick={() => void update(item.id, item.quantity - 1)}>−</button>
          <output aria-label={"Current quantity for " + item.product_title}>{item.quantity}</output>
          <button type="button" disabled={busy || !location || stale}
            aria-label={"Increase " + item.product_title}
            onClick={() => void update(item.id, item.quantity + 1, location ?? undefined)}>+</button>
          <button type="button" className="link-button" disabled={busy}
            aria-label={"Remove " + item.product_title}
            onClick={() => void remove(item.id)}>Remove</button>
        </div>
      </li>)}</ul>}
    {!location && cart.items.length > 0 && <p className="muted">Choose a delivery location to increase quantities. You can still decrease or remove items.</p>}
    <footer className="cart-summary">
      <span>Cart subtotal</span><strong>{money(cart.subtotal_minor)}</strong>
      <p>Delivery and checkout are not available yet.</p>
    </footer>
  </section>;
}
