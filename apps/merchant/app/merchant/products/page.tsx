"use client";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { CatalogueList } from "@gospaza/contracts";
import { catalogueClient, zar } from "../../catalogue-client";
import { merchantError } from "../../merchant-client";
import { useMerchant } from "../shell";

export default function Products() {
  const { tenant } = useMerchant();
  const mayManage = tenant.membership.capabilities.includes("MERCHANT_CATALOG_MANAGE");
  const [data, setData] = useState<CatalogueList | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("?limit=20&offset=0");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    catalogueClient.list(query).then(
      (result) => { if (active) { setData(result); setError(""); } },
      (error: unknown) => { if (active) setError(merchantError(error)); },
    );
    return () => { active = false; };
  }, [query, retry]);
  function navigate(offset: number) {
    setData(null); setError(""); setRetry((value) => value + 1);
    setQuery("?" + new URLSearchParams({ q: search, ...(status ? { status } : {}), limit: "20", offset: String(offset) }));
  }
  function submit(event: FormEvent) { event.preventDefault(); navigate(0); }
  return (
    <div className="application-content">
      <h1>Products</h1>
      {mayManage && <Link href="/merchant/products/new">Create product</Link>}
      <form onSubmit={submit} className="catalogue-filters">
        <label>Search products<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All</option><option value="draft">Draft</option><option value="published">Published</option>
        </select></label>
        <button type="submit">Search</button>
      </form>
      {error && <><p role="alert" className="auth-error">{error}</p><button onClick={() => setRetry((value) => value + 1)}>Retry catalogue</button></>}
      {!data && !error && <p role="status">Loading products…</p>}
      {data && !data.products.length && <p>No products found.</p>}
      {data && data.products.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Image</th><th>Product</th><th>Status</th><th>Variants</th><th>Price from</th><th>Available units</th></tr></thead>
        <tbody>{data.products.map((product) => <tr key={product.id}>
          <td>{product.images[0] && <Image src={product.images[0].url} alt={product.title} width={64} height={64} unoptimized />}</td>
          <td><Link href={"/merchant/products/" + product.id}>{product.title}</Link></td>
          <td>{product.status}</td><td>{product.variants.length}</td>
          <td>R{zar(Math.min(...product.variants.map((v) => v.price_minor)))}</td>
          <td>{product.variants.reduce((total, v) => total + v.available_quantity, 0)}</td>
        </tr>)}</tbody>
      </table></div>}
      {data && <nav aria-label="Product pages">
        <button disabled={data.offset === 0} onClick={() => navigate(Math.max(0, data.offset - 20))}>Previous</button>
        <span>{data.count} products</span>
        <button disabled={data.offset + data.limit >= data.count} onClick={() => navigate(data.offset + data.limit)}>Next</button>
      </nav>}
    </div>
  );
}
