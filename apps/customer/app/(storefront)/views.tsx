"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { DiscoveryLocation, PublicCatalogue, PublicProduct, PublicStore } from "@gospaza/contracts";
import { storefront, useDiscoveryLocation } from "./shell";
import { useCart } from "./cart-context";

const money = (cents: number) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(cents / 100);
function Loading<T>({ load, children }: { load: () => Promise<T>; children: (value: T) => ReactNode }) {
  // The parent key contains every request input and refresh generation.
  // Keep this request stable while its result renders, and discard it on unmount.
  const [request] = useState(() => load);
  const [state, setState] = useState<{ data: T } | { error: string } | null>(null);
  const { refresh } = useDiscoveryLocation();
  useEffect(() => {
    let active = true;
    void request().then((data) => { if (active) setState({ data }); })
      .catch((error: unknown) => { if (active) setState({ error: error instanceof Error ? error.message : "Storefront unavailable." }); });
    return () => { active = false; };
  }, [request]);
  if (!state) return <p role="status">Checking availability…</p>;
  if ("error" in state) return <section><p role="alert" className="shop-error">{state.error}</p><button onClick={refresh}>Try again</button></section>;
  return children(state.data);
}
function NoService() {
  return <section className="shop-empty"><h2>GoSpaza is not available at this location yet.</h2><p>Change your location or check again above.</p></section>;
}
function StoreCards({ stores }: { stores: PublicStore[] }) {
  return <div className="store-grid">{stores.map((store) => <article className="store-card" key={store.id}>
    <p className="availability">Available in your area</p><h3><Link href={"/stores/" + store.id}>{store.name}</Link></h3><p>Explore this store’s catalogue.</p>
  </article>)}</div>;
}
function AddProduct({ product }: { product: PublicProduct }) {
  const available = product.variants.filter((variant) => variant.availability === "in_stock");
  const [variantId, setVariantId] = useState(available[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const { location } = useDiscoveryLocation();
  const { add, busy, loading } = useCart();
  return <form className="add-cart" onSubmit={(event) => {
    event.preventDefault();
    if (location && variantId) void add(product, variantId, quantity, location);
  }}>
    <label>Variant for {product.title}<select value={variantId}
      onChange={(event) => setVariantId(event.target.value)}>
      {!available.length && <option value="">Out of stock</option>}
      {product.variants.map((variant) => <option key={variant.id} value={variant.id}
        disabled={variant.availability !== "in_stock"}>
        {variant.title} — {money(variant.price_minor)}{variant.availability === "out_of_stock" ? " — Out of stock" : ""}
      </option>)}
    </select></label>
    <label>Quantity<input type="number" inputMode="numeric" min={1} step={1} max={99}
      value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
    <button type="submit" disabled={busy || loading || !location || !variantId || !Number.isSafeInteger(quantity) || quantity < 1}>
      {busy ? "Updating cart…" : "Add to cart"}
    </button>
    {!location && <p className="muted">Choose a delivery location to add this item.</p>}
  </form>;
}

function ProductCards({ products }: { products: PublicProduct[] }) {
  return <div className="product-grid">{products.map((product) => <article className="product-card" key={product.id}>
    {product.images[0] ? <Image unoptimized src={product.images[0].url} alt={product.title} width={480} height={360} /> : <div className="image-placeholder">GoSpaza</div>}
    <div><Link className="store-label" href={"/stores/" + product.store.id}>{product.store.name}</Link>
      <h3><Link href={"/products/" + product.id}>{product.title}</Link></h3>
      <p className="price">{product.min_price_minor === product.max_price_minor ? money(product.min_price_minor) : money(product.min_price_minor) + " – " + money(product.max_price_minor)}</p>
      <p className={product.availability === "in_stock" ? "availability" : "muted"}>{product.availability === "in_stock" ? "In stock" : "Out of stock"}</p>
      <AddProduct product={product} />
      {product.requires_age_verification && <p className="restricted">Alcohol / restricted product</p>}
    </div>
  </article>)}</div>;
}
function Pagination({ count, offset, change }: { count: number; offset: number; change: (offset: number) => void }) {
  if (count <= 20 && offset === 0) return null;
  return <nav className="pagination" aria-label="Results pages">
    <button disabled={offset === 0} onClick={() => change(Math.max(0, offset - 20))}>Previous page</button>
    <span>{offset >= count ? "No results on this page." : (offset + 1) + "–" + Math.min(offset + 20, count) + " of " + count}</span>
    <button disabled={offset + 20 >= count} onClick={() => change(offset + 20)}>Next page</button>
  </nav>;
}
function Catalogue({ result, offset, change }: { result: PublicCatalogue; offset: number; change: (offset: number) => void }) {
  return <section><p className="availability">Your local store</p><h2>{result.store.name}</h2>
    <p>Browse the latest catalogue. Stock and prices come directly from the store.</p>
    {!result.products.length && <p>No published products are available here yet.</p>}
    <ProductCards products={result.products} /><Pagination count={result.count} offset={offset} change={change} />
  </section>;
}
function ProductDetail({ product }: { product: PublicProduct }) {
  return <article className="product-detail">
    <div className="product-gallery">{product.images.length ? product.images.map((image) =>
      <Image unoptimized key={image.id} src={image.url} alt={product.title} width={800} height={600} />) : <div className="image-placeholder">GoSpaza</div>}</div>
    <div><Link href={"/stores/" + product.store.id}>{product.store.name}</Link><h2>{product.title}</h2>
      <p className="product-description">{product.description}</p>
      {product.requires_age_verification && <p className="restricted">Alcohol / restricted product. Age verification will be required before purchase.</p>}
      <h3>Available variants</h3>
      <ul className="variant-list">{product.variants.map((variant) => <li key={variant.id}>
        <strong>{variant.title}</strong><span>{money(variant.price_minor)}</span>
        <span className={variant.availability === "in_stock" ? "availability" : "muted"}>{variant.availability === "in_stock" ? "In stock" : "Out of stock"}</span>
      </li>)}</ul>
      <AddProduct product={product} />
    </div>
  </article>;
}
type View = "home" | "stores" | "store" | "product" | "search";
function SelectedView({ view, id, location }: { view: View; id?: string; location: DiscoveryLocation }) {
  const { revision } = useDiscoveryLocation();
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  // Each keyed request owns its cancellation flag. Stable loaders avoid refetches from result renders.
  const [source] = useState(() => location);
  function search(event: FormEvent) { event.preventDefault(); setOffset(0); setQuery(text.trim()); }
  if (view === "product") return <Loading key={revision} load={() => storefront.product(id!, source)}>{({ product }) => <ProductDetail product={product} />}</Loading>;
  if (view === "store") return <Loading key={offset + ":" + revision} load={() => storefront.catalogue(id!, source, offset)}>
    {(result) => <Catalogue result={result} offset={offset} change={setOffset} />}
  </Loading>;
  if (view === "search") return <section><h2>Search your neighbourhood</h2>
    <form className="shop-search" onSubmit={search}><label>Search products or stores<input maxLength={100} value={text} onChange={(event) => setText(event.target.value)} /></label><button type="submit">Search</button></form>
    <Loading key={query + ":" + offset + ":" + revision} load={() => storefront.search(query, source, offset)}>{(result) =>
      !result.eligible_store_count ? <NoService /> : <>
        {!result.count && !result.store_count && <p>No matching products or stores. Try another search.</p>}
        <StoreCards stores={result.stores} /><ProductCards products={result.products} />
        <Pagination count={Math.max(result.count, result.store_count)} offset={offset} change={setOffset} />
      </>}
    </Loading>
  </section>;
  return <Loading key={offset + ":" + revision} load={() => storefront.discover(source, offset)}>{(result) => {
    if (result.mode === "none") return <NoService />;
    if (view === "home" && result.mode === "single" && result.stores[0]) return <SingleStore store={result.stores[0]!} location={source} />;
    return <section><h2>{view === "home" ? "Stores in your neighbourhood" : "Available stores"}</h2>
      <StoreCards stores={result.stores} /><Pagination count={result.count} offset={offset} change={setOffset} />
    </section>;
  }}</Loading>;
}
function SingleStore({ store, location }: { store: PublicStore; location: DiscoveryLocation }) {
  const { revision } = useDiscoveryLocation();
  const [offset, setOffset] = useState(0);
  return <Loading key={offset + ":" + revision} load={() => storefront.catalogue(store.id, location, offset)}>
    {(result) => <Catalogue result={result} offset={offset} change={setOffset} />}
  </Loading>;
}
export function StorefrontView({ view, id }: { view: View; id?: string }) {
  const { location } = useDiscoveryLocation();
  if (!location) return <section className="shop-empty"><h2>Good food starts close to home.</h2><p>Select your location above to discover nearby stores.</p></section>;
  return <SelectedView key={JSON.stringify(location) + ":" + view + ":" + (id ?? "")} view={view} id={id} location={location} />;
}
