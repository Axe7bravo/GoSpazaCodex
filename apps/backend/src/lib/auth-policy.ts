import { authenticate } from "@medusajs/framework/http";
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import type { ActorType } from "./auth-config";

// Native middleware validates actor_type AND a nonempty actor_id.
// API keys and actorless registration tokens do not grant access.
export const requireActor = (actor: ActorType) => authenticate(actor, ["session"]);

export function actorIdentity(actor: ActorType) {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    const context = (req as AuthenticatedMedusaRequest).auth_context;
    if (!context?.actor_id || context.actor_type !== actor) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ actor: { type: actor, id: context.actor_id } });
  };
}

