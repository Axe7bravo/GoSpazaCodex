import { Modules, MedusaError } from "@medusajs/framework/utils";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { IFileModuleService } from "@medusajs/framework/types";
import MarketplaceService from "../modules/marketplace/service";
import type { ApplicationRow, DocumentRow } from "../modules/marketplace/service";
import { applicationFields, parse, patchSchema, listSchema, validateDocument } from "../modules/marketplace/validation";
import { applicantIdentity } from "./applicant-auth";
export function appDTO(row: ApplicationRow) {
  const fields = Object.fromEntries(Object.keys(applicationFields.shape).map((key) => [key, row[key as keyof ApplicationRow]]));
  return { id: row.id, ...fields, status: row.status, submitted_at: row.submitted_at, created_at: row.created_at, updated_at: row.updated_at };
}
export function documentDTO(row: DocumentRow) {
  return { id: row.id, document_type: row.document_type, display_name: row.display_name, mime_type: row.mime_type,
    size_bytes: row.size_bytes, removal_pending: row.removal_pending, created_at: row.created_at };
}
const service = (req: MedusaRequest) => req.scope.resolve<MarketplaceService>("marketplace");
const files = (req: MedusaRequest) => req.scope.resolve<IFileModuleService>(Modules.FILE);
function id(req: MedusaRequest, name = "id") {
  const value = req.params[name];
  if (typeof value !== "string" || !/^(?:mapp|madoc)_[a-zA-Z0-9-]{1,80}$/.test(value)) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Application or document not found.");
  return value;
}
function respond(res: MedusaResponse, detail: { application: ApplicationRow; documents: DocumentRow[] }) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ application: appDTO(detail.application), documents: detail.documents.map(documentDTO) });
}
export async function create(req: MedusaRequest, res: MedusaResponse) {
  const fields = parse(patchSchema, req.body ?? {});
  // POST creates a blank draft only; edits use the explicit draft endpoint.
  if (Object.keys(fields).length) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Create a draft before editing fields.");
  const row = await service(req).createDraft(applicantIdentity(req));
  if (!row) throw new Error("Draft creation failed");
  respond(res, await service(req).detail(row.id, applicantIdentity(req)));
}
export async function own(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  const row = await service(req).own(applicantIdentity(req));
  if (!row) { res.json({ application: null, documents: [] }); return; }
  respond(res, await service(req).detail(row.id, applicantIdentity(req)));
}
export async function edit(req: MedusaRequest, res: MedusaResponse) { respond(res, await service(req).edit(id(req), applicantIdentity(req), parse(patchSchema, req.body))); }
export async function submit(req: MedusaRequest, res: MedusaResponse) {
  if (req.body && Object.keys(req.body).length) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Submission does not accept fields.");
  respond(res, await service(req).submit(id(req), applicantIdentity(req)));
}
export async function upload(req: MedusaRequest, res: MedusaResponse) {
  respond(res, await service(req).upload(id(req), applicantIdentity(req), validateDocument(req.body), files(req)));
}
export async function remove(req: MedusaRequest, res: MedusaResponse) {
  await service(req).removeDocument(id(req), id(req, "documentId"), applicantIdentity(req), files(req));
  res.json({ success: true });
}
export async function adminList(req: MedusaRequest, res: MedusaResponse) {
  const result = await service(req).listSubmitted(parse(listSchema, req.query));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...result, applications: result.applications.map(appDTO) });
}
export async function adminDetail(req: MedusaRequest, res: MedusaResponse) {
  const result = await service(req).detail(id(req));
  if (result.application.status === "DRAFT") throw new MedusaError(MedusaError.Types.NOT_FOUND, "Application not found.");
  respond(res, result);
}
export const access = (admin = false) => async (req: MedusaRequest, res: MedusaResponse) => {
  const applicationId = id(req);
  if (admin && (await service(req).detail(applicationId)).application.status === "DRAFT") throw new MedusaError(MedusaError.Types.NOT_FOUND, "Application not found.");
  const document = await service(req).document(applicationId, id(req, "documentId"), admin ? undefined : applicantIdentity(req));
  // Native provider supplies bytes, never a public URL. 10 MB maximum keeps memory bounded.
  const bytes = await files(req).getAsBuffer(document.storage_key);
  res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox"); res.setHeader("Content-Type", document.mime_type);
  res.setHeader("Content-Disposition", "attachment; filename=application-document" + (document.mime_type === "application/pdf" ? ".pdf" : document.mime_type === "image/png" ? ".png" : ".jpg"));
  res.send(bytes);
};
