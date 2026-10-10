import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PaymentReconciliationService } from "../lib/payment-reconciliation-service";

// Forward reconciliation only. No compensator can refund or dispatch completion.
const reconcile = createStep("gospaza-reconcile-yoco-operation", async (input: { operation_id: string }, { container }) => {
  await new PaymentReconciliationService(container).reconcile(input.operation_id);
  return new StepResponse({ operation_id: input.operation_id });
});
export const reconcileYocoPaymentWorkflow = createWorkflow("gospaza-reconcile-yoco-payment", (input: { operation_id: string }) =>
  new WorkflowResponse(reconcile(input)));
