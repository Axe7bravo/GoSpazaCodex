import type { ExecArgs } from "@medusajs/framework/types";
import { DriverEarnings } from "../lib/driver-earning";

// Internal server command; no actor-facing recognition/repair mutation API.
export default async function repairDriverEarnings({ container }: ExecArgs) {
  console.log(await new DriverEarnings(container).repair({
    ...(process.env.M21_EARNINGS_AFTER ? { after: process.env.M21_EARNINGS_AFTER } : {}),
    ...(process.env.M21_EARNINGS_THROUGH ? { through: process.env.M21_EARNINGS_THROUGH } : {}), limit: 25,
  }));
}
