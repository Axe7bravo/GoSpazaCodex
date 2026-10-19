import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { DriverService } from "../modules/marketplace/driver-service";
import type { DriverPrincipal } from "../modules/marketplace/driver-service";
import type { DriverAction } from "../modules/marketplace/driver-policy";
interface Input { principal: DriverPrincipal; action: DriverAction; body: unknown; profile_id?: string; affiliation_id?: string }
// All custom state and audit commit in one transaction. No native Auth mutation
// and no compensation that could undo an independently committed later decision.
const update = createStep("gospaza-update-driver", async (input: Input, { container }) =>
  new StepResponse(await new DriverService(container).mutate(input.principal, input.action, input.body, input.profile_id, input.affiliation_id)));
export const updateDriverWorkflow = createWorkflow("gospaza-driver", (input: Input) => new WorkflowResponse(update(input)));
