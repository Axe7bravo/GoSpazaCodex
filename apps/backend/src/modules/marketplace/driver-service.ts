import { createHash, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { InferTypeOf, MedusaContainer, IAuthModuleService, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { DriverAccountDTO, DriverAffiliationDTO, DriverMutationDTO, DriverProfileDTO, MerchantDriverDTO } from "@gospaza/contracts";
import type DriverProfile from "./models/driver-profile";
import type DriverAffiliation from "./models/driver-affiliation";
import type DriverEvent from "./models/driver-event";
import type MarketplaceService from "./service";
import { withMerchantAuthorization } from "./merchant-authorization";
import { databaseTime } from "./delivery-reservation-repository";
import { merchantDriverActions, driverApprovalEligibility, driverCommand, driverConflict, driverFields, driverFingerprint, driverMissing, driverPage, driverParse, driverReviewPage, lifecycleTransition, openAffiliations, persistentEligibility } from "./driver-policy";
import type { DriverAction } from "./driver-policy";

export type DriverPrincipal = { type: "driver"; identity: string } | { type: "merchant"; identity: string } | { type: "user"; id: string };
type Profile = InferTypeOf<typeof DriverProfile>;
type Affiliation = InferTypeOf<typeof DriverAffiliation>;
type Event = InferTypeOf<typeof DriverEvent>;
type Store = { id: string; merchant_id: string; name: string };
const unauthorized = () => new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required.");
const forbidden = () => new MedusaError(MedusaError.Types.FORBIDDEN, "Driver action not permitted.");
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export function driverProfileDTO(p: Profile): DriverProfileDTO {
  return { id: p.id, display_name: p.display_name, contact_phone: p.contact_phone, status: p.status, revision: p.revision,
    submitted_at: iso(p.submitted_at), reviewed_at: iso(p.reviewed_at) };
}
function affiliationDTO(a: Affiliation): DriverAffiliationDTO {
  return { id: a.id, kind: a.kind, status: a.status, revision: a.revision, merchant_store_id: a.merchant_store_id, created_at: new Date(a.created_at).toISOString() };
}
export class DriverService {
  private readonly db: Knex;
  private readonly auth: IAuthModuleService;
  private readonly market: MarketplaceService;
  constructor(private readonly container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.auth = container.resolve<IAuthModuleService>(Modules.AUTH);
    this.market = container.resolve<MarketplaceService>("marketplace");
  }
  async nativeIdentityValid(identity: string): Promise<boolean> {
    try {
      const native = await this.auth.retrieveAuthIdentity(identity, { relations: ["provider_identities"] });
      return native.id === identity && !!native.provider_identities?.some(p => p.provider === "emailpass");
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND) return false;
      throw error;
    }
  }
  async profileForIdentity(identity: string, db: Knex = this.db): Promise<Profile> {
    if (!identity || !await this.nativeIdentityValid(identity)) throw unauthorized();
    const p = await db<Profile>("driver_profile").where({ auth_identity_id: identity }).whereNull("deleted_at").first();
    if (!p) throw unauthorized();
    return p;
  }
  private async platform(id: string) {
    if (!id) throw unauthorized();
    // Encapsulated platform trust boundary; M23 may narrow this policy.
    try { await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(id); }
    catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND) throw unauthorized();
      throw error;
    }
  }
  private open(db: Knex, profile: string) {
    return db<Affiliation>("driver_affiliation").where({ driver_profile_id: profile }).whereIn("status", openAffiliations).whereNull("deleted_at").first();
  }
  private stores(db: Knex) {
    return db("merchant_store as s").join("merchant as m", "m.id", "s.merchant_id")
      .join("merchant_application as a", "a.id", "m.source_application_id")
      .where({ "s.active": true, "m.status": "ACTIVE", "a.status": "APPROVED" })
      .whereNull("s.deleted_at").whereNull("m.deleted_at").whereNull("a.deleted_at")
      .select<Store[]>("s.id", "s.merchant_id", "s.name");
  }
  private async account(db: Knex, profile: string): Promise<DriverAccountDTO> {
    const p = await db<Profile>("driver_profile").where({ id: profile }).first();
    if (!p) return driverMissing();
    const a = await this.open(db, profile);
    const nativeValid = await this.nativeIdentityValid(p.auth_identity_id);
    const target = a?.merchant_store_id ? await this.stores(db).where("s.id", a.merchant_store_id).first() : undefined;
    const eligibility = a?.kind === "MERCHANT"
      ? persistentEligibility(p, a, target ?? null, nativeValid)
      : driverApprovalEligibility(p, a ?? null, nativeValid);
    return { profile: driverProfileDTO(p), affiliation: a ? affiliationDTO(a) : null, eligibility };
  }
  private async event(trx: Knex.Transaction, p: Profile, a: Affiliation | undefined, action: string, actor: { type: "driver" | "merchant" | "user"; id: string }, fingerprint: string, previous: number, from: string | null, to: string, reason: string, now: Date, beforeAffiliation?: Affiliation) {
    const after = await trx<Profile>("driver_profile").where({ id: p.id }).first();
    if (!after) return driverMissing();
    const row = { id: "devt_" + randomUUID(), driver_profile_id: p.id, affiliation_id: a?.id ?? null,
      actor_type: actor.type, actor_id: actor.id, merchant_id: a?.merchant_id ?? null, merchant_store_id: a?.merchant_store_id ?? null,
      action, from_status: from, to_status: to, previous_revision: previous, revision: previous + 1,
      request_fingerprint: fingerprint, reason, occurred_at: now,
      evidence: JSON.stringify({ profile: { from: previous === 0 ? null : p.status, to: after.status, previous_revision: previous, revision: previous + 1 },
        affiliation: a ? { id: a.id, from: beforeAffiliation?.status ?? null, to: a.status, previous_revision: beforeAffiliation?.revision ?? 0, revision: a.revision } : null }) };
    await trx("driver_event").insert(row);
    return { action, revision: row.revision, occurred_at: now.toISOString() };
  }
  async bootstrap(identity: string): Promise<DriverAccountDTO> {
    if (!identity) throw unauthorized();
    return this.db.transaction(async trx => {
      const lock = createHash("sha256").update("gospaza:driver-bootstrap:" + identity).digest().readBigInt64BE().toString();
      await trx.raw("select pg_advisory_xact_lock(?::bigint)", [lock]);
      if (!await this.nativeIdentityValid(identity)) throw unauthorized();
      const existing = await trx<Profile>("driver_profile").where({ auth_identity_id: identity }).first();
      if (existing) return this.account(trx, existing.id);
      const [p] = await trx<Profile>("driver_profile").insert({ id: "drv_" + randomUUID(), auth_identity_id: identity }).returning("*");
      if (!p) throw new Error("Driver profile insert did not return a row.");
      await this.event(trx, p, undefined, "BOOTSTRAP", { type: "driver", id: p.id }, driverFingerprint({}), 0, null, "INCOMPLETE", "", await databaseTime(trx));
      return this.account(trx, p.id);
    });
  }
  async own(identity: string) {
    const p = await this.profileForIdentity(identity);
    return this.db.transaction(async trx => {
      await trx<Profile>("driver_profile").where({ id: p.id }).forShare().first();
      return this.account(trx, p.id);
    });
  }
  async history(identity: string, input: unknown) {
    const p = await this.profileForIdentity(identity), page = driverParse(driverPage, input);
    const query = this.db<Affiliation>("driver_affiliation").where({ driver_profile_id: p.id });
    const count = await query.clone().count<{ count: string }>("id as count").first();
    const rows = await query.orderBy("created_at", "desc").orderBy("id").limit(page.limit).offset(page.offset);
    return { items: rows.map(affiliationDTO), count: Number(count?.count ?? 0), ...page };
  }
  async targets(identity: string, input: unknown) {
    await this.profileForIdentity(identity);
    const page = driverParse(driverPage, input);
    const rows = await this.stores(this.db).orderBy("s.id").limit(page.limit).offset(page.offset);
    return { items: rows.map(s => ({ id: s.id, name: s.name })), ...page };
  }
  async reviewList(user: string, input: unknown) {
    await this.platform(user);
    const { status, ...page } = driverParse(driverReviewPage, input);
    const query = this.db<Profile>("driver_profile").whereNull("deleted_at");
    if (status) query.where({ status });
    const count = await query.clone().count<{ count: string }>("id as count").first();
    const rows = await query.orderBy("created_at").orderBy("id").limit(page.limit).offset(page.offset);
    return { items: rows.map(driverProfileDTO), count: Number(count?.count ?? 0), ...page };
  }
  async reviewDetail(user: string, id: string) {
    await this.platform(user);
    return this.db.transaction(async trx => {
      await trx<Profile>("driver_profile").where({ id }).forShare().first();
      return this.account(trx, id);
    });
  }
  private async merchantDTO(trx: Knex.Transaction, a: Affiliation): Promise<MerchantDriverDTO> {
    const p = await trx<Profile>("driver_profile").where({ id: a.driver_profile_id }).first();
    if (!p) return driverMissing();
    const target = a.merchant_store_id ? await this.stores(trx).where("s.id", a.merchant_store_id).first() : undefined;
    const eligibility = persistentEligibility(p, a, target ?? null, await this.nativeIdentityValid(p.auth_identity_id));
    return { affiliation: affiliationDTO(a), profile_revision: p.revision, display_name: p.display_name,
      contact_phone: a.status === "ACTIVE" ? p.contact_phone : null, persistently_eligible: eligibility.eligible, available_actions: merchantDriverActions(p, a) };
  }
  async merchantRead(identity: string, input: unknown, id?: string) {
    const page = driverParse(driverPage, input);
    return withMerchantAuthorization(this.db, this.market, identity, "MERCHANT_DRIVER_VIEW", async (trx, tenant) => {
      const query = trx<Affiliation>("driver_affiliation").where({ merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id }).whereIn("status", openAffiliations);
      if (id) {
        const a = await query.where({ id }).first();
        if (!a) return driverMissing();
        return { item: await this.merchantDTO(trx, a) };
      }
      const count = await query.clone().count<{ count: string }>("id as count").first();
      const rows = await query.orderBy("created_at").orderBy("id").limit(page.limit).offset(page.offset);
      const items: MerchantDriverDTO[] = [];
      for (const a of rows) items.push(await this.merchantDTO(trx, a));
      return { items, count: Number(count?.count ?? 0), ...page };
    });
  }
  async mutate(principal: DriverPrincipal, action: DriverAction, body: unknown, profileId?: string, affiliationId?: string): Promise<DriverMutationDTO> {
    const input = driverCommand(action, body);
    const driverActions: DriverAction[] = ["EDIT", "SUBMIT", "REQUEST", "WITHDRAW"];
    const merchantActions: DriverAction[] = ["ENDORSE", "DECLINE", "REVOKE"];
    if ((principal.type === "driver" && !driverActions.includes(action)) || (principal.type === "merchant" && !merchantActions.includes(action))
      || (principal.type === "user" && [...driverActions, "ENDORSE"].includes(action))) throw forbidden();
    if (principal.type === "driver") profileId = (await this.profileForIdentity(principal.identity)).id;
    if (principal.type === "user") await this.platform(principal.id);
    if (principal.type === "merchant") {
      if (!affiliationId) return driverMissing();
      return withMerchantAuthorization(this.db, this.market, principal.identity, "MERCHANT_DRIVER_AFFILIATION_MANAGE", async (trx, tenant) => {
        const a = await trx<Affiliation>("driver_affiliation").where({ id: affiliationId, merchant_id: tenant.merchant.id, merchant_store_id: tenant.store.id }).first();
        if (!a) return driverMissing();
        return this.change(trx, a.driver_profile_id, a.id, action, input, { type: "merchant", id: tenant.membership.id }, a.merchant_id);
      });
    }
    if (!profileId) return driverMissing();
    const id = profileId;
    // Discover only for lock ordering; re-read generation under the profile lock.
    const observed = await this.open(this.db, id);
    const requestedStore = action === "REQUEST" && "merchant_store_id" in input ? await this.stores(this.db).where("s.id", input.merchant_store_id).first() : undefined;
    if (action === "REQUEST" && "merchant_store_id" in input && !requestedStore) return driverMissing();
    const merchant = requestedStore?.merchant_id ?? observed?.merchant_id ?? null;
    return this.db.transaction(async trx => {
      if (merchant) await trx("merchant").where({ id: merchant }).forUpdate().first();
      const p = await trx<Profile>("driver_profile").where({ id }).forUpdate().first();
      if (!p) return driverMissing();
      if (principal.type === "driver" && p.auth_identity_id !== principal.identity) return driverMissing();
      if (!await this.nativeIdentityValid(p.auth_identity_id)) throw unauthorized();
      if (principal.type === "user") await this.platform(principal.id);
      const current = await this.open(trx, id);
      if ((current?.id ?? null) !== (observed?.id ?? null)) return driverConflict();
      return this.change(trx, id, affiliationId, action, input, { type: principal.type, id: principal.type === "driver" ? id : principal.id }, merchant);
    });
  }
  private async change(trx: Knex.Transaction, id: string, affiliationId: string | undefined, action: DriverAction,
    input: ReturnType<typeof driverCommand>, actor: { type: "driver" | "merchant" | "user"; id: string }, merchant: string | null): Promise<DriverMutationDTO> {
    const p = await trx<Profile>("driver_profile").where({ id }).whereNull("deleted_at").forUpdate().first();
    if (!p) return driverMissing();
    let a = await trx<Affiliation>("driver_affiliation").where({ driver_profile_id: id }).whereIn("status", openAffiliations).forUpdate().first();
    if (affiliationId && a?.id !== affiliationId) {
      // A terminal affiliation can only return its own already-recorded receipt.
      const closed = await trx<Affiliation>("driver_affiliation").where({ id: affiliationId, driver_profile_id: id }).first();
      if (!closed || (actor.type === "merchant" && closed.merchant_id !== merchant)) return driverMissing();
    }
    const fingerprint = driverFingerprint({ action, affiliation_id: affiliationId ?? null, input });
    const receipt = await trx<Event>("driver_event").where({ driver_profile_id: id, previous_revision: input.expected_revision, action, request_fingerprint: fingerprint }).first();
    if (receipt) return { ...await this.account(trx, id), receipt: { action: receipt.action, revision: receipt.revision, occurred_at: new Date(receipt.occurred_at).toISOString() } };
    if (a?.merchant_id && a.merchant_id !== merchant) return driverConflict();
    if (p.revision !== input.expected_revision || p.status === "DEACTIVATED" || (affiliationId && a?.id !== affiliationId)) return driverConflict();
    if (actor.type === "merchant" && !merchantDriverActions(p, a).some(value => value.toUpperCase() === action)) return driverConflict();
    const now = await databaseTime(trx);
    const beforeAffiliation = a;
    const patch: Partial<Profile> = { revision: p.revision + 1, updated_at: now };
    let from: string = p.status, to: string = p.status;
    const reason = "reason" in input ? input.reason : "";
    const activeStore = async () => {
      if (a?.kind === "MERCHANT" && !await this.stores(trx).where("s.id", a.merchant_store_id).where("s.merchant_id", a.merchant_id).first()) return driverConflict();
    };
    const changeAffiliation = async (status: Affiliation["status"]) => {
      if (!a) return driverConflict();
      from = a.status; to = status;
      const update: Partial<Affiliation> = { status, revision: a.revision + 1, updated_at: now };
      if (status === "ENDORSED") update.endorsed_by = actor.id;
      if (status === "ACTIVE") update.activated_by = actor.id;
      const [changed] = await trx<Affiliation>("driver_affiliation").where({ id: a.id }).update(update).returning("*");
      if (!changed) return driverConflict();
      a = changed;
    };
    if (action === "EDIT") {
      if (!["INCOMPLETE", "CHANGES_REQUIRED"].includes(p.status)) return driverConflict();
      if ("display_name" in input) patch.display_name = input.display_name;
      if ("contact_phone" in input) patch.contact_phone = input.contact_phone;
    } else if (action === "REQUEST") {
      if (!["INCOMPLETE", "CHANGES_REQUIRED", "ACTIVE"].includes(p.status) || a || !("kind" in input)) return driverConflict();
      // Bound authenticated request churn without an in-memory limiter.
      const recent = await trx("driver_event").where({ driver_profile_id: id, action: "REQUEST" }).where("occurred_at", ">", new Date(now.getTime() - 3600000)).count<{ count: string }>("id as count").first();
      if (Number(recent?.count ?? 0) >= 10) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Too many affiliation requests. Try later.");
      const store = input.kind === "MERCHANT" && "merchant_store_id" in input ? await this.stores(trx).where("s.id", input.merchant_store_id).first() : undefined;
      if (input.kind === "MERCHANT" && (!store || store.merchant_id !== merchant)) return driverConflict();
      [a] = await trx<Affiliation>("driver_affiliation").insert({ id: "daff_" + randomUUID(), driver_profile_id: id, kind: input.kind,
        status: "REQUESTED", merchant_id: store?.merchant_id ?? null, merchant_store_id: store?.id ?? null }).returning("*");
      from = p.status; to = "REQUESTED";
    } else if (action === "SUBMIT") {
      patch.status = lifecycleTransition(p.status, action);
      driverParse(driverFields, { display_name: p.display_name, contact_phone: p.contact_phone });
      if (!a || !["REQUESTED", "ENDORSED"].includes(a.status)) return driverConflict();
      await activeStore(); patch.submitted_at = now; to = patch.status;
    } else if (action === "ENDORSE") {
      if (a?.kind !== "MERCHANT" || a.status !== "REQUESTED" || p.status === "SUSPENDED") return driverConflict();
      await activeStore(); await changeAffiliation("ENDORSED");
    } else if (action === "DECLINE") {
      if (a?.status !== "REQUESTED") return driverConflict();
      await changeAffiliation("REJECTED");
    } else if (action === "REVOKE" || action === "WITHDRAW") {
      if (!a || (actor.type === "merchant" && !["ENDORSED", "ACTIVE"].includes(a.status))) return driverConflict();
      await changeAffiliation("REVOKED");
    } else if (action === "ACTIVATE" || action === "APPROVE") {
      if (action === "APPROVE") patch.status = lifecycleTransition(p.status, action);
      else if (p.status !== "ACTIVE") return driverConflict();
      if (!a || (a.kind === "MERCHANT" ? a.status !== "ENDORSED" : a.status !== "REQUESTED")) return driverConflict();
      if (!await this.nativeIdentityValid(p.auth_identity_id)) throw unauthorized();
      await activeStore(); await changeAffiliation("ACTIVE");
      patch.reviewed_at = now; patch.reviewed_by = actor.id;
      if (action === "APPROVE") { from = p.status; to = "ACTIVE"; }
    } else {
      patch.status = lifecycleTransition(p.status, action); to = patch.status;
      if (action === "REACTIVATE") { if (a?.status !== "ACTIVE") return driverConflict(); await activeStore(); }
      patch.reviewed_at = now; patch.reviewed_by = actor.id;
    }
    await trx<Profile>("driver_profile").where({ id }).update(patch);
    const result = await this.event(trx, p, a, action, actor, fingerprint, p.revision, from, to, reason, now, beforeAffiliation);
    return { ...await this.account(trx, id), receipt: result };
  }
  // Reusable locked revalidation. M15 must perform its commitment inside this callback,
  // not treat an earlier eligibility result as a permission lease.
  async withEligibility<T>(profileId: string, targetStoreId: string, work: (trx: Knex.Transaction, result: Awaited<ReturnType<DriverService["eligibilityInTransaction"]>>) => Promise<T>): Promise<T> {
    const observed = await this.open(this.db, profileId);
    const target = await this.stores(this.db).where("s.id", targetStoreId).first();
    const merchants = [...new Set([observed?.merchant_id, target?.merchant_id].filter((v): v is string => !!v))].sort();
    return this.db.transaction(async trx => {
      for (const id of merchants) await trx("merchant").where({ id }).forUpdate().first();
      const p = await trx<Profile>("driver_profile").where({ id: profileId }).forUpdate().first();
      if (!p) return driverMissing();
      const a = await trx<Affiliation>("driver_affiliation").where({ driver_profile_id: profileId }).whereIn("status", openAffiliations).forUpdate().first();
      if ((a?.id ?? null) !== (observed?.id ?? null)) return driverConflict();
      return work(trx, await this.eligibilityInTransaction(trx, p, a, targetStoreId));
    });
  }
  private async eligibilityInTransaction(trx: Knex.Transaction, p: Profile, a: Affiliation | undefined, targetId: string) {
    const target = await this.stores(trx).where("s.id", targetId).first();
    return { ...persistentEligibility(p, a ?? null, target ?? null, await this.nativeIdentityValid(p.auth_identity_id)),
      profile_id: p.id, profile_revision: p.revision, affiliation_id: a?.id ?? null, affiliation_revision: a?.revision ?? null, kind: a?.kind ?? null };
  }
  eligibility(profileId: string, targetStoreId: string) { return this.withEligibility(profileId, targetStoreId, async (_trx, result) => result); }
}
