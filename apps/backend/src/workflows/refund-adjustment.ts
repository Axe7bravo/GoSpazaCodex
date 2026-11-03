import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { RefundService } from "../lib/refund-service";
interface Input { user: string; adjustment: string; body: unknown }
// Durable domain operations own recovery. Workflow compensation must never
// reverse a refund or release a reserved entitlement after an uncertain send.
const execute = createStep("gospaza-refund-adjustment-command", async (input: Input, { container }) =>
  new StepResponse(await new RefundService(container).command(input.user, input.adjustment, input.body)));
export const refundAdjustmentWorkflow = createWorkflow("gospaza-refund-adjustment", (input: Input) => new WorkflowResponse(execute(input)));
