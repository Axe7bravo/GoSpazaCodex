import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { OrderOperationsService } from "../lib/order-operations-service";
import type { OrderDecisionAction } from "../modules/marketplace/order-operation-policy";

interface Input { identity: string; order_id: string; action: OrderDecisionAction; body: unknown }
// The sole step owns one atomic Marketplace transaction. No compensation may
// reverse a committed decision; response loss is handled by domain replay.
const decide = createStep("gospaza-decide-merchant-order", async (input: Input, { container }) =>
  new StepResponse(await new OrderOperationsService(container).decide(input.identity, input.order_id, input.action, input.body)));
export const decideMerchantOrderWorkflow = createWorkflow("gospaza-merchant-order-decision", (input: Input) =>
  new WorkflowResponse(decide(input)));
