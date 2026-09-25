import { randomUUID } from "node:crypto";
import { MedusaService, MedusaError } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IFileModuleService } from "@medusajs/framework/types";
import Application from "./models/application";
import Document from "./models/document";
import { applicationFields, validateSubmission } from "./validation";
import type { ApplicationFields } from "./validation";

export interface ApplicationRow extends ApplicationFields {
  id: string; applicant_identity_id: string; status: string; submitted_at: Date | null;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
}
export interface DocumentRow {
  id: string; application_id: string; document_type: string; display_name: string;
  storage_key: string; mime_type: string; size_bytes: number; removal_pending: boolean;
  created_at: Date; deleted_at: Date | null;
}
const APPS = "merchant_application";
const DOCS = "merchant_application_document";
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Application or document not found.");
const conflict = (message: string) => new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
export default class MarketplaceService extends MedusaService({ Application, Document }) {
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
  private draft(row: ApplicationRow) { if (row.status !== "DRAFT") throw conflict("This application is read-only."); }
  async edit(id: string, owner: string, fields: Partial<ApplicationFields>) {
    await this.db.transaction(async (trx) => {
      this.draft(await this.lock(trx, id, owner));
      if (Object.keys(fields).length) await trx(APPS).where({ id }).update({ ...fields, updated_at: new Date() });
    });
    return this.detail(id, owner);
  }
  async submit(id: string, owner: string) {
    await this.db.transaction(async (trx) => {
      const row = await this.lock(trx, id, owner);
      if (row.status === "SUBMITTED") return;
      this.draft(row);
      // Pick editable fields; server-owned columns never enter input validation.
      const fields = Object.fromEntries(Object.keys(applicationFields.shape).map((key) => [key, row[key as keyof ApplicationFields]])) as ApplicationFields;
      validateSubmission(fields);
      if (await trx(DOCS).where({ application_id: id, removal_pending: true }).whereNull("deleted_at").first()) throw conflict("Finish removing pending documents before submitting.");
      await trx(APPS).where({ id }).update({ status: "SUBMITTED", submitted_at: new Date(), updated_at: new Date() });
    });
    return this.detail(id, owner);
  }
  async upload(id: string, owner: string, file: { content: string; bytes: Buffer; mime_type: string; document_type: string; display_name: string }, files: IFileModuleService) {
    let storageKey: string | undefined;
    try {
      await this.db.transaction(async (trx) => {
        this.draft(await this.lock(trx, id, owner));
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
      this.draft(await this.lock(trx, id, owner));
      const row = await trx<DocumentRow>(DOCS).where({ id: documentId, application_id: id }).whereNull("deleted_at").first();
      if (!row) return null;
      await trx(DOCS).where({ id: documentId, application_id: id }).update({ removal_pending: true, updated_at: new Date() });
      return row;
    });
    if (document) {
      await files.deleteFiles(document.storage_key);
      await this.db.transaction(async (trx) => {
        this.draft(await this.lock(trx, id, owner));
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
}
