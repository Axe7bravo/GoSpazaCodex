import { StorefrontService } from "./storefront-service";
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { input } from "../modules/marketplace/location-policy";
import { DiscoveryService, discoveryInput, publicIdentifier } from "./discovery-service";

export const discoveryHandler = (kind: "discovery" | "stores" | "store" | "catalogue" | "product" | "search") =>
  async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    const actor = (req as AuthenticatedMedusaRequest).auth_context;
    if (actor?.actor_type !== "customer" || !actor.actor_id) {
      res.status(401).json({ message: "Sign in required." }); return;
    }
    try {
      const filters = input(discoveryInput, kind === "discovery" ? req.body : req.query);
      const service = new DiscoveryService(req.scope, actor.actor_id);
      const catalogue = new StorefrontService(req.scope, actor.actor_id);
      const result = kind === "store" ? await service.store(filters, publicIdentifier(req.params.storeId))
        : kind === "catalogue" ? await catalogue.catalogue(filters, publicIdentifier(req.params.storeId))
        : kind === "product" ? await catalogue.product(filters, publicIdentifier(req.params.productId))
        : kind === "search" ? await catalogue.search(filters)
        : await service.list(filters);
      res.json(result);
    } catch (error) {
      if (error instanceof MedusaError && [MedusaError.Types.INVALID_DATA, MedusaError.Types.NOT_FOUND].includes(error.type)) {
        res.status(error.type === MedusaError.Types.NOT_FOUND ? 404 : 400).json({
          message: error.type === MedusaError.Types.NOT_FOUND ? "Store, product or address unavailable at this location."
            : "Choose a valid location or an owned address with coordinates.",
        });
      } else {
        // Never send native module/database details or turn an outage into "no service".
        res.status(503).json({ message: "Storefront is unavailable. Please try again." });
      }
    }
  };
