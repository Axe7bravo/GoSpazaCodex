import type { DriverAvailabilityDTO, DriverCommitmentDTO, DriverPickupDTO, OrderDispatchDTO } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
import type { HandoffDTO, HandoffCodeDTO, DeliveryTrackingDTO } from "@gospaza/contracts";
export function createDispatchClient(baseUrl: string, fetcher: typeof fetch = fetch, publishableKey = "") {
  const request = driverTransport(baseUrl, fetcher, publishableKey ? { "x-publishable-api-key": publishableKey } : {});
  return {
    latestHandoff: () => request<{ handoff: HandoffDTO | null }>("/driver/deliveries/latest"),
    handoff: (id: string) => request<HandoffDTO>("/driver/deliveries/" + encodeURIComponent(id) + "/handoff"),
    arrive: (id: string, revision: number) => request<HandoffDTO>("/driver/deliveries/" + encodeURIComponent(id) + "/arrive", "POST", { expected_revision: revision }),
    verifyHandoff: (id: string, revision: number, code: string) => request<HandoffDTO>("/driver/deliveries/" + encodeURIComponent(id) + "/handoff/verify", "POST", { expected_revision: revision, code }),
    handoffCode: (order: string) => request<HandoffCodeDTO>("/store/gospaza/orders/" + encodeURIComponent(order) + "/handoff-code"),
    regenerateHandoff: (order: string, revision: number) => request<HandoffCodeDTO>("/store/gospaza/orders/" + encodeURIComponent(order) + "/handoff-code/regenerate", "POST", { expected_revision: revision }),
    tracking: (order: string) => request<DeliveryTrackingDTO>("/store/gospaza/orders/" + encodeURIComponent(order) + "/tracking"),
    beginTracking: (id: string, revision: number) => request<{ generation: string; sequence: number; revision: number }>("/driver/deliveries/" + encodeURIComponent(id) + "/tracking", "POST", { expected_revision: revision }),
    trackingLocation: (input: { generation: string; sequence: number; latitude: number; longitude: number; accuracy?: number }) => request<{ accepted: boolean }>("/driver/location", "PUT", {
      purpose: "DELIVERY", generation: input.generation, sequence: input.sequence, latitude: input.latitude, longitude: input.longitude,
      ...(input.accuracy === undefined ? {} : { accuracy: input.accuracy }),
    }),
    availability: () => request<DriverAvailabilityDTO>("/driver/availability"),
    current: () => request<{ commitment: DriverCommitmentDTO | null }>("/driver/dispatch/current"),
    pickup: () => request<{ pickup: DriverPickupDTO | null }>("/driver/deliveries/current"),
    confirmPickup: (id: string, revision: number) => request<{ pickup: DriverPickupDTO | null }>(
      "/driver/deliveries/" + encodeURIComponent(id) + "/pickup", "POST", { expected_revision: revision }),
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
