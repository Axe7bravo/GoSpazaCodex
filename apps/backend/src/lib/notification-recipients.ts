import type { IAuthModuleService, ICustomerModuleService, IOrderModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { MedusaError, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type MarketplaceService from "../modules/marketplace/service";
import { DriverService } from "../modules/marketplace/driver-service";
import { capabilitiesFor } from "../modules/marketplace/team-policy";
import { hasFinancialCapability } from "../modules/marketplace/financial-policy";
import { settlementAllowed } from "../modules/marketplace/merchant-settlement-policy";
import { driverPaymentAllowed } from "../modules/marketplace/driver-payment-policy";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import type { NotificationFact, NotificationOrderReader } from "../modules/marketplace/notification-sources";
import { nativeOrderQuantity, readOperationalOrder } from "./order-operation-native";
import { destination, id, NotificationConflict, type Actor } from "./notification-policy";

export interface MerchantRecipient { memberId: string; identity: string; merchantId: string; storeId: string; role: Parameters<typeof capabilitiesFor>[0] }
export interface NotificationActors extends NotificationOrderReader {
  merchant(memberId: string, trx?: Knex.Transaction): Promise<MerchantRecipient | null>;
  driver(profileId: string, fact: NotificationFact): Promise<boolean>;
  user(userId: string): Promise<boolean>;
}
function denied(error: unknown) {
  return MedusaError.isMedusaError(error) && (error.type === MedusaError.Types.NOT_FOUND || error.type === MedusaError.Types.UNAUTHORIZED || error.type === MedusaError.Types.FORBIDDEN);
}
export class NativeNotificationActors implements NotificationActors {
  constructor(private readonly container: MedusaContainer, private readonly db: Knex) {}
  private async identity(identity: string) {
    try {
      const row = await this.container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(identity, { relations: ["provider_identities"] });
      return row.id === identity && !!row.provider_identities?.some(provider => provider.provider === "emailpass");
    } catch (error) { if (denied(error)) return false; throw error; }
  }
  async order(handoff: CompletedOrderHandoff) {
    const order = await readOperationalOrder(this.container, handoff);
    const contact = await this.container.resolve<IOrderModuleService>(Modules.ORDER).retrieveOrder(order.id, { select: ["id", "email", "customer_id"] });
    const customer = await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(handoff.snapshot.customer_id);
    if (contact.customer_id !== customer.id || order.customer_id !== customer.id || typeof customer.has_account !== "boolean") throw new NotificationConflict();
    // Native Order contact first; registered native Customer contact is the
    // approved persisted fallback when the cart workflow did not freeze email.
    return { id: order.id, customerId: customer.id, registered: customer.has_account,
      contact: destination(contact.email ?? customer.email ?? null), reference: String(order.display_id ?? "your order"),
      lines: (order.items ?? []).map(line => ({ id: line.id, quantity: nativeOrderQuantity(line.quantity) })) };
  }
  async merchant(memberId: string, trx?: Knex.Transaction) {
    const row = await (trx ?? this.db)("merchant_member").where({ id: memberId, status: "ACTIVE" }).whereNull("deleted_at").first();
    if (!row || !trx && !await this.identity(row.auth_identity_id)) return null;
    try {
      const tenant = await this.container.resolve<MarketplaceService>("marketplace").resolveTenant(row.auth_identity_id, trx ?? this.db);
      if (tenant.membership.id !== row.id) return null;
      return { memberId: row.id as string, identity: row.auth_identity_id as string, merchantId: tenant.merchant.id, storeId: tenant.store.id, role: tenant.membership.member_type };
    } catch (error) { if (denied(error)) return null; throw error; }
  }
  async driver(profileId: string, fact: NotificationFact) {
    const row = await this.db("driver_profile").where({ id: profileId }).whereNull("deleted_at").first(); if (!row) return false;
    const drivers = new DriverService(this.container);
    try {
      if ((await drivers.profileForIdentity(row.auth_identity_id)).id !== profileId) return false;
      if (!fact.operationalDriver) return true; // suspension does not remove own finance/history
      if (!fact.storeId) return false;
      const eligibility = await drivers.eligibility(profileId, fact.storeId);
      const commitment = await this.db("dispatch_commitment").where({ id: fact.source.id, driver_profile_id: profileId, status: "OFFERED" }).first();
      return !!commitment && eligibility.eligible && eligibility.profile_revision === commitment.profile_revision
        && eligibility.affiliation_id === commitment.affiliation_id && eligibility.affiliation_revision === commitment.affiliation_revision && eligibility.kind === commitment.path;
    } catch (error) { if (denied(error)) return false; throw error; }
  }
  async user(userId: string) {
    try { const user = await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(userId); return user.id === userId; }
    catch (error) { if (denied(error)) return false; throw error; }
  }
}

export function merchantEligible(member: MerchantRecipient, fact: NotificationFact) {
  if (member.merchantId !== fact.merchantId || member.storeId !== fact.storeId) return false;
  const capabilities = capabilitiesFor(member.role);
  switch (fact.merchantPolicy) {
    case "MANAGEMENT": return member.role !== "PICKER" && capabilities.includes(fact.kind === "NEW_ORDER_REQUIRING_ACTION" ? "MERCHANT_ORDER_DECIDE" : "MERCHANT_ORDER_VIEW");
    case "FINANCE": return member.role !== "PICKER" && capabilities.includes("MERCHANT_SETTLEMENT_VIEW");
    case "RETURN": return capabilities.includes("MERCHANT_RETURN_RECEIVE");
    case "DISPOSITION": return member.role !== "PICKER" && capabilities.includes("MERCHANT_INVENTORY_MANAGE");
    case "PICKING": return capabilities.includes("MERCHANT_PICKING_VIEW") && (member.role !== "PICKER" || member.memberId === fact.assignedMember);
    default: return false;
  }
}
export function platformEligible(userId: string, fact: Pick<NotificationFact, "platform" | "platformAction">, env: NodeJS.ProcessEnv) {
  if (!fact.platform) return false;
  const configured = (env["NOTIFICATION_AUDIENCE_" + fact.platform + "_USER_IDS"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (configured.length > 250 || configured.some(value => !id.safeParse(value).success)) throw new NotificationConflict();
  if (!configured.includes(userId)) return false;
  switch (fact.platform) {
    case "CUSTOMER_FINANCE": return hasFinancialCapability(userId, "VIEW", env)
      && hasFinancialCapability(userId, fact.platformAction === "CREDIT" ? "ISSUE_STORE_CREDIT" : "EXECUTE_REFUND", env);
    case "SETTLEMENT": return settlementAllowed(userId, "VIEW", env) && (fact.platformAction === "PREPARE"
      ? settlementAllowed(userId, "APPROVE", env) : settlementAllowed(userId, "PAYOUT_RECORD", env) || settlementAllowed(userId, "RECONCILE", env));
    case "DRIVER_PAYMENT": return driverPaymentAllowed(userId, "VIEW", env) && driverPaymentAllowed(userId, "EVIDENCE", env);
    case "DRIVER_RECOGNITION": return driverPaymentAllowed(userId, "VIEW", env);
    case "MARKETPLACE_RECOGNITION": return hasFinancialCapability(userId, "VIEW", env);
    case "DELIVERY_OPERATIONS": return true; // explicit audience + native platform identity; no evidence/action grant
  }
}
export interface ResolvedRecipient { actor: Actor; destination: string | null; merchant?: MerchantRecipient }
export class NotificationRecipients {
  constructor(private readonly db: Knex, private readonly native: NotificationActors, private readonly env: NodeJS.ProcessEnv) {}
  async resolve(fact: NotificationFact): Promise<ResolvedRecipient[]> {
    if (fact.audience === "customer") return fact.order?.registered ? [{ actor: { type: "customer", id: fact.order.customerId }, destination: destination(fact.order.contact) }] : [];
    if (fact.audience === "driver") return fact.driverId && await this.native.driver(fact.driverId, fact)
      ? [{ actor: { type: "driver", id: fact.driverId }, destination: null }] : [];
    if (fact.audience === "user") {
      const candidates = (this.env["NOTIFICATION_AUDIENCE_" + fact.platform + "_USER_IDS"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
      const result: ResolvedRecipient[] = [];
      for (const userId of new Set(candidates)) if (platformEligible(userId, fact, this.env) && await this.native.user(userId)) result.push({ actor: { type: "user", id: userId }, destination: null });
      return result;
    }
    const rows = await this.db("merchant_member").where({ merchant_id: fact.merchantId, status: "ACTIVE" }).whereNull("deleted_at").orderBy("id").limit(251);
    if (rows.length > 250) throw new NotificationConflict();
    const result: ResolvedRecipient[] = [];
    for (const row of rows) {
      const member = await this.native.merchant(row.id);
      if (!member || !merchantEligible(member, fact)) continue;
      if (fact.kind === "ORDER_NO_LONGER_ACTIONABLE" && !await this.db("notification_intent").where({ kind: "NEW_ORDER_REQUIRING_ACTION", recipient_type: "merchant",
        recipient_id: member.memberId, channel: "IN_APP" }).whereRaw("deep_link = ?", [fact.link ? "/merchant/orders/" + fact.link.resource : ""]).first()) continue;
      result.push({ actor: { type: "merchant", id: member.memberId }, destination: null, merchant: member });
    }
    return result;
  }
  async current(recipient: ResolvedRecipient, fact: NotificationFact, trx: Knex.Transaction) {
    if (recipient.actor.type === "merchant") {
      if (!fact.merchantId) return false;
      await trx("merchant").where({ id: fact.merchantId }).forShare().first();
      const member = await this.native.merchant(recipient.actor.id, trx);
      return !!member && merchantEligible(member, fact);
    }
    if (recipient.actor.type === "user") return platformEligible(recipient.actor.id, fact, this.env);
    if (fact.operationalDriver) {
      const c = await trx("dispatch_commitment").where({ id: fact.source.id, driver_profile_id: recipient.actor.id }).first();
      const p = await trx("driver_profile").where({ id: recipient.actor.id, status: "ACTIVE" }).whereNull("deleted_at").forShare().first();
      const affiliation = c ? await trx("driver_affiliation").where({ id: c.affiliation_id }).whereNull("deleted_at").forShare().first() : null;
      return !!c && !!p && !!affiliation && Number(p.revision) === Number(c.profile_revision) && Number(affiliation.revision) === Number(c.affiliation_revision);
    }
    return true;
  }
}
