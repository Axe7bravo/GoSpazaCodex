import type { AttentionPage, OperationsOverview, OperationsSource, OrderDiagnostic, DeliveryDiagnostic, OperationsLookupType, OperationalLookup, OperationsTimeline, OperationsTimelineSource, OperationsHealth, DeliveryRescueCommand, DeliveryRescueResult } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
import { AuthError } from "./auth";
export function createOperationsClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const transport = driverTransport(baseUrl, fetcher), base = "/admin/gospaza/operations";
  const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    try { return await transport<T>(base + path, method, body); }
    catch (error) { if (error instanceof AuthError) throw new AuthError(error.kind, "Operational information is unavailable or access is not permitted.", error.status); throw error; }
  };
  const page = (cursor?: string) => "?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const timeline = (type: "orders" | "deliveries", id: string, source?: OperationsTimelineSource, cursor?: string) => request<OperationsTimeline>("/" + type + "/" + encodeURIComponent(id) + "/timeline" + page(cursor) + (source ? "&source=" + source : ""));
  return {
    overview: () => request<OperationsOverview>(""),
    attention: (source: OperationsSource, cursor?: string) => request<AttentionPage>("/attention/" + encodeURIComponent(source) + page(cursor)),
    order: (id: string) => request<OrderDiagnostic>("/orders/" + encodeURIComponent(id)),
    delivery: (id: string) => request<DeliveryDiagnostic>("/deliveries/" + encodeURIComponent(id)),
    lookup: (type: OperationsLookupType, id: string) => request<OperationalLookup>("/lookup?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id)),
    orderTimeline: (id: string, source?: OperationsTimelineSource, cursor?: string) => timeline("orders", id, source, cursor),
    deliveryTimeline: (id: string, source?: OperationsTimelineSource, cursor?: string) => timeline("deliveries", id, source, cursor),
    health: () => request<OperationsHealth>("/health"),
    rescue: (id: string, command: DeliveryRescueCommand) => request<DeliveryRescueResult>("/deliveries/" + encodeURIComponent(id) + "/rescue", "POST", command),
  };
}
