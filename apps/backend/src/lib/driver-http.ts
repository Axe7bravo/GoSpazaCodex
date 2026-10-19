import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { DriverService } from "../modules/marketplace/driver-service";
import type { DriverPrincipal } from "../modules/marketplace/driver-service";
import { driverCommand, driverEmpty, driverParse } from "../modules/marketplace/driver-policy";
import type { DriverAction } from "../modules/marketplace/driver-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { applicantIdentity } from "./applicant-auth";
import { driverIdentity } from "./driver-auth";
import { updateDriverWorkflow } from "../workflows/update-driver";

const service = (req: MedusaRequest) => new DriverService(req.scope);
const id = (value: unknown) => driverParse(resourceId, value);
function prepare(req: MedusaRequest, res: MedusaResponse) { res.setHeader("Cache-Control", "private, no-store"); driverParse(driverEmpty, req.query); }
function user(req: MedusaRequest) {
  const c = (req as AuthenticatedMedusaRequest).auth_context;
  if (c?.actor_type !== "user" || !c.actor_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Platform authentication required.");
  return c.actor_id;
}
export async function me(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); const p = await service(req).profileForIdentity(driverIdentity(req));
  res.json({ actor: { type: "driver", id: p.id } });
}
export async function onboarding(req: MedusaRequest, res: MedusaResponse) { prepare(req, res); driverIdentity(req); res.json({ onboarding: true }); }
export async function bootstrap(req: MedusaRequest, res: MedusaResponse) {
  prepare(req, res); driverParse(driverEmpty, req.body ?? {}); res.json(await service(req).bootstrap(driverIdentity(req)));
}
export async function own(req: MedusaRequest, res: MedusaResponse) { prepare(req, res); res.json(await service(req).own(driverIdentity(req))); }
export async function history(req: MedusaRequest, res: MedusaResponse) { res.setHeader("Cache-Control", "private, no-store"); res.json(await service(req).history(driverIdentity(req), req.query)); }
export async function targets(req: MedusaRequest, res: MedusaResponse) { res.setHeader("Cache-Control", "private, no-store"); res.json(await service(req).targets(driverIdentity(req), req.query)); }
export async function merchantList(req: MedusaRequest, res: MedusaResponse) { res.setHeader("Cache-Control", "private, no-store"); res.json(await service(req).merchantRead(applicantIdentity(req), req.query)); }
export async function merchantDetail(req: MedusaRequest, res: MedusaResponse) { prepare(req, res); res.json(await service(req).merchantRead(applicantIdentity(req), {}, id(req.params.id))); }
export async function adminList(req: MedusaRequest, res: MedusaResponse) { res.setHeader("Cache-Control", "private, no-store"); res.json(await service(req).reviewList(user(req), req.query)); }
export async function adminDetail(req: MedusaRequest, res: MedusaResponse) { prepare(req, res); res.json(await service(req).reviewDetail(user(req), id(req.params.id))); }
export function mutation(scope: "driver" | "merchant" | "user", action: DriverAction, affiliation = false) {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    prepare(req, res);
    const principal: DriverPrincipal = scope === "driver" ? { type: scope, identity: driverIdentity(req) }
      : scope === "merchant" ? { type: scope, identity: applicantIdentity(req) } : { type: scope, id: user(req) };
    const profile_id = scope === "user" ? id(req.params.id) : undefined;
    const affiliation_id = scope === "merchant" ? id(req.params.id) : affiliation ? id(req.params.affiliationId) : undefined;
    const body = driverCommand(action, req.body);
    const { result } = await updateDriverWorkflow(req.scope).run({ input: { principal, action, body, profile_id, affiliation_id } });
    // Closed affiliations never grant a fresh private-profile read to a merchant.
    res.json(scope === "merchant" ? { receipt: result.receipt } : result);
  };
}
