import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { CatalogueService } from "./catalogue-service";
import { applicantIdentity } from "./applicant-auth";
import { teamParse, resourceId, emptyInput } from "../modules/marketplace/team-policy";
const service = (req: MedusaRequest) => new CatalogueService(req.scope, applicantIdentity(req));
function prepare(req: MedusaRequest, res: MedusaResponse, list = false) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!list) teamParse(emptyInput, req.query);
}
export async function list(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res, true); res.json(await service(req).list(req.query));
}
export async function create(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.status(201).json({ product: await service(req).create(req.body) });
}
export async function detail(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json({ product: await service(req).detail(teamParse(resourceId, req.params.id)) });
}
export async function update(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json({ product: await service(req).update(teamParse(resourceId, req.params.id), req.body) });
}
export async function upload(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.status(201).json({ product: await service(req).upload(teamParse(resourceId, req.params.id), req.body) });
}
export async function removeImage(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); teamParse(emptyInput, req.body ?? {});
  res.json({ product: await service(req).removeImage(teamParse(resourceId, req.params.id), teamParse(resourceId, req.params.imageId)) });
}
export async function inventory(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res, true); res.json(await service(req).inventory(req.query));
}
export async function stock(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); res.json({ product: await service(req).stock(teamParse(resourceId, req.params.id), req.body) });
}
