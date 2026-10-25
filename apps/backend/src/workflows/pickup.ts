import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { PickupService } from "../lib/pickup-service";
interface Input { identity: string; delivery_id: string; expected_revision: number }
const pickup = createStep("gospaza-driver-pickup", async (input: Input, { container }) =>
  new StepResponse(await new PickupService(container).pickup(input.identity, input.delivery_id, { expected_revision: input.expected_revision })));
// No compensation or automatic retry of a physical handoff; the domain receipt owns replay.
export const pickupWorkflow = createWorkflow("gospaza-driver-pickup", (input: Input) => new WorkflowResponse(pickup(input)));
