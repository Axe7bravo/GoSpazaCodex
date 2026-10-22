import type { ExecArgs } from "@medusajs/framework/types";
import verifyDispatch from "./verify-dispatch";

export default async function verifyDispatchAcceptance(args: ExecArgs) {
  await verifyDispatch(args, true, true);
  console.log("M15-D passed: B/C regression, HYBRID boundary races, replay, hostile HTTP inputs and audit rollback.");
}
