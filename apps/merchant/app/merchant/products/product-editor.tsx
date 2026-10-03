"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CatalogueProduct, CatalogueWrite } from "@gospaza/contracts";
import { AuthError } from "@gospaza/api-client";
import { catalogueClient, cents, zar } from "../../catalogue-client";
import { merchantError } from "../../merchant-client";
import { useMerchant } from "../shell";

type VariantForm = { id?: string; title: string; sku: string; price: string; stock: string };
interface Form {
  title: string; description: string; status: "draft" | "published"; requires_age_verification: boolean;
  variants: VariantForm[];
}
const emptyVariant = (title = "Default"): VariantForm => ({ title, sku: "", price: "0.00", stock: "0" });
const formFor = (product: CatalogueProduct): Form => ({
  title: product.title, description: product.description, status: product.status,
  requires_age_verification: product.requires_age_verification,
  variants: product.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, price: zar(v.price_minor), stock: String(v.stocked_quantity) })),
});
export default function ProductEditor({ id }: { id?: string }) {
  const router = useRouter();
  const { tenant, refresh } = useMerchant();
  const mayManage = tenant.membership.capabilities.includes("MERCHANT_CATALOG_MANAGE");
  const [form, setForm] = useState<Form>({ title: "", description: "", status: "draft", requires_age_verification: false, variants: [emptyVariant()] });
  const [product, setProduct] = useState<CatalogueProduct | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<{ active: boolean } | null>(null);
  useEffect(() => {
    const scope = { active: true };
    lifetime.current = scope;
    if (id) catalogueClient.detail(id).then(
      ({ product }) => { if (scope.active) { setProduct(product); setForm(formFor(product)); setLoaded(true); setError(""); } },
      (error: unknown) => { if (scope.active) setError(merchantError(error)); },
    );
    return () => { scope.active = false; };
  }, [id, retry]);
  function variant(index: number, patch: Partial<VariantForm>) {
    setForm((value) => ({ ...value, variants: value.variants.map((v, i) => i === index ? { ...v, ...patch } : v) }));
  }
  async function failure(error: unknown) {
    setError(error instanceof AuthError ? error.message : error instanceof Error ? error.message : "Unable to save product.");
    if (error instanceof AuthError && [401, 403].includes(error.status ?? 0)) await refresh();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const scope = lifetime.current;
    if (!scope?.active || busy || !mayManage) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const data: CatalogueWrite = { ...form, variants: form.variants.map((v) => {
        if (!/^\d+$/.test(v.stock) || Number(v.stock) > 1000000) throw new Error("Stock must be a whole number from 0 to 1000000.");
        return { ...(v.id ? { id: v.id } : {}), title: v.title, sku: v.sku, price_minor: cents(v.price), stocked_quantity: Number(v.stock) };
      }) };
      const result = id ? await catalogueClient.update(id, data) : await catalogueClient.create(data);
      if (!scope.active) return;
      if (!id) router.replace("/merchant/products/" + result.product.id);
      else { setProduct(result.product); setForm(formFor(result.product)); setMessage("Product saved."); }
    } catch (error) { if (scope.active) await failure(error); }
    finally { if (scope.active) setBusy(false); }
  }
  async function upload(file: File | undefined) {
    const scope = lifetime.current;
    if (!scope?.active || !id || !file || busy || !mayManage) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Use JPEG, PNG or WebP images up to 5 MB."); return;
    }
    setBusy(true); setError("");
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Image could not be read."));
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      if (!scope.active) return;
      const result = await catalogueClient.upload(id, file.type, content);
      if (scope.active) { setProduct(result.product); setMessage("Image uploaded."); }
    } catch (error) { if (scope.active) await failure(error); }
    finally { if (scope.active) setBusy(false); }
  }
  async function removeImage(imageId: string) {
    const scope = lifetime.current;
    if (!scope?.active || !id || busy || !mayManage || !window.confirm("Remove this product image?")) return;
    setBusy(true); setError("");
    try {
      const result = await catalogueClient.removeImage(id, imageId);
      if (scope.active) setProduct(result.product);
    } catch (error) { if (scope.active) await failure(error); }
    finally { if (scope.active) setBusy(false); }
  }
  if (!id && !mayManage) return <><h1>Product access unavailable</h1><p>Your role is read-only.</p></>;
  return <div className="application-content">
    <h1>{id ? "Product details" : "Create product"}</h1>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!loaded && (error ? <button onClick={() => setRetry((v) => v + 1)}>Retry product</button> : <p role="status">Loading product…</p>)}
    {loaded && <form onSubmit={save} className="application-fields" aria-busy={busy}>
      <label>Product title<input required maxLength={200} value={form.title} disabled={!mayManage || busy} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label>Description<textarea maxLength={10000} value={form.description} disabled={!mayManage || busy} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label><input type="checkbox" checked={form.requires_age_verification} disabled={!mayManage || busy} onChange={(e) => setForm({ ...form, requires_age_verification: e.target.checked })} />Alcohol / restricted product</label>
      <label>Product status<select value={form.status} disabled={!mayManage || busy} onChange={(e) => setForm({ ...form, status: e.target.value === "published" ? "published" : "draft" })}>
        <option value="draft">Draft</option><option value="published">Published</option>
      </select></label>
      <section className="catalogue-variants"><h2>Variants</h2>
        <p>Each variant is a fixed purchasable unit. Stock 12 of a 500g variant means twelve packs. No weighed repricing.</p>
        {id && <p>Variant names and count are fixed after creation; SKU, price and stock remain editable.</p>}
        {form.variants.map((v, index) => <fieldset key={v.id ?? index} disabled={!mayManage || busy}>
          <legend>Variant {index + 1}</legend>
          <label>Variant name<input required value={v.title} readOnly={Boolean(id)} onChange={(e) => variant(index, { title: e.target.value })} /></label>
          <label>SKU<input maxLength={100} value={v.sku} onChange={(e) => variant(index, { sku: e.target.value })} /></label>
          <label>Price (ZAR)<input required inputMode="decimal" value={v.price} onChange={(e) => variant(index, { price: e.target.value })} /></label>
          <label>Stocked units<input required type="number" min="0" max="1000000" step="1" value={v.stock} onChange={(e) => variant(index, { stock: e.target.value })} /></label>
          {!id && form.variants.length > 1 && <button type="button" onClick={() => setForm({ ...form, variants: form.variants.filter((_, i) => i !== index) })}>Remove variant</button>}
        </fieldset>)}
        {!id && mayManage && <div>
          <button type="button" disabled={busy || form.variants.length >= 30} onClick={() => setForm({ ...form, variants: [...form.variants, emptyVariant("")] })}>Add variant</button>
          <button type="button" disabled={busy} onClick={() => setForm({ ...form, variants: ["500g", "1kg", "2kg"].map(emptyVariant) })}>Use 500g / 1kg / 2kg</button>
        </div>}
      </section>
      {mayManage && <button type="submit" disabled={busy}>{id ? "Save product" : "Create product"}</button>}
    </form>}
    {loaded && <section><h2>Images</h2>
      {!id && <p>Save the product first, then upload images.</p>}
      {id && mayManage && <label>Upload product image<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label>}
      <div className="catalogue-images">{product?.images.map((image) => <div key={image.id}>
        <Image src={image.url} alt={form.title} width={160} height={160} unoptimized />
        {mayManage && <button disabled={busy} onClick={() => void removeImage(image.id)}>Remove image</button>}
      </div>)}</div>
    </section>}
  </div>;
}
