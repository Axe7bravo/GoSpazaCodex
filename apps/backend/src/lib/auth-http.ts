import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { ConfigModule } from "@medusajs/framework/types";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";

function origins(req: MedusaRequest): string[] {
  const config = req.scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE);
  return [config.projectConfig.http.authCors, process.env.BACKEND_URL ?? ""]
    .flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

// Custom namespaces don't receive Medusa's /store, /admin or /auth CORS middleware.
export function actorCors(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const origin = req.get("origin");
  res.vary("Origin");
  if (origin && !origins(req).includes(origin)) {
    res.status(403).json({ message: "Origin not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  next();
}

// CORS alone doesn't reject state-changing requests. Permit CLI requests without
// Origin but reject untrusted browser origins (including opaque "null" origins).
export function authOrigin(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  res.setHeader("Cache-Control", "no-store");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
  const origin = req.get("origin");
  if ((origin && !origins(req).includes(origin)) ||
      (!origin && req.get("sec-fetch-site") === "cross-site")) {
    res.status(403).json({ message: "Origin not allowed" });
    return;
  }
  next();
}

export function publicRegistrationActors(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!["customer", "merchant"].includes(req.params.actor_type ?? "")) {
    res.status(403).json({ message: "Public registration is not available for this actor." });
    return;
  }
  next();
}

export async function rotateSession(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  // The native POST /auth/session handler assigns the authenticated context after this.
  await new Promise<void>((resolve, reject) => req.session.regenerate((error: unknown) => error ? reject(error) : resolve()));
  next();
}

