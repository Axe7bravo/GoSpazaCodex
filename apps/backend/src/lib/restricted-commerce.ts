import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IProductModuleService, IUserModuleService, IFileModuleService, ICustomerModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type MarketplaceService from "../modules/marketplace/service";
import { withMerchantAuthorization } from "../modules/marketplace/merchant-authorization";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { validateDocument } from "../modules/marketplace/validation";
import { classifyKey } from "../modules/routed-file/storage";
import { nativeProducts } from "./catalogue-native";
import type { NativeProduct } from "./catalogue-native";
import { commerceLock } from "./commerce";
import { cartOperation } from "./cart-lock";
import { categoryPermits, classificationDecision, classificationProposal, registrationDecision, registrationSubmission,
  restrictedBlocked, restrictedId, restrictedParse, restrictedSnapshot, supplyPermitted, tradingPolicy,
  unavailablePurchaserProvider, validatePurchaser } from "../modules/marketplace/restricted-policy";
import type { PurchaserEligibilityProvider, RestrictedSnapshot, TradingPolicy } from "../modules/marketplace/restricted-policy";

type Submission = z.infer<typeof registrationSubmission>;
interface Registration {
  id: string; merchant_id: string; merchant_store_id: string; status: string; revision: number; submission: Submission; pending_submission: Submission | null;
  trading_policy: TradingPolicy | null; premises_fingerprint: string | null; reviewed_by: string | null;
  submitted_at: Date; reviewed_at: Date | null; approved_at: Date | null; suspended_at: Date | null; revoked_at: Date | null;
}
interface Profile { id: string; merchant_id: string; medusa_product_id: string; requires_age_verification: boolean }
interface Review { id: string; revision: number; product_profile_id: string; identity_fingerprint: string; restriction: "NONE" | "ALCOHOL";
  alcohol_class: "WINE" | "BEER" | "SPIRITS" | "OTHER" | null }
interface Store { id: string; merchant_id: string; address_line_1: string; address_line_2: string; city: string;
  province: string; postal_code: string; country_code: string }
interface Evidence { id: string; merchant_id: string; merchant_store_id: string; storage_key: string;
  display_name: string; mime_type: string; size_bytes: number }
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Compliance resource unavailable.");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const productRestrictionIdentity = (product: NativeProduct, proposed: boolean) => hash({
  id: product.id, title: product.title, description: product.description, proposed,
  images: product.images.map(i => i.url).sort(),
  variants: product.variants.map(v => ({ id: v.id, title: v.title, sku: v.sku })).sort((a,b) => a.id.localeCompare(b.id)),
});
const premises = (s: Store) => hash([s.id,s.merchant_id,s.address_line_1,s.address_line_2,s.city,s.province,s.postal_code,s.country_code]);

