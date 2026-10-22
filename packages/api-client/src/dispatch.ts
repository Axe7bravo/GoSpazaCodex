import type { DriverAvailabilityDTO, DriverCommitmentDTO, OrderDispatchDTO } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
export function createDispatchClient(baseUrl: string, fetcher: typeof fetch = fetch, publishableKey = "") {
  const request = driverTransport(baseUrl, fetcher, publishableKey ? { "x-publishable-api-key": publishableKey } : {});
  return {
    availability: () => request<DriverAvailabilityDTO>("/driver/availability"),
    current: () => request<{ commitment: DriverCommitmentDTO | null }>("/driver/dispatch/current"),
    intent: (online: boolean, revision: number) => request<DriverAvailabilityDTO>(
      "/driver/availability/" + (online ? "online" : "offline"), "POST", { expected_revision: revision }),
    location: (input: { generation: string; sequence: number; latitude: number; longitude: number; accuracy?: number }) =>
      request<DriverAvailabilityDTO>("/driver/location", "PUT", { generation: input.generation, sequence: input.sequence,
        latitude: input.latitude, longitude: input.longitude, ...(input.accuracy === undefined ? {} : { accuracy: input.accuracy }) }),
    decide: (id: string, action: "accept" | "decline", revision: number) =>
      request("/driver/offers/" + encodeURIComponent(id) + "/" + action, "POST", { expected_revision: revision }),
    merchant: (id: string) => request<OrderDispatchDTO>("/merchant/orders/" + encodeURIComponent(id) + "/delivery"),
    customer: (id: string) => request<OrderDispatchDTO>("/store/gospaza/orders/" + encodeURIComponent(id) + "/delivery"),
  };
}
