import { randomUUID } from "node:crypto";
import { MedusaService, MedusaError } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IFileModuleService } from "@medusajs/framework/types";
import Application from "./models/application";
import Document from "./models/document";
import Merchant from "./models/merchant";
import MerchantStore from "./models/merchant-store";
import MerchantMember from "./models/merchant-member";
import ReviewEvent from "./models/review-event";
import { editableApplication, reviewTransition, reasonInput, approvalInput } from "./review-policy";
import type { ReviewAction } from "./review-policy";
import { applicationFields, validateSubmission, parse } from "./validation";
import type { ApplicationFields } from "./validation";

export interface ApplicationRow extends ApplicationFields {
  id: string; applicant_identity_id: string; status: string; submitted_at: Date | null; last_submitted_at: Date | null;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
}
export interface DocumentRow {
  id: string; application_id: string; document_type: string; display_name: string;
  storage_key: string; mime_type: string; size_bytes: number; removal_pending: boolean;
  created_at: Date; deleted_at: Date | null;
}
export interface ReviewRow {
  id: string; application_id: string; action: string; platform_user_id: string | null; reason: string;
  from_status: string; to_status: string; created_at: Date;
}
const APPS = "merchant_application";
const DOCS = "merchant_application_document";
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Application or document not found.");
const conflict = (message: string) => new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
export default class MarketplaceService extends MedusaService({ Application, Document, Merchant, MerchantStore, MerchantMember, ReviewEvent }) {
  private db: Knex;
  constructor(container: { __pg_connection__: Knex }) { super(container); this.db = container.__pg_connection__; }
  // All SQL is confined to this module's tables. Row locks serialize submit/edit/file mutations.
  async createDraft(owner: string) {
    await this.db(APPS).insert({ id: "mapp_" + randomUUID(), applicant_identity_id: owner }).onConflict("applicant_identity_id").ignore();
    return this.own(owner);
  }
  async own(owner: string): Promise<ApplicationRow | null> {
    return await this.db<ApplicationRow>(APPS).where({ applicant_identity_id: owner }).whereNull("deleted_at").first() ?? null;
  }
  async detail(id: string, owner?: string) {
    const query = this.db<ApplicationRow>(APPS).where({ id }).whereNull("deleted_at");
    if (owner !== undefined) query.where({ applicant_identity_id: owner });
    const application = await query.first();
    if (!application) throw missing();
    const documents = await this.db<DocumentRow>(DOCS).where({ application_id: id }).whereNull("deleted_at").orderBy("created_at", "asc");
    return { application, documents };
  }
  private async lock(trx: Knex.Transaction, id: string, owner: string) {
    const row = await trx<ApplicationRow>(APPS).where({ id, applicant_identity_id: owner }).whereNull("deleted_at").forUpdate().first();
    if (!row) throw missing();
    return row;
  }
  private assertEditable(row: ApplicationRow) { if (!editableApplication(row.status)) throw conflict("This application is read-only."); }
  async edit(id: string, owner: string, fields: Partial<ApplicationFields>) {
    await this.db.transaction(async (trx) => {
      this.assertEditable(await this.lock(trx, id, owner));
      if (Object.keys(fields).length) await trx(APPS).where({ id }).update({ ...fields, updated_at: new Date() });
    });
    return this.detail(id, owner);
  }
  async submit(id: string, owner: string) {
    await this.db.transaction(async (trx) => {
      const row = await this.lock(trx, id, owner);
      if (row.status === "SUBMITTED") return;
      this.assertEditable(row);
      // Pick editable fields; server-owned columns never enter input validation.
      const fields = Object.fromEntries(Object.keys(applicationFields.shape).map((key) => [key, row[key as keyof ApplicationFields]])) as ApplicationFields;
      validateSubmission(fields);
      if (await trx(DOCS).where({ application_id: id, removal_pending: true }).whereNull("deleted_at").first()) throw conflict("Finish removing pending documents before submitting.");
      if (row.status === "MORE_INFORMATION_REQUIRED") await this.appendReview(trx, row, "RESUBMITTED", "SUBMITTED", null, "");
      await trx(APPS).where({ id }).update({ status: "SUBMITTED", submitted_at: row.submitted_at ?? new Date(), last_submitted_at: new Date(), updated_at: new Date() });
    });
    return this.detail(id, owner);
  }
  async upload(id: string, owner: string, file: { content: string; bytes: Buffer; mime_type: string; document_type: string; display_name: string }, files: IFileModuleService) {
    let storageKey: string | undefined;
    try {
      await this.db.transaction(async (trx) => {
        this.assertEditable(await this.lock(trx, id, owner));
        const count = await trx(DOCS).where({ application_id: id }).whereNull("deleted_at").count<{ count: string }>("id as count").first();
        if (Number(count?.count) >= 20) throw conflict("An application can hold up to 20 documents.");
        const extension = file.mime_type === "application/pdf" ? ".pdf" : file.mime_type === "image/png" ? ".png" : ".jpg";
        const stored = await files.createFiles({ filename: randomUUID() + extension, mimeType: file.mime_type, content: file.content, access: "private" });
        storageKey = stored.id;
        await trx(DOCS).insert({ id: "madoc_" + randomUUID(), application_id: id, document_type: file.document_type,
          display_name: file.display_name, storage_key: storageKey, mime_type: file.mime_type, size_bytes: file.bytes.length });
      });
    } catch (error) {
      if (storageKey) {
        try { await files.deleteFiles(storageKey); }
        catch { throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Document save and storage cleanup failed. Contact support with the request ID."); }
      }
      throw error;
    }
    return this.detail(id, owner);
  }
  async removeDocument(id: string, documentId: string, owner: string, files: IFileModuleService) {
    // Persist a tombstone before external deletion. Failed deletions are retryable,
    // cannot be downloaded, and block submission until cleanup succeeds.
    const document = await this.db.transaction(async (trx) => {
      this.assertEditable(await this.lock(trx, id, owner));
      const row = await trx<DocumentRow>(DOCS).where({ id: documentId, application_id: id }).whereNull("deleted_at").first();
      if (!row) return null;
      await trx(DOCS).where({ id: documentId, application_id: id }).update({ removal_pending: true, updated_at: new Date() });
      return row;
    });
    if (document) {
      await files.deleteFiles(document.storage_key);
      await this.db.transaction(async (trx) => {
        this.assertEditable(await this.lock(trx, id, owner));
        await trx(DOCS).where({ id: documentId, application_id: id, removal_pending: true }).delete();
      });
    }
  }
  async document(id: string, documentId: string, owner?: string) {
    await this.detail(id, owner);
    const row = await this.db<DocumentRow>(DOCS).where({ id: documentId, application_id: id, removal_pending: false }).whereNull("deleted_at").first();
    if (!row) throw missing();
    return row;
  }
  async listSubmitted(input: { status?: string; q?: string; limit: number; offset: number }) {
    const query = this.db<ApplicationRow>(APPS).whereNull("deleted_at").whereNot("status", "DRAFT");
    if (input.status) query.where("status", input.status);
    if (input.q) query.where((builder) => { builder.whereILike("legal_name", "%" + input.q + "%").orWhereILike("trading_name", "%" + input.q + "%"); });
    const total = await query.clone().count<{ count: string }>("id as count").first();
    const applications = await query.select("*").orderBy("submitted_at", "desc").orderBy("id").limit(input.limit).offset(input.offset);
    return { applications, count: Number(total?.count ?? 0), limit: input.limit, offset: input.offset };
  }

  private async appendReview(trx: Knex.Transaction, row: ApplicationRow, action: string, to: string, user: string | null, reason: string) {
    await trx("merchant_application_review").insert({ id: "mrev_" + randomUUID(), application_id: row.id,
      action, from_status: row.status, to_status: to, platform_user_id: user, reason });
  }
  async reviewHistory(id: string, owner?: string) {
    await this.detail(id, owner);
    return this.db<ReviewRow>("merchant_application_review").where({ application_id: id }).orderBy("created_at", "asc").orderBy("id");
  }
  async review(id: string, user: string, action: Exclude<ReviewAction, "approve">, reason = "") {
    if (!user) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform user required.");
    if (action !== "start-review") reason = parse(reasonInput, { reason }).reason;
    await this.db.transaction(async (trx) => {
      const row = await trx<ApplicationRow>(APPS).where({ id }).whereNull("deleted_at").forUpdate().first();
      if (!row) throw missing();
      const to = reviewTransition(row.status, action);
      await this.appendReview(trx, row, { "start-review": "REVIEW_STARTED", "request-information": "INFORMATION_REQUESTED", reject: "REJECTED" }[action], to, user, reason);
      await trx(APPS).where({ id }).update({ status: to, updated_at: new Date() });
    });
  }
  // One workflow step owns one atomic custom-module transaction. No native
  // resources are needed in M3, so rollback leaves no external orphan resources.
  async provision(id: string, user: string, reason: string) {
    if (!user) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform user required.");
    reason = parse(approvalInput, { confirmed: true, reason }).reason;
    return this.db.transaction(async (trx) => {
      const row = await trx<ApplicationRow>(APPS).where({ id }).whereNull("deleted_at").forUpdate().first();
      if (!row) throw missing();
      if (row.status === "APPROVED") {
        const existing = await this.tenantQuery(row.applicant_identity_id, trx);
        if (!existing || existing.source_application_id !== id) throw conflict("Approved application has inconsistent provisioning. Contact support.");
        return this.tenantDTO(existing);
      }
      reviewTransition(row.status, "approve");
      validateSubmission(Object.fromEntries(Object.keys(applicationFields.shape).map((key) => [key, row[key as keyof ApplicationFields]])) as ApplicationFields);
      if (await trx(DOCS).where({ application_id: id, removal_pending: true }).whereNull("deleted_at").first()) throw conflict("Pending document cleanup blocks approval.");
      // Uniqueness also guards any unexpected partial state from earlier attempts.
      // Inconsistent partial records fail visibly instead of being overwritten.
      let merchant = await trx("merchant").where({ source_application_id: id }).first();
      if (!merchant) {
        [merchant] = await trx("merchant").insert({ id: "mer_" + randomUUID(), source_application_id: id,
          legal_name: row.legal_name, trading_name: row.trading_name }).returning("*");
      }
      if (!merchant || merchant.deleted_at || merchant.status !== "ACTIVE" || merchant.legal_name !== row.legal_name || merchant.trading_name !== row.trading_name) throw conflict("Inconsistent merchant provisioning. Contact support.");
      const address = { name: row.trading_name, address_line_1: row.address_line_1, address_line_2: row.address_line_2,
        city: row.city, province: row.province, postal_code: row.postal_code, country_code: row.country_code };
      const store = await trx("merchant_store").where({ merchant_id: merchant.id }).first();
      if (!store) await trx("merchant_store").insert({ id: "mstore_" + randomUUID(), merchant_id: merchant.id, ...address });
      else if (store.deleted_at || store.medusa_stock_location_id || Object.entries(address).some(([key, value]) => store[key] !== value)) throw conflict("Inconsistent store provisioning. Contact support.");
      const member = await trx("merchant_member").where({ merchant_id: merchant.id }).first();
      if (!member) await trx("merchant_member").insert({ id: "mmem_" + randomUUID(), merchant_id: merchant.id, auth_identity_id: row.applicant_identity_id });
      else if (member.deleted_at || member.status !== "ACTIVE" || member.member_type !== "OWNER" || member.auth_identity_id !== row.applicant_identity_id) throw conflict("Inconsistent owner provisioning. Contact support.");
      await this.appendReview(trx, row, "APPROVED", "APPROVED", user, reason);
      // This is deliberately last, in the same transaction as all provisioning.
      await trx(APPS).where({ id }).update({ status: "APPROVED", updated_at: new Date() });
      const tenant = await this.tenantQuery(row.applicant_identity_id, trx);
      if (!tenant || tenant.source_application_id !== id) throw conflict("Provisioning did not establish tenant context.");
      return this.tenantDTO(tenant);
    });
  }
  private tenantQuery(identity: string, db: Knex | Knex.Transaction = this.db) {
    return db("merchant_member as member")
      .join("merchant as merchant", "merchant.id", "member.merchant_id")
      .join("merchant_store as store", "store.merchant_id", "merchant.id")
      .join("merchant_application as application", "application.id", "merchant.source_application_id")
      .where({ "member.auth_identity_id": identity, "member.status": "ACTIVE", "merchant.status": "ACTIVE", "application.status": "APPROVED" })
      .whereRaw("application.applicant_identity_id = member.auth_identity_id")
      .whereNull("member.deleted_at").whereNull("merchant.deleted_at").whereNull("store.deleted_at").whereNull("application.deleted_at")
      .select("merchant.id as merchant_id", "merchant.source_application_id", "merchant.legal_name", "merchant.trading_name", "store.id as store_id", "store.name as store_name", "member.member_type").first();
  }
  private tenantDTO(row: { merchant_id: string; legal_name: string; trading_name: string; store_id: string; store_name: string; member_type: "OWNER" }) {
    return { merchant: { id: row.merchant_id, legal_name: row.legal_name, trading_name: row.trading_name },
      store: { id: row.store_id, name: row.store_name }, membership: { member_type: row.member_type } };
  }
  async resolveTenant(identity: string) {
    const tenant = identity ? await this.tenantQuery(identity) : null;
    if (!tenant) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Active merchant membership required.");
    return this.tenantDTO(tenant);
  }
}
