import { authenticate } from "@medusajs/framework/http";
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { DriverService } from "../modules/marketplace/driver-service";

export function driverIdentity(req: MedusaRequest): string {
  const context = (req as AuthenticatedMedusaRequest).auth_context;
  if (context?.actor_type !== "driver" || !context.auth_identity_id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required.");
  return context.auth_identity_id;
}
// Metadata-free sessions have no actor_id. The domain gate below is mandatory;
// allowUnregistered only authenticates the native identity, never a profile grant.
const nativeDriver = authenticate("driver", ["session"], { allowUnregistered: true });
export function driverBoundary(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  return nativeDriver(req, res, (error?: unknown) => {
    if (error) { next(error); return; }
    void (async () => {
      const identity = driverIdentity(req);
      const path = req.originalUrl.split("?")[0];
      const onboarding = (req.method === "POST" && path === "/driver/profile/bootstrap")
        || (req.method === "GET" && path === "/driver/onboarding/me");
      const service = new DriverService(req.scope);
      if (onboarding) {
        if (!await service.nativeIdentityValid(identity)) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Driver authentication required.");
      } else await service.profileForIdentity(identity);
      next();
    })().catch(next);
  });
}
export function strictDriverRegistration(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (req.params.actor_type === "driver" && (!req.body || typeof req.body !== "object"
    || Object.keys(req.body).some(key => key !== "email" && key !== "password"))) {
    res.status(400).json({ message: "Only email and password are accepted." }); return;
  }
  next();
}
