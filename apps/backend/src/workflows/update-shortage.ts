import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PickingService } from "../lib/picking-service";

type Input =
  | { action: "ADMIT"; identity: string; order_id: string; line_id: string; body: unknown }
  | { action: "PREFERENCE" | "OMIT"; customer_id: string; order_id: string; case_id?: string; body: unknown };
// Each command commits operational evidence and its audit atomically. No native commerce mutation.
const update = createStep("gospaza-update-shortage", async (input: Input, { container }) => {
  const service = new PickingService(container);
  const result = input.action === "ADMIT"
    ? { shortage: await service.admitShortage(input.identity, input.order_id, input.line_id, input.body) }
    : await service.customerShortages(input.customer_id, input.order_id, input.action, input.body, input.case_id);
  return new StepResponse(result);
});
export const updateShortageWorkflow = createWorkflow("gospaza-shortage", (input: Input) => new WorkflowResponse(update(input)));
