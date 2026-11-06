import type { ExecArgs } from "@medusajs/framework/types";
import verifyDispatchRescue from "./verify-dispatch-rescue";
export default async function verifyDispatchGeneration(args: ExecArgs) { await verifyDispatchRescue(args, true); }
