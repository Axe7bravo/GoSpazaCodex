import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { RestrictedCommerce } from "./restricted-commerce";
import { applicantIdentity } from "./applicant-auth";

type Action = "registration" | "submit" | "upload" | "evidence" | "classification" | "propose" | "review" | "review-classification" | "purchaser";
export const restrictedHandler = (action: Action, admin = false) => async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control","private, no-store");
  if (Object.keys(req.query).length) { res.status(400).json({ message: "Unexpected query fields." }); return; }
  const context = (req as AuthenticatedMedusaRequest).auth_context;
  const actor = admin || action === "purchaser" ? context?.actor_id : applicantIdentity(req);
  if (!actor || (admin && context?.actor_type !== "user") || (action === "purchaser" && context?.actor_type !== "customer")) {
    res.status(401).json({ message: "Sign in required." }); return;
  }
  const service = new RestrictedCommerce(req.scope);
  const store = admin ? req.params.id : undefined;
  try {
    if (action === "evidence") {
      const file = await service.evidence(actor,req.params.documentId!,store);
      res.setHeader("Content-Type",file.mime_type); res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Content-Security-Policy","sandbox"); res.setHeader("Content-Disposition","attachment; filename=registration-evidence");
      res.send(file.bytes); return;
    }
    const result = action === "registration" ? (store ? await service.adminRegistration(actor,store) : await service.registration(actor))
      : action === "submit" ? await service.submit(actor,req.body)
      : action === "upload" ? await service.upload(actor,req.body)
      : action === "classification" ? await service.classification(actor,req.params.productId!,store)
      : action === "propose" ? await service.propose(actor,req.params.productId!,req.body)
      : action === "review" ? await service.reviewRegistration(actor,store!,req.body)
      : action === "review-classification" ? await service.reviewClassification(actor,store!,req.params.productId!,req.body)
      : await service.customerStatus(actor);
    res.json(result);
  } catch (error) {
    if (error instanceof MedusaError) {
      const status = error.type === MedusaError.Types.NOT_FOUND ? 404 : error.type === MedusaError.Types.FORBIDDEN ? 403
        : error.type === MedusaError.Types.UNAUTHORIZED ? 401 : error.type === MedusaError.Types.CONFLICT ? 409 : error.type === MedusaError.Types.INVALID_DATA ? 400 : 503;
      res.status(status).json({ message: status === 409 ? "Refresh compliance status before continuing." : "Compliance request unavailable." }); return;
    }
    res.status(503).json({ message: "Compliance request could not be confirmed. Refresh before continuing." });
  }
};
