"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { InventoryList, InventoryRow } from "@gospaza/contracts";
import { AuthError } from "@gospaza/api-client";
import { catalogueClient } from "../../catalogue-client";
import { merchantError } from "../../merchant-client";
import { useMerchant } from "../shell";

export default function Inventory() {
  const { tenant, refresh } = useMerchant();
  const mayManage = tenant.membership.capabilities.includes("MERCHANT_INVENTORY_MANAGE");
  const [data, setData] = useState<InventoryList | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("?limit=20&offset=0");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    catalogueClient.inventory(query).then(
      (result) => { if (active) { setData(result); setError(""); } },
      (failure: unknown) => {
        if (!active) return;
        setError(merchantError(failure));
        if (failure instanceof AuthError && [401, 403].includes(failure.status ?? 0)) void refresh();
      },
    );
    return () => { active = false; };
  }, [query, revision, refresh]);
  function navigate(offset: number) {
    setData(null);
    setError("");
    setQuery("?" + new URLSearchParams({ q: search, limit: "20", offset: String(offset) }));
    setRevision((value) => value + 1);
  }
  return <div className="application-content">
    <h1>Inventory</h1>
    <p>Stock is counted in purchasable variant units. Reserved and available quantities are calculated by Medusa.</p>
    <form onSubmit={(event) => { event.preventDefault(); navigate(0); }} className="catalogue-filters">
      <label>Search product or SKU<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button type="submit">Search</button>
    </form>
    {error && <><p className="auth-error" role="alert">{error}</p><button onClick={() => navigate(data?.offset ?? 0)}>Retry inventory</button></>}
    {!data && !error && <p role="status">Loading inventory…</p>}
    {data && !data.items.length && <p>No inventory found.</p>}
    {data && data.items.length > 0 && <div className="table-scroll"><table>
      <thead><tr><th>Product</th><th>Variant</th><th>SKU</th><th>Stocked</th><th>Reserved</th><th>Available</th>{mayManage && <th>Adjust stock</th>}</tr></thead>
      <tbody>{data.items.map((item) => <StockRow key={item.id + ":" + revision} item={item} mayManage={mayManage} onSaved={() => navigate(data.offset)} />)}</tbody>
    </table></div>}
    {data && <nav aria-label="Inventory pages">
      <button disabled={!data.offset} onClick={() => navigate(Math.max(0, data.offset - 20))}>Previous</button>
      <span>{data.count} variants</span>
      <button disabled={data.offset + data.limit >= data.count} onClick={() => navigate(data.offset + data.limit)}>Next</button>
    </nav>}
  </div>;
}

function StockRow({ item, mayManage, onSaved }: { item: InventoryRow; mayManage: boolean; onSaved: () => void }) {
  const { refresh } = useMerchant();
  const [quantity, setQuantity] = useState(String(item.stocked_quantity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef<{ active: boolean } | null>(null);
  useEffect(() => {
    const scope = { active: true };
    lifetime.current = scope;
    return () => { scope.active = false; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const scope = lifetime.current;
    if (!scope?.active || busy) return;
    if (!/^\d+$/.test(quantity) || Number(quantity) > 1000000) {
      setError("Enter a whole stocked quantity from 0 to 1000000.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await catalogueClient.stock(item.inventory_item_id, Number(quantity));
      if (scope.active) onSaved();
    } catch (failure) {
      if (!scope.active) return;
      setError(merchantError(failure));
      if (failure instanceof AuthError && [401, 403].includes(failure.status ?? 0)) void refresh();
    } finally { if (scope.active) setBusy(false); }
  }
  return <tr>
    <td><Link href={"/merchant/products/" + item.product_id}>{item.product_title}</Link></td>
    <td>{item.title}</td><td>{item.sku || "—"}</td>
    <td>{item.stocked_quantity}</td><td>{item.reserved_quantity}</td><td>{item.available_quantity}</td>
    {mayManage && <td><form onSubmit={save}>
      <label>Stocked quantity for {item.title}<input inputMode="numeric" value={quantity} disabled={busy} onChange={(event) => setQuantity(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save stock"}</button>
      {error && <p role="alert" className="auth-error">{error}</p>}
    </form></td>}
  </tr>;
}
