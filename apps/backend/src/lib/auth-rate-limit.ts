import { createHash } from "node:crypto";
import Redis from "ioredis";
import { AUTH_METHODS } from "./auth-config";
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http";

// Fixed one-minute window, shared across backend instances. No credential storage.
// Socket address intentionally ignores untrusted X-Forwarded-For; trusted proxy
// deployments share a conservative bucket until their ingress policy is defined.
export async function authRateLimit(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const actor = req.originalUrl.split("?")[0]?.split("/")[2];
  if (!actor || !Object.hasOwn(AUTH_METHODS, actor)) {
    res.status(403).json({ message: "Unsupported actor type." });
    return;
  }
  const client = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000,
    maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const ipHash = createHash("sha256").update(req.socket.remoteAddress ?? "unknown").digest("hex");
    const key = "gospaza:auth-rate:" + ipHash;
    const count = Number(await client.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
      1, key,
    ));
    if (count > 30) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ message: "Too many authentication attempts. Try again shortly." });
      return;
    }
  } catch {
    res.status(503).json({ message: "Authentication is temporarily unavailable." });
    return;
  } finally { client.disconnect(); }
  next();
}

export function validateEmailPass(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  if (typeof body?.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
      body.email.length > 254 || typeof body.password !== "string" || !body.password || body.password.length > 256 ||
      (/\/register\/?$/i.test(req.originalUrl.split("?")[0] ?? "") && body.password.length < 12)) {
    res.status(400).json({ message: "A valid email and password are required. New passwords require at least 12 characters." });
    return;
  }
  next();
}

