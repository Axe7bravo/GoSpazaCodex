import { createStep, StepResponse, createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import type MarketplaceService from "../modules/marketplace/service";
type Input = { applicationId: string; platformUserId: string; reason: string };
const provisionMerchant = createStep("gospaza-provision-merchant-atomically", async (input: Input, { container }) => {
  const context = await container.resolve<MarketplaceService>("marketplace").provision(input.applicationId, input.platformUserId, input.reason);
  return new StepResponse(context);
});
// A single transaction is the complete business mutation: there are no external
// side effects to compensate. Replays reconcile by the unique source application.
export const approveMerchantWorkflow = createWorkflow("gospaza-approve-merchant", (input: Input) => new WorkflowResponse(provisionMerchant(input)));
