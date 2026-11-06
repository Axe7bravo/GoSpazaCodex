import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { ZodError } from "@medusajs/framework/zod";
import { NotificationAccess, NotificationInbox } from "./notification-inbox";
export function notificationHandler(actor: "customer" | "merchant" | "driver" | "user", action: "list" | "detail" | "read" | "operations" | "health") {
  return async (req: MedusaRequest, res: MedusaResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const auth = (req as AuthenticatedMedusaRequest).auth_context;
      if (!auth || auth.actor_type !== actor) { res.status(401).json({ message: "Sign in required." }); return; }
      const principal = await new NotificationAccess(req.scope).resolve(auth, actor), inbox = new NotificationInbox(req.scope);
      if (["read", "detail", "health"].includes(action) && Object.keys(req.query).length
        || action === "read" && (req.body && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))) {
        res.status(400).json({ message: "Invalid notification request." }); return;
      }
      if (action === "list") res.json(await inbox.list(principal, req.query));
      else if (action === "operations") res.json(await inbox.operations(principal, req.query));
      else if (action === "health") res.json(await inbox.health(principal));
      else res.json(await inbox.detail(principal, String(req.params.id ?? ""), action === "read"));
    } catch (error) {
      const type = MedusaError.isMedusaError(error) ? error.type : null;
      res.status(error instanceof ZodError ? 400 : type === MedusaError.Types.FORBIDDEN ? 403 : type === MedusaError.Types.NOT_FOUND ? 404
        : type === MedusaError.Types.UNAUTHORIZED ? 401 : 503).json({ message: "Notification information unavailable." });
    }
  };
}
