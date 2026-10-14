import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PickingService } from "../lib/picking-service";
import type { PickingAction } from "../modules/marketplace/picking-policy";

interface Input { identity: string; order_id: string; action: PickingAction; body: unknown; line_id?: string }
// One atomic Marketplace transaction; never compensate by undoing physical evidence.
const update = createStep("gospaza-update-picking", async (input: Input, { container }) =>
  new StepResponse(await new PickingService(container).mutate(input.identity, input.order_id, input.action, input.body, input.line_id)));
export const updatePickingWorkflow = createWorkflow("gospaza-picking", (input: Input) => new WorkflowResponse(update(input)));
