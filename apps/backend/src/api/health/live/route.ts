import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok" });
}
