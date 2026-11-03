import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { FinancialService } from "../lib/financial-service";
interface Input { user:string; id:string; action:"approve"|"goodwill"; body:unknown }
// One atomic entitlement transaction, no money movement or compensating reversal.
const decide=createStep("gospaza-financial-adjustment-decision",async(input:Input,{container})=>{
  const service=new FinancialService(container);
  return new StepResponse(input.action==="approve" ? await service.approve(input.user,input.id,input.body)
    :await service.goodwill(input.user,input.id,input.body));
});
export const financialAdjustmentWorkflow=createWorkflow("gospaza-financial-adjustment",(input:Input)=>new WorkflowResponse(decide(input)));
