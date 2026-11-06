import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { DispatchService } from "../lib/dispatch-service";
import type { DeliveryRescueCommand } from "@gospaza/contracts";
interface Input { actor: string; delivery: string; body: DeliveryRescueCommand }
// One owner transaction contains the command receipt, generation, audit and work.
// No compensation erases committed dispatch history after an uncertain response.
const rescue = createStep("gospaza-rescue-delivery", async (input: Input, { container }) =>
  new StepResponse(await new DispatchService(container).rescue(input.actor, input.delivery, input.body)));
export const rescueDeliveryWorkflow = createWorkflow("gospaza-rescue-delivery", (input: Input) => new WorkflowResponse(rescue(input)));
