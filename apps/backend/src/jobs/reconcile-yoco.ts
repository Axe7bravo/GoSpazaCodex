import type { MedusaContainer, Logger } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { PaymentReconciliationService } from "../lib/payment-reconciliation-service";
import { reconcileYocoPaymentWorkflow } from "../workflows/reconcile-yoco-payment";
import { yocoConfiguration, reconciliationWorkerEnabled } from "../lib/yoco-config";

export default async function reconcileYoco(container: MedusaContainer) {
  if (!yocoConfiguration(process.env) || !reconciliationWorkerEnabled(process.env)) return;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const service = new PaymentReconciliationService(container);
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const inbox = await db<{ id: string }>("yoco_inbox").where({ state: "RECEIVED" }).orderBy("created_at").limit(100);
  for (const message of inbox) {
    try { await service.applyInbox(message.id); }
    catch { logger.error("Yoco inbox processing deferred: " + message.id); }
  }
  const operations = await db<{ id: string }>("provider_operation").where({ reconciliation_pending: true })
    .orderBy("updated_at").limit(100);
  for (const operation of operations) {
    try { await reconcileYocoPaymentWorkflow(container).run({ input: { operation_id: operation.id } }); }
    catch { logger.error("Yoco reconciliation requires inspection: " + operation.id); }
    finally { await db("provider_operation").where({ id: operation.id }).update({ updated_at: db.fn.now() }); }
  }
}
export const config = { name: "gospaza-reconcile-yoco", schedule: "*/1 * * * *" };
