import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PickingService } from "../lib/picking-service";
import type { PickingAction } from "../modules/marketplace/picking-policy";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

interface Input { identity: string; order_id: string; action: PickingAction; body: unknown; line_id?: string }
// One atomic Marketplace transaction; never compensate by undoing physical evidence.
const update = createStep("gospaza-update-picking", async (input: Input, { container }) => {
  const result = await new PickingService(container).mutate(input.identity, input.order_id, input.action, input.body, input.line_id);
  if (input.action === "COMPLETE" && process.env.DISPATCH_WORKER_ENABLED === "true") {
    try {
      await container.resolve<{ emit(event: { name: string; data: { id: string } }): Promise<unknown> }>(Modules.EVENT_BUS)
        .emit({ name: "gospaza.picking.completed", data: { id: input.order_id } });
    } catch {
      container.resolve<{ warn(message: string): void }>(ContainerRegistrationKeys.LOGGER)
        .warn("Dispatch wake-up deferred; completed picking remains available to bounded repair.");
    }
  }
  return new StepResponse(result);
});
export const updatePickingWorkflow = createWorkflow("gospaza-picking", (input: Input) => new WorkflowResponse(update(input)));
