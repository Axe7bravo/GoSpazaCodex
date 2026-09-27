import { ensureCommerce } from "../lib/commerce";
import { createStep, StepResponse, createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import type MarketplaceService from "../modules/marketplace/service";
type Input = { applicationId: string; platformUserId: string; reason: string };
const provisionMerchant = createStep("gospaza-provision-merchant-atomically", async (input: Input, { container }) => {
  const context = await container.resolve<MarketplaceService>("marketplace").provision(input.applicationId, input.platformUserId, input.reason);
  return new StepResponse(context);
});
const commerce = createStep("gospaza-approve-commerce", async (context: Awaited<ReturnType<MarketplaceService["provision"]>>, { container }) => {
  await ensureCommerce(container, context.merchant.id);
  return new StepResponse(context);
});
// Existing M3 approval remains atomic. A failed native setup can be retried safely.
export const approveMerchantWorkflow = createWorkflow("gospaza-approve-merchant", (input: Input) => new WorkflowResponse(commerce(provisionMerchant(input))));
