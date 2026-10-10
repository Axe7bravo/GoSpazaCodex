import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PaymentInitiationService } from "../lib/payment-initiation-service";

const initiate = createStep("gospaza-initiate-checkout-payment", async (
  input: { customerId: string; body: unknown; recover: boolean }, { container },
) => {
  const result = await new PaymentInitiationService(container, input.customerId).initiate(input.body, input.recover);
  // No destructive compensation: an external checkout may already be payable.
  // The committed operation and exact key/payload own forward recovery.
  return new StepResponse(result);
});
export const initiateCheckoutPaymentWorkflow = createWorkflow(
  { name: "gospaza-initiate-checkout-payment", idempotent: false },
  (input: { customerId: string; body: unknown; recover: boolean }) => new WorkflowResponse(initiate(input)),
);