export class RestrictedCommerce {
  readonly db: Knex;
  constructor(private container: MedusaContainer, private purchaser: PurchaserEligibilityProvider = unavailablePurchaserProvider) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    if (purchaser !== unavailablePurchaserProvider && !["test","development"].includes(process.env.APP_ENV ?? "")) {
      throw new Error("No approved production purchaser verification provider is installed.");
    }
  }
  private async platform(userId: string) {
    // Narrow server-owned grant, no customer/merchant claim or native metadata.
    const allowed = (process.env.RESTRICTED_COMMERCE_REVIEWER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (!userId || !allowed.includes(userId)) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Compliance review capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(userId);
  }
  private async merchant<T>(identity: string, work: (trx: Knex.Transaction, store: Store, actor: string) => Promise<T>) {
    const marketplace = this.container.resolve<MarketplaceService>("marketplace");
    const initial = await marketplace.resolveTenant(identity);
    return commerceLock(this.container, initial.merchant.id, () => withMerchantAuthorization(this.db, marketplace, identity,
      "MERCHANT_CATALOG_MANAGE", async (trx, tenant) => {
        const store = await trx<Store>("merchant_store").where({ merchant_id: tenant.merchant.id }).whereNull("deleted_at").first();
        if (!store || store.merchant_id !== initial.merchant.id) throw missing();
        return work(trx, store, tenant.membership.id);
      }));
  }
  private async admin<T>(userId: string, storeId: string, work: (trx: Knex.Transaction, store: Store) => Promise<T>) {
    restrictedParse(restrictedId, storeId);
    await this.platform(userId);
    const initial = await this.db<Store>("merchant_store").where({ id: storeId }).whereNull("deleted_at").first();
    if (!initial) throw missing();
    return commerceLock(this.container, initial.merchant_id, () => this.db.transaction(async trx => {
      await trx("merchant").where({ id: initial.merchant_id }).forUpdate().first();
      await this.platform(userId);
      const store = await trx<Store>("merchant_store").where({ id: storeId, merchant_id: initial.merchant_id }).whereNull("deleted_at").first();
      if (!store) throw missing();
      return work(trx, store);
    }));
  }
  async event(trx: Knex.Transaction, store: Pick<Store,"id"|"merchant_id">, actor: string, target: string, action: string, evidence: object) {
    await trx("restricted_event").insert({ id: "revt_" + randomUUID(), merchant_id: store.merchant_id,
      merchant_store_id: store.id, target_id: target, actor_id: actor, action, evidence: JSON.stringify(evidence) });
  }
  async blocked(customer: string, code: string) {
    if (!/^(?:CLASSIFICATION_|RESTRICTED_|PURCHASER_VERIFICATION_)[A-Z_]+$/.test(code)) return;
    await this.db("restricted_event").insert({ id: "revt_"+randomUUID(),target_id: customer,actor_id: customer,
      action: "CHECKOUT_BLOCKED",evidence: JSON.stringify({ reason: code }) });
  }
  // Internal provider ingestion only: no customer or platform HTTP setter.
  // Production's unavailable adapter cannot create VERIFIED evidence.
  async refreshPurchaser(customer: string) {
    await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(customer);
    return cartOperation(this.container,customer,() => this.db.transaction(async trx => {
      const now = await databaseTime(trx), outcome = await this.purchaser.evaluate(customer,now);
      if (outcome.state !== "VERIFIED") return { state: outcome.state };
      const evidence = validatePurchaser(outcome,customer,now);
      await trx("purchaser_eligibility").insert(evidence).onConflict("id").ignore();
      const stored = await trx("purchaser_eligibility").where({ id: evidence.id,customer_id: customer }).forUpdate().first();
      if (!stored || stored.state !== "VERIFIED" || stored.method !== evidence.method || stored.method_version !== evidence.method_version
        || stored.policy_version !== evidence.policy_version || new Date(stored.verified_at).toISOString() !== evidence.verified_at
        || (stored.expires_at ? new Date(stored.expires_at).toISOString() : null) !== evidence.expires_at) restrictedBlocked("PURCHASER_VERIFICATION_NOT_VERIFIED");
      await trx("restricted_event").insert({ id: "revt_"+randomUUID(),target_id: evidence.id,actor_id: customer,
        action: "PURCHASER_EVIDENCE_OBSERVED",evidence: JSON.stringify({ method: evidence.method,method_version: evidence.method_version,policy_version: evidence.policy_version }) });
      return { state: "VERIFIED" as const };
    }));
  }
  async revokePurchaserEvidence(customer: string, evidenceId: string) {
    // Trusted provider/operator integration point, deliberately not routed.
    return cartOperation(this.container,customer,() => this.db.transaction(async trx => {
      const row = await trx("purchaser_eligibility").where({ id: evidenceId,customer_id: customer }).forUpdate().first();
      if (!row) throw missing();
      if (["REVOKED","EXPIRED"].includes(row.state)) return;
      await trx("purchaser_eligibility").where({ id: evidenceId }).update({ state: "REVOKED",updated_at: await databaseTime(trx) });
      await trx("restricted_event").insert({ id: "revt_"+randomUUID(),target_id: evidenceId,actor_id: "purchaser-policy",
        action: "PURCHASER_EVIDENCE_REVOKED",evidence: JSON.stringify({ customer_id: customer }) });
    }));
  }
  async registration(identity: string) {
    return this.merchant(identity, async (trx, store) => this.registrationFor(trx, store));
  }
  private async registrationFor(trx: Knex.Transaction, store: Store) {
    const registration = await trx<Registration>("restricted_registration").where({ merchant_store_id: store.id }).first();
    const evidence = await trx<Evidence>("restricted_evidence").where({ merchant_store_id: store.id })
      .select("id","display_name","mime_type","size_bytes").orderBy("created_at","desc").limit(20);
    const review = registration ? await trx<{evidence:{reason?:string}}>("restricted_event")
      .where({target_id:registration.id,merchant_store_id:store.id}).where("action","like","REGISTRATION_%")
      .whereRaw("evidence->>'reason' is not null").orderBy("created_at","desc").first() : undefined;
    return { registration: registration ? { id: registration.id, status: registration.status, revision: registration.revision,
      submission: registration.submission, pending_submission: registration.pending_submission,
      submitted_at: registration.submitted_at, reviewed_at: registration.reviewed_at } : null, evidence,
      review_note: review?.evidence.reason ?? null,
      premises: {address_line_1:store.address_line_1,address_line_2:store.address_line_2,city:store.city,
        province:store.province,postal_code:store.postal_code,country_code:store.country_code} };
  }
  async adminRegistration(user: string, storeId: string) {
    return this.admin(user, storeId, (trx, store) => this.registrationFor(trx, store));
  }
  async reviewQueue(user: string, offset: number) {
    await this.platform(user);
    // Ordinary products also need classification review; absence of a liquor
    // registration must not hide a store from its authorized platform reviewer.
    const rows = await this.db("merchant_store as store")
      .leftJoin("restricted_registration as registration", "store.id", "registration.merchant_store_id")
      .whereNull("store.deleted_at").orderByRaw("registration.submitted_at desc nulls last").orderBy("store.id")
      .select("store.id as store_id", "store.name", "registration.status").limit(21).offset(offset);
    return { items: rows.slice(0, 20).map(row=>({...row,status:row.status??"NOT_SUBMITTED"})), more: rows.length > 20 };
  }
  async submit(identity: string, value: unknown) {
    const input = restrictedParse(registrationSubmission, value);
    return this.merchant(identity, async (trx, store, actor) => {
      const evidence = await trx<Evidence>("restricted_evidence").where({ merchant_store_id: store.id, merchant_id: store.merchant_id })
        .whereIn("id", input.evidence_ids);
      if (new Set(input.evidence_ids).size !== input.evidence_ids.length || evidence.length !== input.evidence_ids.length) throw missing();
      const current = await trx<Registration>("restricted_registration").where({ merchant_store_id: store.id }).forUpdate().first();
      if (current?.status === "REVOKED") restrictedBlocked("REGISTRATION_REVIEW_TRANSITION");
      const now = await databaseTime(trx), id = current?.id ?? "rreg_" + randomUUID();
      const retained = current && ["ACTIVE","SUSPENDED"].includes(current.status);
      const fields = retained ? { pending_submission: JSON.stringify(input), submitted_at: now, updated_at: now }
        : { submission: JSON.stringify(input), status: "PENDING_REVIEW", submitted_at: now, updated_at: now };
      if (current) await trx("restricted_registration").where({ id }).update({ ...fields, revision: current.revision + 1 });
      else await trx("restricted_registration").insert({ id, merchant_id: store.merchant_id, merchant_store_id: store.id, ...fields });
      await this.event(trx, store, actor, id, "REGISTRATION_SUBMITTED", { revision: (current?.revision ?? 0) + 1, evidence_ids: input.evidence_ids });
      return this.registrationFor(trx, store);
    });
  }
  async reviewRegistration(user: string, storeId: string, value: unknown) {
    const input = restrictedParse(registrationDecision, value);
    return this.admin(user, storeId, async (trx, store) => {
      const row = await trx<Registration>("restricted_registration").where({ merchant_store_id: store.id }).forUpdate().first();
      if (!row) throw missing();
      if (row.revision !== input.expected_revision) restrictedBlocked("REGISTRATION_REVIEW_STALE");
      const transitions: Record<string, readonly string[]> = { approve: ["PENDING_REVIEW","ACTIVE","SUSPENDED"], "request-changes": ["PENDING_REVIEW","ACTIVE","SUSPENDED"],
        suspend: ["ACTIVE"], reactivate: ["SUSPENDED"], revoke: ["ACTIVE","SUSPENDED"] };
      if (!transitions[input.action]?.includes(row.status)) restrictedBlocked("REGISTRATION_REVIEW_TRANSITION");
      const replacement = ["ACTIVE","SUSPENDED"].includes(row.status) && ["approve","request-changes"].includes(input.action);
      if (replacement && !row.pending_submission) restrictedBlocked("REGISTRATION_REVIEW_TRANSITION");
      const status = replacement && input.action === "request-changes" ? row.status
        : { approve: "ACTIVE", "request-changes": "CHANGES_REQUIRED", suspend: "SUSPENDED", reactivate: "ACTIVE", revoke: "REVOKED" }[input.action];
      const now = await databaseTime(trx);
      if (input.action === "approve" || input.action === "reactivate") {
        const submission = restrictedParse(registrationSubmission, replacement && input.action === "approve" ? row.pending_submission : row.submission);
        if ((submission.valid_from && Date.parse(submission.valid_from) > now.getTime())
          || (submission.valid_until && Date.parse(submission.valid_until) <= now.getTime())) restrictedBlocked("REGISTRATION_VALIDITY");
        if (input.action === "reactivate" && row.premises_fingerprint !== premises(store)) restrictedBlocked("REGISTRATION_PREMISES_CHANGED");
      }
      await trx("restricted_registration").where({ id: row.id }).update({ status, revision: row.revision+1,
        reviewed_by: user, reviewed_at: now, updated_at: now,
        ...(replacement ? { pending_submission: null, ...(input.action === "approve" ? { submission: JSON.stringify(row.pending_submission) } : {}) } : {}),
        ...(input.action === "approve" ? { approved_at: now, premises_fingerprint: premises(store), trading_policy: JSON.stringify(input.trading_policy) } : {}),
        ...(input.action === "suspend" ? { suspended_at: now } : {}), ...(input.action === "revoke" ? { revoked_at: now } : {}) });
      await this.event(trx, store, user, row.id, "REGISTRATION_" + input.action.toUpperCase(), { from: row.status, to: status,
        revision: row.revision+1, reason: input.reason, ...(input.action === "approve" ? { trading_policy: input.trading_policy } : {}) });
      return this.registrationFor(trx, store);
    });
  }
  async upload(identity: string, value: unknown) {
    const file = validateDocument(value);
    if (file.document_type !== "LIQUOR_DOCUMENT") throw new MedusaError(MedusaError.Types.INVALID_DATA,"Liquor registration evidence required.");
    const files = this.container.resolve<IFileModuleService>(Modules.FILE);
    let key: string | undefined;
    try {
      return await this.merchant(identity, async (trx, store, actor) => {
        const count = await trx("restricted_evidence").where({ merchant_store_id: store.id }).count<{ count: string }>("id as count").first();
        if (Number(count?.count) >= 20) restrictedBlocked("REGISTRATION_EVIDENCE_LIMIT");
        const stored = await files.createFiles({ filename: randomUUID(), mimeType: file.mime_type, content: file.content, access: "private" });
        key = stored.id;
        if (classifyKey(key) !== "private") throw new Error("Private compliance evidence required.");
        const id = "revd_" + randomUUID();
        await trx("restricted_evidence").insert({ id, merchant_id: store.merchant_id, merchant_store_id: store.id,
          storage_key: key, display_name: file.display_name, mime_type: file.mime_type, size_bytes: file.bytes.length });
        await this.event(trx, store, actor, id, "EVIDENCE_SUBMITTED", {});
        return { id };
      });
    } catch (error) {
      if (key) await files.deleteFiles(key);
      throw error;
    }
  }
  async evidence(actor: string, id: string, storeId?: string) {
    restrictedParse(restrictedId, id);
    const read = async (trx: Knex.Transaction, store: Store, identity: string) => {
      const row = await trx<Evidence>("restricted_evidence").where({ id, merchant_store_id: store.id, merchant_id: store.merchant_id }).first();
      if (!row || classifyKey(row.storage_key) !== "private") throw missing();
      const bytes = await this.container.resolve<IFileModuleService>(Modules.FILE).getAsBuffer(row.storage_key);
      await this.event(trx, store, identity, row.id, "EVIDENCE_READ", {});
      return { bytes, mime_type: row.mime_type };
    };
    return storeId ? this.admin(actor, storeId, (trx, store) => read(trx,store,actor)) : this.merchant(actor,read);
  }
  private async product(trx: Knex.Transaction, store: Store, id: string) {
    restrictedParse(restrictedId,id);
    const profile = await trx<Profile>("product_marketplace_profile").where({ medusa_product_id: id, merchant_id: store.merchant_id }).whereNull("deleted_at").first();
    const [product] = profile ? await nativeProducts(this.container,[id]) : [];
    if (!profile || !product) throw missing();
    const fingerprint = productRestrictionIdentity(product,profile.requires_age_verification);
    const review = await trx<Review>("restriction_review").where({ product_profile_id: profile.id }).orderBy("revision","desc").first();
    return { profile, product, fingerprint, review };
  }
  async classification(actor: string, productId: string, storeId?: string) {
    const read = async (trx: Knex.Transaction, store: Store) => {
      const p = await this.product(trx,store,productId);
      const proposal=await trx<{evidence:{restriction:"ALCOHOL"|"NONE"}}>("restricted_event")
        .where({target_id:p.profile.id,merchant_store_id:store.id,action:"CLASSIFICATION_PROPOSED"})
        .orderBy("created_at","desc").orderBy("id","desc").first();
      return { product_id: productId, identity_fingerprint: p.fingerprint, proposed: proposal?.evidence.restriction ?? (p.profile.requires_age_verification ? "ALCOHOL" : "NONE"),
        product: {title:p.product.title,description:p.product.description,variants:p.product.variants.map(variant=>({title:variant.title,sku:variant.sku}))},
        review: p.review ? { id: p.review.id, restriction: p.review.restriction, alcohol_class: p.review.alcohol_class,
          current: p.review.identity_fingerprint === p.fingerprint } : null };
    };
    return storeId ? this.admin(actor,storeId,read) : this.merchant(actor,read);
  }
  async propose(identity: string, productId: string, value: unknown) {
    const input = restrictedParse(classificationProposal,value);
    return this.merchant(identity,async (trx,store,actor) => {
      const p = await this.product(trx,store,productId);
      // A NONE proposal is an audit request, not a downgrade of the existing safety flag.
      if (input.restriction === "ALCOHOL") await trx("product_marketplace_profile").where({ id: p.profile.id }).update({ requires_age_verification: true, updated_at: await databaseTime(trx) });
      await this.event(trx,store,actor,p.profile.id,"CLASSIFICATION_PROPOSED",input);
      return { proposed: input.restriction, review_required: true };
    });
  }
  async reviewClassification(user: string, storeId: string, productId: string, value: unknown) {
    const input = restrictedParse(classificationDecision,value);
    return this.admin(user,storeId,async (trx,store) => {
      const p = await this.product(trx,store,productId);
      if (p.fingerprint !== input.expected_identity) restrictedBlocked("CLASSIFICATION_REVIEW_STALE");
      const id = "rrev_"+randomUUID();
      await trx("restriction_review").insert({ id, product_profile_id: p.profile.id, identity_fingerprint: p.fingerprint,
        revision: (p.review?.revision ?? 0)+1,
        restriction: input.restriction, alcohol_class: input.alcohol_class, reviewer_id: user, reason: input.reason,
        created_at: await databaseTime(trx) });
      await this.event(trx,store,user,p.profile.id,"CLASSIFICATION_REVIEWED",{ review_id: id, from: p.review?.restriction ?? "UNKNOWN", to: input.restriction, reason: input.reason });
      return { id, restriction: input.restriction, alcohol_class: input.alcohol_class };
    });
  }
  // Called under the outer merchant commerce lock. No native commerce tables are written.
  async evaluate(trx: Knex.Transaction, customer: string, storeId: string, variants: string[]): Promise<RestrictedSnapshot> {
    const store = await trx<Store>("merchant_store").where({ id: storeId }).whereNull("deleted_at").first();
    if (!store) throw missing();
    const ids = [...new Set(variants)].sort();
    const native = await this.container.resolve<IProductModuleService>(Modules.PRODUCT).listProductVariants({ id: ids }, { select: ["id","product_id"], take: null });
    const classifications: RestrictedSnapshot["classifications"] = [];
    for (const id of ids) {
      const productId = native.find(v => v.id === id)?.product_id;
      if (!productId) restrictedBlocked("CLASSIFICATION_UNAVAILABLE");
      const p = await this.product(trx,store,productId);
      if (!p.review || p.review.identity_fingerprint !== p.fingerprint) restrictedBlocked("CLASSIFICATION_REVIEW_REQUIRED");
      classifications.push({ product_id: productId, variant_id: id, revision_id: p.review.id,
        restriction: p.review.restriction, alcohol_class: p.review.alcohol_class });
    }
    const restricted = classifications.some(c => c.restriction === "ALCOHOL");
    if (!restricted) return restrictedSnapshot.parse({ version: 1, restricted_content_present: false, classifications,
      registration_id: null, registration_revision: null, trading_policy_version: null, purchaser_evidence_id: null });
    const { registration, policy, now } = await this.supplyAuthority(trx, store.id, classifications, "sale");
    const evidence = validatePurchaser(await this.purchaser.evaluate(customer,now),customer,now);
    const persisted = await trx("purchaser_eligibility").where({ id: evidence.id, customer_id: customer, state: "VERIFIED",
      method: evidence.method, method_version: evidence.method_version, policy_version: evidence.policy_version,
      minimum_age: 18, provincial_requirements_satisfied: true }).where("verified_at","<=",now)
      .where(q => q.whereNull("expires_at").orWhere("expires_at",">",now)).forShare().first();
    if (!persisted) restrictedBlocked("PURCHASER_VERIFICATION_NOT_VERIFIED");
    return restrictedSnapshot.parse({ version: 1, restricted_content_present: true, classifications,
      registration_id: registration.id, registration_revision: registration.revision,
      trading_policy_version: policy.version, purchaser_evidence_id: evidence.id });
  }
  async customerStatus(customer: string) {
    const now = await this.db.transaction(databaseTime);
    const outcome = await this.purchaser.evaluate(customer,now);
    return { state: outcome.state === "VERIFIED" ? validatePurchaser(outcome,customer,now).state : outcome.state };
  }
  // Called under the existing merchant-first transaction. One owner for seller,
  // premises, category and stage-specific trading authority across B/C.
  async supplyAuthority(trx: Knex.Transaction, storeId: string, classifications: RestrictedSnapshot["classifications"], stage: "sale" | "dispatch" | "handoff") {
    const store = await trx<Store>("merchant_store").where({ id: storeId }).whereNull("deleted_at").first();
    if (!store) throw missing();
    const registration = await trx<Registration>("restricted_registration").where({ merchant_store_id: store.id, merchant_id: store.merchant_id }).first();
    const now = await databaseTime(trx);
    if (!registration || registration.status !== "ACTIVE" || registration.premises_fingerprint !== premises(store)) restrictedBlocked("RESTRICTED_STORE_UNAVAILABLE");
    const submission = restrictedParse(registrationSubmission,registration.submission);
    if ((submission.valid_from && Date.parse(submission.valid_from)>now.getTime()) || (submission.valid_until && Date.parse(submission.valid_until)<=now.getTime())) restrictedBlocked("RESTRICTED_STORE_UNAVAILABLE");
    if (classifications.some(c => c.restriction === "ALCOHOL" && (!c.alcohol_class || !categoryPermits(submission.category,c.alcohol_class)))) restrictedBlocked("RESTRICTED_CATEGORY_UNAVAILABLE");
    const policy = restrictedParse(tradingPolicy,registration.trading_policy);
    if (classifications.some(c => c.alcohol_class && !policy.permitted_alcohol_classes.includes(c.alcohol_class))) restrictedBlocked("RESTRICTED_CATEGORY_UNAVAILABLE");
    if (!supplyPermitted(policy,now,stage)) restrictedBlocked("RESTRICTED_TRADING_CLOSED");
    return { store, registration, submission, policy, now };
  }
}
