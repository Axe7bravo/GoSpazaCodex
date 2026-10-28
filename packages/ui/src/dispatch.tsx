"use client";
import { useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { createDispatchClient } from "@gospaza/api-client";
import { useDriverResource } from "./driver-resource";
const labels = {
  PREPARING: "Preparing order",
  FINDING_DRIVER: "Finding a driver",
  ASSIGNED: "Driver assigned",
  ATTENTION_REQUIRED: "Delivery needs operational attention",
};
const unavailable = () => {};
export function restrictedReturnCopy(phase: string | undefined) {
  switch (phase) {
    case "RETURN_REQUIRED": return { title: "Unable to complete restricted delivery", body: "The entire order must be returned to the store." };
    case "RETURNING_TO_STORE": return { title: "Returning to store", body: "Your order is being returned to the store." };
    case "RETURNED_TO_STORE": return { title: "Returned to store", body: "The store has acknowledged physical receipt of your order." };
    default: return null;
  }
}
export function OrderDispatch({ id, actor, baseUrl, publishableKey = "", details }: {
  id: string; actor: "merchant" | "customer"; baseUrl: string; publishableKey?: string; details?: ReactNode;
}) {
  const load = useCallback(() => {
    const client = createDispatchClient(baseUrl, fetch, publishableKey);
    return actor === "merchant" ? client.merchant(id) : client.customer(id);
  }, [id, actor, baseUrl, publishableKey]);
  const resource = useDriverResource(load, unavailable);
  useEffect(() => {
    if (!resource.data?.status || resource.data?.delivery_phase === "DELIVERED") return;
    let remaining = 30;
    const timer = setInterval(() => {
      if (--remaining < 0) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") void resource.refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [resource.data?.status, resource.data?.delivery_phase, resource.refresh]);
  return <section aria-label="Delivery status">
    <h2>Delivery status</h2>
    {!resource.data && !resource.error && <p role="status">Loading delivery status…</p>}
    {resource.error && <p role="alert">Delivery status is unavailable. Refresh to check again.</p>}
    {resource.data && <>
      <p>{restrictedReturnCopy(resource.data.delivery_phase)?.title ?? (resource.data.delivery_phase === "DELIVERED" ? "Delivered" : resource.data.delivery_phase === "ARRIVED" ? "Driver arrived"
        : resource.data.delivery_phase === "IN_TRANSIT" ? "In transit" : labels[resource.data.status])}</p>
      {actor === "merchant" && resource.data.pickup_state && <p>{resource.data.pickup_state === "PICKUP_READY" ? "Ready for pickup"
        : resource.data.pickup_state === "PICKUP_PENDING" ? "Confirming pickup" : resource.data.pickup_state === "ATTENTION_REQUIRED"
          ? "Delivery needs operational attention" : "Pickup is not ready yet"}</p>}
      {actor === "merchant" && resource.data.phase && <p>{resource.data.phase === "MERCHANT" ? "Searching merchant drivers" : "Searching platform drivers"}</p>}
      {actor === "merchant" && resource.data.driver && <p>{resource.data.driver.name} · {resource.data.driver.phone}</p>}
      {resource.data.status === "ATTENTION_REQUIRED" && <p>The delivery requires review. This does not confirm a cancellation or refund.</p>}
      {resource.data.delivery_phase && details}
    </>}
    <button onClick={() => void resource.refresh()}>Refresh delivery status</button>
  </section>;
}
