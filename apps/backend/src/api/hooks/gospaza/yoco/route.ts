import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { PaymentReconciliationService } from "../../../../lib/payment-reconciliation-service";
import { YocoProviderError } from "../../../../modules/yoco/types";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const raw: unknown = req.rawBody;
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
    res.status(400).json({ code: "INVALID_WEBHOOK" });
    return;
  }
  try {
    await new PaymentReconciliationService(req.scope).receive({ rawData: raw, data: {}, headers: req.headers });
    res.status(200).json({ received: true });
  } catch (error) {
    if (error instanceof YocoProviderError) {
      res.status(400).json({ code: "INVALID_WEBHOOK" });
      return;
    }
    // Storage failure must not acknowledge an event that was not persisted.
    throw error;
  }
}
