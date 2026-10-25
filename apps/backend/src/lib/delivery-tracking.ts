import { randomUUID } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { dispatchLocationInput, dispatchParse, dispatchPolicy, locationFresh, dispatchMissing } from "../modules/marketplace/dispatch-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { handoffError, handoffRevision } from "../modules/marketplace/handoff-policy";
import type { DeliveryTrackingDTO } from "@gospaza/contracts";
import { PickupService, type PickupScope } from "./pickup-service";
import { HandoffService } from "./handoff-service";
import { DriverService } from "../modules/marketplace/driver-service";
import { RedisDispatchLocations } from "./dispatch-location";
export const trackingInput = dispatchLocationInput.extend({ purpose: z.literal("DELIVERY") }).strict();
export class DeliveryTracking {
  private readonly pickup: PickupService;
  private readonly locations = new RedisDispatchLocations(dispatchPolicy(), "tracking");
  private readonly db: Knex;
  constructor(private readonly container: MedusaContainer) { this.pickup = new PickupService(container); this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION); }
  private async active(s: PickupScope) {
    return s.d.status === "ASSIGNED" && !!s.d.picked_up_at && s.c.status === "ASSIGNED" && s.e.eligible && s.e.affiliation_id === s.c.affiliation_id
      && !await s.trx("delivery_completion").where({ delivery_id: s.d.id }).first();
  }
  async begin(identity: string, id: string, body: unknown) {
    const input = dispatchParse(handoffRevision, body);
    return this.pickup.locked(id, identity, async s => {
      if (!await this.active(s) || !s.e.eligible || s.d.revision !== input.expected_revision) throw handoffError();
      const generation = "track_" + randomUUID(), now = await databaseTime(s.trx), revision = s.d.revision + 1;
      await this.locations.begin(s.c.id, generation);
      await s.trx("delivery_operation").where({ id }).update({ tracking_generation: generation, revision, updated_at: now });
      await s.trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: id, revision,
        action: "TRACKING_STARTED", actor_type: "driver", actor_id: s.c.driver_profile_id, occurred_at: now, evidence: "{}" });
      return { generation, sequence: 0, revision };
    });
  }
  async update(identity: string, body: unknown) {
    const input = dispatchParse(trackingInput, body), profile = await new DriverService(this.container).profileForIdentity(identity);
    const c = await this.db<{ delivery_id: string }>("dispatch_commitment").where({ driver_profile_id: profile.id, status: "ASSIGNED" }).first();
    if (!c) return dispatchMissing();
    return this.pickup.locked(c.delivery_id, identity, async s => {
      if (!await this.active(s) || !s.e.eligible || s.d.tracking_generation !== input.generation) throw handoffError();
      await this.locations.put(s.c.id, { generation: input.generation, sequence: input.sequence, latitude: input.latitude,
        longitude: input.longitude, ...(input.accuracy === undefined ? {} : { accuracy: input.accuracy }) }, await databaseTime(s.trx));
      return { accepted: true };
    });
  }
  async customer(customer: string, orderId: string): Promise<DeliveryTrackingDTO> {
    const id = await new HandoffService(this.container).ownedDelivery(customer, orderId);
    return this.pickup.locked(id, undefined, async (s): Promise<DeliveryTrackingDTO> => {
      const { state } = await new HandoffService(this.container).presentation(s);
      if ((state !== "IN_TRANSIT" && state !== "ARRIVED") || !await this.active(s) || !s.d.tracking_generation) return { state, tracking: null };
      const sample = await this.locations.get(s.c.id), now = await databaseTime(s.trx);
      if (!sample || sample.generation !== s.d.tracking_generation || !locationFresh(sample.received_at, now, dispatchPolicy())) return { state, tracking: null };
      return { state, tracking: { latitude: sample.latitude, longitude: sample.longitude, recorded_at: new Date(sample.received_at).toISOString(),
        expires_at: new Date(sample.received_at + dispatchPolicy().freshnessMs).toISOString(), stale: false } };
    }, true);
  }
}
