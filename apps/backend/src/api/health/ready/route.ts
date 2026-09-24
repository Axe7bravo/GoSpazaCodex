import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { readiness } from "../../../lib/health";
import { postgresProbe, redisProbe } from "../../../lib/probes";

// Coalesce concurrent monitoring requests and briefly cache the result.
let pending: ReturnType<typeof readiness> | undefined;
let expiresAt = 0;
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  if (!pending || Date.now() >= expiresAt) {
    expiresAt = Number.POSITIVE_INFINITY;
    pending = readiness(postgresProbe, redisProbe).finally(() => {
      expiresAt = Date.now() + 1000;
    });
  }
  const result = await pending;
  res.setHeader("Cache-Control", "no-store");
  res.status(result.statusCode).json(result.body);
}
