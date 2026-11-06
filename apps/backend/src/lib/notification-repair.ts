import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { NotificationMappings } from "./notification-mappings";
import { NotificationRuntime } from "./notification-runtime";
import { repairCandidates, repairFamilies } from "../modules/marketplace/notification-repair-sources";
import type { Discovery } from "../modules/marketplace/notification-sources";
import { runtimeBatch } from "./notification-runtime-policy";

export class NotificationRepair {
  private readonly runtime: NotificationRuntime;
  constructor(container: MedusaContainer, options: { db?: Knex; mappings?: Pick<NotificationMappings, "discover">; env?: NodeJS.ProcessEnv } = {}) {
    this.runtime = new NotificationRuntime(container, options);
    this.mappings = options.mappings ?? new NotificationMappings(container, options);
  }
  private readonly mappings: Pick<NotificationMappings, "discover">;
  async discoverPage() {
    const db = this.runtime.db;
    const activation = await db("notification_activation").where({ revision: 1 }).first(); if (!activation) return 0;
    const { rows: [clock] } = await db.raw("select gospaza_notification_now() as instant");
    const start = new Date(activation.activated_at), now = new Date(clock.instant); if (now <= start) return 0;
    const end = new Date(Math.min(start.getTime() + 3600000, now.getTime()));
    await db("notification_repair_checkpoint").insert(repairFamilies.map(family => ({ family, window_start: start, window_end: end }))).onConflict("family").ignore();
    const claim = await db.transaction(async trx => {
      const row = await trx("notification_repair_checkpoint").whereIn("family", [...repairFamilies])
        .where(q => q.whereNull("lease_until").orWhereRaw("lease_until<=gospaza_notification_now()"))
        .where(q => q.whereNull("next_cycle_at").orWhereRaw("next_cycle_at<=gospaza_notification_now()"))
        .orderByRaw("coalesce(last_scanned_at,window_start),family").forUpdate().skipLocked().first();
      if (!row) return null;
      const token = randomUUID();
      await trx("notification_repair_checkpoint").where({ family: row.family }).update({ lease_token: token,
        lease_until: new Date(now.getTime() + 600000), last_scanned_at: now });
      return { ...row, token };
    });
    if (!claim) return 0;
    try {
      const rows = await repairCandidates(db, claim.family as Discovery, { start: new Date(claim.window_start), end: new Date(claim.window_end),
        at: claim.cursor_at ? new Date(claim.cursor_at) : null, key: claim.cursor_id }, runtimeBatch);
      for (const row of rows) {
        await this.mappings.discover(claim.family as Discovery, row.source_id);
        await db("notification_runtime_observation").insert({ category: "REPAIR_DISCOVERED" });
      }
      const last = rows[rows.length - 1], exhausted = rows.length < runtimeBatch;
      const caughtUp = exhausted && new Date(claim.window_end) >= now;
      const nextStart = caughtUp ? start : new Date(claim.window_end);
      await db("notification_repair_checkpoint").where({ family: claim.family, lease_token: claim.token }).update({ lease_token: null, lease_until: null,
        ...(exhausted ? { cursor_at: null, cursor_id: null, window_start: nextStart, window_end: new Date(Math.min(nextStart.getTime() + 3600000, now.getTime())),
          next_cycle_at: caughtUp ? new Date(now.getTime() + 3600000) : null } : { cursor_at: last?.at, cursor_id: last?.key }) });
      return rows.length;
    } catch (error) {
      await db("notification_runtime_observation").insert({ category: "REPAIR_FAILURE" });
      await db("notification_repair_checkpoint").where({ family: claim.family, lease_token: claim.token }).update({ lease_token: null, lease_until: null });
      throw error; // no cursor advance over an uncreated obligation
    }
  }
  async cycle() {
    try {
      await this.runtime.recoverStuck();
      await this.discoverPage();
      await this.runtime.retrieveKnown();
      await this.runtime.health("repair", null);
    } catch { await this.runtime.health("repair", "REPAIR_UNAVAILABLE"); }
  }
}
