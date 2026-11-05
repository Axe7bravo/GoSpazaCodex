import type { ExecArgs } from "@medusajs/framework/types";
import { DriverCompensation } from "../lib/driver-compensation";

export default async function repairDriverCompensation({ container }: ExecArgs) {
  const actor = process.env.M21_COMPENSATION_USER_ID;
  if (!actor) throw new Error("M21_COMPENSATION_USER_ID and the explicit compensation management grant are required.");
  console.log(await new DriverCompensation(container).repair(actor, {
    ...(process.env.M21_COMPENSATION_AFTER ? { after: process.env.M21_COMPENSATION_AFTER } : {}), limit: 25,
  }));
}
