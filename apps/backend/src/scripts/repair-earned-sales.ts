import type { ExecArgs } from "@medusajs/framework/types";
import { MarketplaceRecognition } from "../lib/marketplace-recognition";

export default async function repairEarnedSales({container}:ExecArgs) {
  const result=await new MarketplaceRecognition(container).repair(process.env.M19_RECOGNITION_AFTER,process.env.M19_RECOGNITION_THROUGH);
  console.log("M19 earned-sale repair:",JSON.stringify(result));
  if(result.deferred.length) throw new Error("Deferred snapshots require a subsequent repair sweep.");
}
