import { MedusaError, Modules } from "@medusajs/framework/utils";
import type { IAuthModuleService } from "@medusajs/framework/types";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type MarketplaceService from "../modules/marketplace/service";
import { emptyInput, resourceId, teamParse } from "../modules/marketplace/team-policy";
import { applicantIdentity } from "./applicant-auth";

const team = (req: MedusaRequest) => req.scope.resolve<MarketplaceService>("marketplace").teamService;
export async function emailPassEmail(auth: IAuthModuleService, identityId: string): Promise<string> {
  const identity = await auth.retrieveAuthIdentity(identityId, { relations: ["provider_identities"] });
  const email = identity.provider_identities?.find((provider) => provider.provider === "emailpass")?.entity_id;
  if (!email) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Merchant EmailPass identity required.");
  return email;
}
function prepareResponse(req: MedusaRequest, res: MedusaResponse) {
  teamParse(emptyInput, req.query);
  res.setHeader("Cache-Control", "private, no-store");
}
export async function listMembers(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  res.json(await team(req).listMembers(applicantIdentity(req)));
}
export async function listInvitations(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  res.json(await team(req).listInvitations(applicantIdentity(req)));
}
export async function invite(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  res.status(201).json(await team(req).invite(applicantIdentity(req), req.body, (id) => emailPassEmail(auth, id)));
}
export async function revoke(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  teamParse(emptyInput, req.body ?? {});
  res.json(await team(req).revoke(applicantIdentity(req), teamParse(resourceId, req.params.id)));
}
export async function changeMember(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  res.json(await team(req).changeMember(applicantIdentity(req), teamParse(resourceId, req.params.id), req.body));
}
export async function accept(req: MedusaRequest, res: MedusaResponse) {
  prepareResponse(req, res);
  const identity = applicantIdentity(req);
  const email = await emailPassEmail(req.scope.resolve<IAuthModuleService>(Modules.AUTH), identity);
  res.json(await team(req).accept(identity, email, req.body));
}
