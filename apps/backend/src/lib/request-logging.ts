import { randomUUID } from "node:crypto";
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export function requestLogging(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  // Never trust a browser-supplied ID as the authoritative correlation identifier.
  const requestId = randomUUID();
  const started = performance.now();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.once("finish", () => {
    // An allowlist prevents credentials, query strings, bodies and raw errors leaking.
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : "info",
      event: "http.request.completed",
      requestId,
      method: req.method,
      statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - started),
    }) + "\n");
  });
  next();
}
