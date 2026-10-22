import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { DispatchService } from "../lib/dispatch-service";
import { dispatchMissing } from "../modules/marketplace/dispatch-policy";
interface Input {
  actor: { type: "driver" | "user"; id: string };
  action: "ONLINE" | "OFFLINE" | "ACCEPT" | "DECLINE" | "CONFIGURE";
  id?: string; body: unknown;
}
// Decision and audit effects share one PostgreSQL transaction. Redis generation
// setup can fail closed; it never releases a commitment. No compensating deletion
// of an assignment after a lost response; exact decision replay uses its receipt.
const command = createStep("gospaza-dispatch-command", async (input: Input, { container }): Promise<StepResponse<unknown>> => {
  const s = new DispatchService(container);
  if (input.action === "CONFIGURE") {
    if (input.actor.type !== "user" || !input.id) return dispatchMissing();
    return new StepResponse(await s.configure(input.actor.id, input.id, input.body));
  }
  if (input.actor.type !== "driver") return dispatchMissing();
  if (input.action === "ONLINE" || input.action === "OFFLINE") return new StepResponse(await s.intent(input.actor.id, input.action === "ONLINE", input.body));
  if (!input.id) return dispatchMissing();
  return new StepResponse(await s.decide(input.actor.id, input.id, input.action, input.body));
});
export const dispatchCommandWorkflow = createWorkflow("gospaza-dispatch-command", (input: Input) => new WorkflowResponse(command(input)));
